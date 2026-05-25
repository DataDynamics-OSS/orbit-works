"use client";

/**
 * 마케팅 이메일 템플릿 — 상세/편집 페이지.
 *
 * 목록 페이지 다이얼로그는 이름·설명만 받고 POST 한 뒤 이 페이지로 이동.
 * 여기서 본문 입력 방식 3가지를 처리한다:
 * - HTML   : textarea 직접 입력.
 * - EDITOR : 회의록(BlockNote) 에디터.
 * - IMPORT : 외부 URL fetch → sanitize → premailer 인라인.
 *
 * 페이지 이동이라 외부 클릭으로 작업이 사라지지 않는다.
 */

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Code2,
  Download,
  Globe,
  Save,
  Send,
  Trash2,
  Wand2,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";

// BlockNote 는 브라우저 전용이라 ssr:false.
const MeetingNoteEditor = dynamic(
  () =>
    import("@/components/meeting-notes/MeetingNoteEditor").then(
      (m) => m.MeetingNoteEditor ?? (m as any).default,
    ),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground p-4">에디터 로딩…</div> },
);

type BodyKind = "HTML" | "EDITOR" | "IMPORT";

type Template = {
  id: string;
  name: string;
  subject: string;
  body_kind: BodyKind;
  body_html: string;
  body_json: any | null;
  body_text: string;
  description: string | null;
  last_used_at: string | null;
  updated_at: string;
};

const MERGE_FIELDS = [
  { key: "{{customer_name}}", label: "고객사 이름" },
  { key: "{{contact_name}}", label: "수신자 이름" },
  { key: "{{contact_email}}", label: "수신자 이메일" },
  { key: "{{contact_title}}", label: "수신자 직함" },
  { key: "{{customer_representative}}", label: "고객사 대표" },
];

export default function EmailTemplateEditPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = String(params.id);

  const { data: template } = useQuery<Template>({
    queryKey: ["marketing", "email-template", id],
    queryFn: async () => (await api.get(`/marketing/email-templates/${id}`)).data,
  });

  if (!template) {
    return (
      <>
        <DashboardHeader title="이메일 템플릿" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="이메일 템플릿"
        actions={
          <button
            type="button"
            onClick={() => router.push("/marketing/emails")}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 목록
          </button>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-y-auto">
        <EditCard
          template={template}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "email-template", id] });
            qc.invalidateQueries({ queryKey: ["marketing", "email-templates"] });
          }}
          onDeleted={() => router.push("/marketing/emails")}
        />
      </div>
    </>
  );
}

function EditCard({
  template,
  onSaved,
  onDeleted,
}: {
  template: Template;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [description, setDescription] = useState(template.description || "");
  const [bodyKind, setBodyKind] = useState<BodyKind>(template.body_kind ?? "HTML");
  const [bodyHtml, setBodyHtml] = useState(template.body_html);
  const [bodyJson, setBodyJson] = useState<any>(template.body_json ?? null);
  const [bodyText, setBodyText] = useState(template.body_text);

  const editorHtmlRef = useRef<(() => Promise<string>) | null>(null);
  // BlockNote autosave 가 5초 디바운스라 사용자가 입력 직후 저장 버튼을 누르면
  // setState 가 아직 안 일어났을 수 있음. saveRef 로 즉시 flush + 결과를
  // jsonRef 에 동기적으로 받아 mutation 에 넘긴다 (state 비동기 회피).
  const editorSaveRef = useRef<(() => Promise<void>) | null>(null);
  const editorJsonRef = useRef<any>(template.body_json ?? null);
  const editorPlainRef = useRef<string>(template.body_text || "");

  const [importUrl, setImportUrl] = useState("");
  const importMutation = useMutation({
    mutationFn: async (): Promise<{ body_html: string; title: string | null }> =>
      (await api.post("/marketing/email-templates/import-url", { url: importUrl })).data,
    onSuccess: (data) => {
      setBodyHtml(data.body_html);
      setBodyKind("HTML");
    },
    onError: (e: any) =>
      alert(e?.response?.data?.detail ?? "URL 가져오기 실패"),
  });

  const save = useMutation({
    mutationFn: async () => {
      let finalHtml = bodyHtml;
      let finalJson: any = null;
      if (bodyKind === "EDITOR") {
        // 1) autosave 디바운스 우회 — 즉시 flush 해서 jsonRef 최신화.
        if (editorSaveRef.current) {
          try {
            await editorSaveRef.current();
          } catch {
            /* fall back to last known state */
          }
        }
        // 2) BlockNote → HTML export.
        if (editorHtmlRef.current) {
          try {
            finalHtml = await editorHtmlRef.current();
          } catch {
            /* fall back to last known html */
          }
        }
        // 3) round-trip 용 raw blocks — ref(동기) 가 우선, fallback 으로 state.
        finalJson = editorJsonRef.current ?? bodyJson;
      }
      const payload = {
        name,
        subject,
        body_kind: bodyKind,
        body_html: finalHtml,
        body_json: finalJson,
        body_text: bodyText || editorPlainRef.current || "",
        description: description || null,
      };
      return (
        await api.patch(`/marketing/email-templates/${template.id}`, payload)
      ).data as Template;
    },
    onSuccess: (updated) => {
      // 두 탭이 같은 body_html 컬럼을 공유 — EDITOR 저장 시 backend 가 CSS 를
      // inline 처리해 응답으로 돌려준 값으로 HTML 탭 state 도 즉시 동기화.
      // 안 그러면 HTML 탭에 옛 값이 남아 사용자가 "다른 내용" 으로 인식.
      setBodyHtml(updated.body_html ?? "");
      if (updated.body_json !== undefined) {
        setBodyJson(updated.body_json);
        editorJsonRef.current = updated.body_json;
      }
      setBodyText(updated.body_text ?? "");
      onSaved();
    },
    onError: (e: any) => alert(e?.response?.data?.detail ?? "저장 실패"),
  });

  const del = useMutation({
    mutationFn: async () => api.delete(`/marketing/email-templates/${template.id}`),
    onSuccess: onDeleted,
  });

  // 테스트 발송 — 캠페인 흐름 우회. 로그인 사용자 이메일 default.
  const { data: me } = useQuery<{ email: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  // 다이얼로그 열릴 때 본인 이메일로 초기화 (사용자가 직접 비우거나 수정 가능).
  function openTestDialog() {
    setTestTo(me?.email ?? "");
    setTestDialogOpen(true);
  }
  const testSend = useMutation({
    mutationFn: async (recipients: string[]) =>
      (
        await api.post(`/marketing/email-templates/${template.id}/test-send`, {
          to: recipients,
        })
      ).data as { delivered: boolean; to: string[] },
    onSuccess: (data) => {
      setTestDialogOpen(false);
      alert(
        data.delivered
          ? `테스트 발송 완료 — ${data.to.join(", ")}`
          : `테스트 발송 실패 (서버 응답: delivered=false). 메일 설정을 확인하세요.`,
      );
    },
    onError: (e: any) =>
      alert(e?.response?.data?.detail ?? "테스트 발송 실패"),
  });

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="템플릿 이름 *">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="설명 (선택)">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="제목 *" colSpan={2}>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="안녕하세요 {{contact_name}}님"
            className={input}
          />
        </Field>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">사용 가능한 머지필드</div>
        <div className="flex flex-wrap gap-1.5">
          {MERGE_FIELDS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                if (bodyKind === "HTML") setBodyHtml((prev) => prev + m.key);
                else alert("머지필드 삽입은 HTML 탭에서만 지원됩니다.");
              }}
              title={m.label}
              className="text-[11px] font-mono bg-muted px-2 py-1 rounded hover:bg-muted-foreground/10"
            >
              {m.key}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        <BodyKindTab
          active={bodyKind === "HTML"}
          onClick={() => setBodyKind("HTML")}
          icon={<Code2 className="h-3.5 w-3.5" />}
        >
          HTML
        </BodyKindTab>
        <BodyKindTab
          active={bodyKind === "EDITOR"}
          onClick={() => setBodyKind("EDITOR")}
          icon={<Wand2 className="h-3.5 w-3.5" />}
        >
          에디터 (회의록 방식)
        </BodyKindTab>
        <BodyKindTab
          active={bodyKind === "IMPORT"}
          onClick={() => setBodyKind("IMPORT")}
          icon={<Globe className="h-3.5 w-3.5" />}
        >
          URL 가져오기
        </BodyKindTab>
      </div>

      {bodyKind === "HTML" && (
        <>
          <Field label="HTML 본문">
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              style={{ height: 500 }}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
              placeholder="<p>안녕하세요 {{contact_name}}님,</p>..."
            />
          </Field>
          <Field label="텍스트 본문 (HTML 미지원 클라이언트용, 선택)">
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />
          </Field>
        </>
      )}

      {bodyKind === "EDITOR" && (
        <div
          className="rounded-md border border-border bg-background flex flex-col"
          style={{ height: 500 }}
        >
          {/* BlockNote 가 부모 높이를 따라가도록 flex-1 + min-h-0. */}
          <div className="flex-1 min-h-0 overflow-auto">
            <MeetingNoteEditor
              initialBody={bodyJson ? JSON.stringify(bodyJson) : null}
              onSave={async (body: string, plainText: string) => {
                // ref 는 동기적으로 즉시 반영 — 저장 mutation 이 setState 를 기다리지
                // 않고 ref 만 읽어가도 최신값 보장. state 도 같이 set 해서 다음
                // render 의 initialBody 가 일치하도록.
                let parsed: any = null;
                try {
                  parsed = JSON.parse(body);
                } catch {
                  parsed = null;
                }
                editorJsonRef.current = parsed;
                editorPlainRef.current = plainText;
                setBodyJson(parsed);
              }}
              saveRef={editorSaveRef}
              htmlRef={editorHtmlRef}
            />
          </div>
          <p className="text-[11px] text-muted-foreground px-2 py-1.5 border-t border-border">
            본문에 이미지를 paste 하면 이메일에 그대로 포함되어 발송됩니다 (data URL).
            저장 시 BlockNote 가 이메일용 HTML 로 변환합니다.
          </p>
        </div>
      )}

      {bodyKind === "IMPORT" && (
        <Field label="가져올 URL">
          <div className="flex gap-2">
            <input
              type="url"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://www.example.com/blog/..."
              className="flex-1 h-9 rounded-md border border-border bg-background px-2"
            />
            <button
              type="button"
              disabled={!importUrl.trim() || importMutation.isPending}
              onClick={() => importMutation.mutate()}
              className="text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" /> 가져오기
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            외부 URL 의 HTML 을 가져와 이메일용으로 정리한 후 HTML 탭에 채워 넣습니다.
            script/style/iframe 은 제거되고 상대 경로 이미지·링크는 절대 URL 로 변환됩니다.
          </p>
        </Field>
      )}

      <p className="text-xs text-muted-foreground">
        클릭 추적이 필요한 링크는 <code className="bg-muted px-1 rounded">[[track:URL]]</code> 형식으로
        작성하세요. 수신거부 푸터는 발송 시 자동으로 부착됩니다.
      </p>

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => {
            if (confirm(`"${template.name}" 템플릿을 삭제할까요?`)) del.mutate();
          }}
          className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
        >
          <Trash2 className="h-3.5 w-3.5" /> 템플릿 삭제
        </button>
        <button
          type="button"
          onClick={openTestDialog}
          className="ml-auto h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          title="캠페인 흐름 없이 즉시 테스트 메일 1~10명 발송 (수신거부 푸터·트래킹 없음)"
        >
          <Send className="h-3.5 w-3.5" /> 테스트 발송
        </button>
        <button
          type="button"
          disabled={save.isPending || !name.trim() || !subject.trim()}
          onClick={() => save.mutate()}
          className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" /> {save.isPending ? "저장 중..." : "저장"}
        </button>
      </div>

      {testDialogOpen && (
        <TestSendDialog
          defaultTo={testTo}
          submitting={testSend.isPending}
          onClose={() => setTestDialogOpen(false)}
          onSubmit={(recipients) => testSend.mutate(recipients)}
        />
      )}
    </div>
  );
}


// 테스트 발송 다이얼로그 — 콤마(또는 줄바꿈)로 1~10명 입력.
function TestSendDialog({
  defaultTo,
  submitting,
  onClose,
  onSubmit,
}: {
  defaultTo: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (recipients: string[]) => void;
}) {
  const [value, setValue] = useState(defaultTo);

  function parse(): string[] {
    return value
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const recipients = parse();
  const tooMany = recipients.length > 10;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">테스트 발송</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            수신자 이메일을 입력하세요 (콤마 또는 줄바꿈으로 1~10명).
          </p>
        </header>
        <div className="p-4 space-y-2">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            placeholder="user@example.com, another@example.com"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            autoFocus
          />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              파싱 결과: {recipients.length}명
              {tooMany && (
                <span className="text-red-600 ml-1">(최대 10명)</span>
              )}
            </span>
          </div>
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900">
            테스트 발송은 캠페인 흐름을 우회하므로 <b>수신거부 푸터·트래킹
            픽셀</b>이 부착되지 않습니다. <b>머지 토큰</b> ({"{{name}}"} 등)도
            치환되지 않은 원본 그대로 전달됩니다.
          </div>
        </div>
        <footer className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 text-sm rounded-md border border-border hover:bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            disabled={submitting || recipients.length === 0 || tooMany}
            onClick={() => onSubmit(recipients)}
            className="h-9 px-4 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "발송 중..." : "발송"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  const cls = colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function BodyKindTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-1.5 -mb-px border-b-2 text-xs inline-flex items-center gap-1 transition-colors " +
        (active
          ? "border-primary text-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}
