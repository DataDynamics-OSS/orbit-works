"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailWarning, Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/ToastProvider";

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

type Unsubscribe = {
  id: string;
  email: string;
  reason: string | null;
  unsubscribed_at: string;
};

const MERGE_FIELDS = [
  { key: "{{customer_name}}", label: "고객사 이름" },
  { key: "{{contact_name}}", label: "수신자 이름" },
  { key: "{{contact_email}}", label: "수신자 이메일" },
  { key: "{{contact_title}}", label: "수신자 직함" },
  { key: "{{customer_representative}}", label: "고객사 대표" },
];

export default function EmailsPage() {
  const params = useSearchParams();
  const initialTab = params.get("tab") === "unsubscribes" ? "unsubscribes" : "templates";
  const [tab, setTab] = useState<"templates" | "unsubscribes">(initialTab);

  return (
    <>
      <DashboardHeader title="이메일 발송" />
      <div className="p-4">
        <div className="flex gap-1 border-b border-border mb-4">
          <TabButton active={tab === "templates"} onClick={() => setTab("templates")}>
            템플릿
          </TabButton>
          <TabButton
            active={tab === "unsubscribes"}
            onClick={() => setTab("unsubscribes")}
          >
            <MailWarning className="h-3.5 w-3.5 mr-1 inline" />
            수신거부
          </TabButton>
        </div>
        {tab === "templates" ? <TemplatesTab /> : <UnsubscribesTab />}
      </div>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function TemplatesTab() {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ["marketing", "email-templates"],
    queryFn: async () => (await api.get("/marketing/email-templates")).data,
  });

  const create = useMutation({
    mutationFn: async (payload: { name: string; description: string | null }) =>
      (await api.post("/marketing/email-templates", {
        name: payload.name,
        description: payload.description,
        // 백엔드 default — subject / body 는 빈 값으로 만들어두고 상세에서 입력.
        subject: "",
        body_kind: "HTML",
        body_html: "",
        body_text: "",
      })).data as Template,
    onSuccess: (tpl) => {
      qc.invalidateQueries({ queryKey: ["marketing", "email-templates"] });
      setCreateOpen(false);
      router.push(`/marketing/emails/${tpl.id}`);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "생성에 실패했습니다."),
  });

  const del = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/marketing/email-templates/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["marketing", "email-templates"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          머지필드 — 본문에서 <code className="text-xs bg-muted px-1 rounded">{`{{customer_name}}`}</code>{" "}
          등을 쓰면 발송 시 자동 치환.
        </p>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> 새 템플릿
        </button>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">이름</th>
              <th className="text-left px-3 py-2 font-medium">제목</th>
              <th className="text-left px-3 py-2 font-medium">설명</th>
              <th className="text-left px-3 py-2 font-medium">마지막 사용</th>
              <th className="text-right px-3 py-2 font-medium w-16">동작</th>
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted-foreground p-8">
                  등록된 템플릿이 없습니다.
                </td>
              </tr>
            )}
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-border hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">
                  <Link
                    href={`/marketing/emails/${t.id}`}
                    className="text-primary hover:underline"
                  >
                    {t.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{t.subject}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {t.description || "-"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {t.last_used_at
                    ? new Date(t.last_used_at).toLocaleDateString("ko-KR")
                    : "-"}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`"${t.name}" 템플릿을 삭제하시겠어요?`))
                        del.mutate(t.id);
                    }}
                    className="text-red-600 hover:bg-red-50 p-1 rounded-md"
                    aria-label="삭제"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateTemplateDialog
          submitting={create.isPending}
          onSubmit={(p) => create.mutate(p)}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

function CreateTemplateDialog({
  onSubmit,
  onClose,
  submitting,
}: {
  onSubmit: (p: { name: string; description: string | null }) => void;
  onClose: () => void;
  submitting: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const input = "w-full h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <Dialog
      open
      onClose={onClose}
      title="새 이메일 템플릿"
      width="max-w-md"
      footer={
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            disabled={!name.trim() || submitting}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                description: description.trim() || null,
              })
            }
            className="text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> {submitting ? "생성 중..." : "생성 후 편집"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">템플릿 이름 *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 분기 뉴스레터 - Iceberg"
            className={input}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">설명 (선택)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={input}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          제목·본문 등 나머지 정보는 생성 후 전용 편집 페이지에서 입력합니다.
        </p>
      </div>
    </Dialog>
  );
}


function UnsubscribesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [addEmail, setAddEmail] = useState("");

  const { data: rows = [] } = useQuery<Unsubscribe[]>({
    queryKey: ["marketing", "unsubscribes"],
    queryFn: async () => (await api.get("/marketing/unsubscribes")).data,
  });

  const add = useMutation({
    mutationFn: async () =>
      (
        await api.post("/marketing/unsubscribes", {
          email: addEmail,
          reason: "manual",
        })
      ).data,
    onSuccess: () => {
      setAddEmail("");
      qc.invalidateQueries({ queryKey: ["marketing", "unsubscribes"] });
      toast.success("수신거부 주소가 추가되었습니다.");
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      toast.error(err.response?.data?.detail || "추가에 실패했습니다.");
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/marketing/unsubscribes/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["marketing", "unsubscribes"] }),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <b>정보통신망법 50조</b> — 영리목적 광고성 정보 발송 시 수신자의 사전 동의와 수신거부 처리
        의무. 이 목록에 포함된 주소로는 마케팅 메일이 발송되지 않습니다.
      </div>

      <div className="rounded-md border border-border bg-card p-3 flex items-end gap-2">
        <Field label="수동 추가">
          <input
            type="email"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            placeholder="user@example.com"
            className="w-72 h-9 rounded-md border border-border bg-background px-2 text-sm"
          />
        </Field>
        <button
          type="button"
          onClick={() => {
            if (!addEmail.includes("@")) {
              toast.error("올바른 이메일을 입력하세요.");
              return;
            }
            add.mutate();
          }}
          disabled={add.isPending}
          className="text-sm h-9 px-3 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          추가
        </button>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">이메일</th>
              <th className="text-left px-3 py-2 font-medium">사유</th>
              <th className="text-left px-3 py-2 font-medium">해지일</th>
              <th className="text-right px-3 py-2 font-medium w-20">동작</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-muted-foreground p-8">
                  수신거부 등록된 주소가 없습니다.
                </td>
              </tr>
            )}
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{u.email}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {u.reason || "-"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {new Date(u.unsubscribed_at).toLocaleString("ko-KR")}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          `${u.email} 의 수신거부를 해제하시겠어요? (재발송 가능 상태가 됩니다)`,
                        )
                      )
                        del.mutate(u.id);
                    }}
                    className="text-red-600 hover:bg-red-50 p-1 rounded-md"
                    aria-label="삭제"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}
