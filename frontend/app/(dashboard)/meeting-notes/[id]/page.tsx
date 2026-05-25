"use client";

/**
 * 회의록 상세 화면.
 *
 * 탭 구성: 본문 / 첨부.
 * - 본문: BlockNote 에디터 (autosave 5초). 작성자 + 공유받은 직원 모두 편집 가능.
 * - 첨부: 드래그앤드롭 multi-upload, 파일명 인라인 편집, 다운로드, 삭제.
 *
 * 메타 변경 (제목·고객사·프로젝트·공유) 및 삭제는 작성자만.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bell,
  Check,
  Download,
  FileDown,
  FileText,
  ListChecks,
  ListOrdered,
  Mail,
  MessageSquare,
  Network,
  Paperclip,
  Pencil,
  Plus,
  Save,
  Trash2,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { sortDevelopersKo } from "@/lib/sort-developers";
import { SharePicker } from "@/components/meeting-notes/SharePicker";
import { EmailMeetingNoteDialog } from "@/components/meeting-notes/EmailMeetingNoteDialog";
import { MeetingNoteToc } from "@/components/meeting-notes/MeetingNoteToc";
import { downloadMeetingNotePdf } from "@/lib/meeting-note-export";
import type { TocItem } from "@/components/meeting-notes/MeetingNoteEditor";

const MeetingNoteEditor = dynamic(
  () =>
    import("@/components/meeting-notes/MeetingNoteEditor").then(
      (m) => m.MeetingNoteEditor,
    ),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">에디터 로드 중…</div> },
);

// 마인드맵 — reactflow 라 SSR 회피.
const MindmapEditor = dynamic(
  () =>
    import("@/components/meeting-notes/MindmapEditor").then(
      (m) => m.MindmapEditor,
    ),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">마인드맵 로드 중…</div> },
);

// drawio 다이어그램 — iframe 임베드. SSR 무관이지만 마인드맵과 같이 dynamic
// 으로 코드 분할해 첫 페이지 bundle 영향 0.
const MeetingNoteDrawio = dynamic(
  () =>
    import("@/components/meeting-notes/MeetingNoteDrawio").then(
      (m) => m.MeetingNoteDrawio,
    ),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">다이어그램 로드 중…</div> },
);

type ShareEntry = {
  developer_id: string;
  developer_name?: string | null;
  notified_at?: string | null;
  last_seen_at?: string | null;
};
type Attachment = {
  id: string;
  file_name: string;
  mime_type?: string | null;
  size?: number | null;
  uploaded_by?: string | null;
  uploaded_by_name?: string | null;
  created_at: string;
};
type MeetingDetail = {
  id: string;
  title: string;
  customer_id: string | null;
  customer_name: string | null;
  project_id: string | null;
  project_name: string | null;
  author_id: string | null;
  author_name: string | null;
  share_count: number;
  attachment_count: number;
  has_mindmap: boolean;
  has_drawio: boolean;
  can_edit: boolean;
  body: string | null;
  mindmap_data: { nodes: any[]; edges: any[] } | null;
  drawio_xml: string | null;
  shares: ShareEntry[];
  attachments: Attachment[];
  action_items: ActionItem[];
  created_at: string;
  updated_at: string;
};

export type ActionItemStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED";
export type ActionItem = {
  id: string;
  meeting_note_id: string;
  title: string;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  status: ActionItemStatus;
  note_text: string | null;
  completion_comment: string | null;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type CustomerLite = { id: string; name: string };
type ProjectLite = { id: string; name: string; customer_id?: string | null };
type DevLite = { id: string; name: string; title?: string | null };

type Tab = "body" | "mindmap" | "drawio" | "attachments" | "actions";

export default function MeetingNoteDetailPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const noteId = String(params.id);
  const [tab, setTab] = useState<Tab>("body");
  const [savingBody, setSavingBody] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editMetaOpen, setEditMetaOpen] = useState(false);
  const [shareManageOpen, setShareManageOpen] = useState(false);

  // 본문/마인드맵/drawio 에디터의 즉시 저장 함수를 외부에서 호출하기 위한 ref.
  // 에디터가 마운트되면 자기 flushSave 함수를 채우고, 언마운트 시 null.
  const bodySaveRef = useRef<(() => Promise<void>) | null>(null);
  const mindmapSaveRef = useRef<(() => Promise<void>) | null>(null);
  const drawioSaveRef = useRef<(() => Promise<void>) | null>(null);
  // 본문 → HTML export ref (이메일 발송용 — BlockNote.blocksToHTMLLossy).
  const bodyHtmlRef = useRef<(() => Promise<string>) | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  // TOC — 사이드 패널 표시 상태 (localStorage 영속) + 헤딩 목록.
  // SSR 안전을 위해 lazy initializer 로 localStorage 1회 읽음.
  const [tocOpen, setTocOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("meetingNoteTocOpen") !== "0";
    } catch {
      return true;
    }
  });
  // TOC 패널 폭 (px). 드래그 핸들러로 변경, localStorage 영속.
  const [tocWidth, setTocWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 240;
    try {
      const v = Number(localStorage.getItem("meetingNoteTocWidth"));
      return Number.isFinite(v) && v >= 160 && v <= 720 ? v : 240;
    } catch {
      return 240;
    }
  });
  const [headings, setHeadings] = useState<TocItem[]>([]);

  const onClickSave = useCallback(async () => {
    if (tab === "body") await bodySaveRef.current?.();
    else if (tab === "mindmap") await mindmapSaveRef.current?.();
    else if (tab === "drawio") await drawioSaveRef.current?.();
  }, [tab]);

  const { data: note, isLoading } = useQuery<MeetingDetail>({
    queryKey: ["meeting-note", noteId],
    queryFn: async () => (await api.get(`/meeting-notes/${noteId}`)).data,
  });

  const updateMeta = useMutation({
    mutationFn: async (payload: any) =>
      (await api.patch(`/meeting-notes/${noteId}`, payload)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meeting-note", noteId] });
      qc.invalidateQueries({ queryKey: ["meeting-notes"] });
      setEditMetaOpen(false);
      setShareManageOpen(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteNote = useMutation({
    mutationFn: async () => api.delete(`/meeting-notes/${noteId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meeting-notes"] });
      router.push("/meeting-notes");
    },
  });

  const renotify = useMutation({
    mutationFn: async () => api.post(`/meeting-notes/${noteId}/notify`),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["meeting-note", noteId] });
      await dialog.alert("공유 직원에게 알림을 재발송했습니다.", {
        title: "알림 재발송",
      });
    },
  });

  const onSaveBody = useCallback(
    async (body: string, plain: string) => {
      setSavingBody("saving");
      try {
        const res = await api.patch(`/meeting-notes/${noteId}/body`, {
          body,
          plain_text: plain,
        });
        setSavingBody("saved");
        // detail 캐시 즉시 동기화 — 탭 전환 시 stale initialBody 로 마운트되는
        // 문제 방지. updated_at 은 서버 응답값으로 갱신해 헤더의 "수정 …"
        // 표시도 함께 업데이트.
        qc.setQueryData<MeetingDetail>(["meeting-note", noteId], (old) =>
          old
            ? {
                ...old,
                body,
                updated_at: res.data?.updated_at ?? old.updated_at,
              }
            : old,
        );
        qc.invalidateQueries({ queryKey: ["meeting-notes"] });
      } catch {
        setSavingBody("error");
      }
    },
    [noteId, qc],
  );

  const onSaveMindmap = useCallback(
    async (data: { nodes: any[]; edges: any[] }) => {
      setSavingBody("saving");
      try {
        const res = await api.patch(`/meeting-notes/${noteId}/mindmap`, { data });
        setSavingBody("saved");
        // detail 캐시 즉시 동기화 — 탭 전환 시 색상·레이아웃 변경 사항이
        // 사라지는 버그 방지. updated_at 도 서버 응답으로 갱신.
        qc.setQueryData<MeetingDetail>(["meeting-note", noteId], (old) =>
          old
            ? {
                ...old,
                mindmap_data: data,
                has_mindmap: data.nodes.length > 0,
                updated_at: res.data?.updated_at ?? old.updated_at,
              }
            : old,
        );
        qc.invalidateQueries({ queryKey: ["meeting-notes"] });
      } catch {
        setSavingBody("error");
      }
    },
    [noteId, qc],
  );

  const onSaveDrawio = useCallback(
    async (xml: string | null) => {
      setSavingBody("saving");
      try {
        const res = await api.patch(`/meeting-notes/${noteId}/drawio`, { xml });
        setSavingBody("saved");
        qc.setQueryData<MeetingDetail>(["meeting-note", noteId], (old) =>
          old
            ? {
                ...old,
                drawio_xml: xml,
                has_drawio: !!(xml && xml.trim()),
                updated_at: res.data?.updated_at ?? old.updated_at,
              }
            : old,
        );
        qc.invalidateQueries({ queryKey: ["meeting-notes"] });
      } catch {
        setSavingBody("error");
      }
    },
    [noteId, qc],
  );

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="회의록" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }
  if (!note) return null;

  return (
    <>
      <DashboardHeader
        title="회의록"
        actions={
          <button
            type="button"
            onClick={() => router.push("/meeting-notes")}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
          >
            <ArrowLeft className="h-3 w-3" />
            목록
          </button>
        }
      />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-hidden">
        {/* 헤더 — 제목 + 메타 */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold truncate">{note.title}</h1>
              {note.can_edit && (
                <button
                  type="button"
                  onClick={() => setEditMetaOpen(true)}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  title="메타 수정"
                >
                  <Pencil className="h-3 w-3" />
                  수정
                </button>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {note.customer_name && <span>고객사: {note.customer_name}</span>}
              {note.project_name && <span>프로젝트: {note.project_name}</span>}
              <span>작성: {note.author_name ?? "관리자"}</span>
              <span>
                공유: {note.share_count}명
                {note.shares.length > 0 && (
                  <span className="ml-1">
                    (
                    {note.shares
                      .map((s) => s.developer_name)
                      .filter((n): n is string => Boolean(n))
                      .join(", ")}
                    )
                  </span>
                )}
              </span>
              <span>수정: {fmtDate(note.updated_at)}</span>
              {savingBody === "saving" && (
                <span className="text-amber-600">저장 중…</span>
              )}
              {savingBody === "saved" && (
                <span className="text-emerald-600 inline-flex items-center gap-0.5">
                  <Check className="h-3 w-3" /> 저장됨
                </span>
              )}
              {savingBody === "error" && (
                <span className="text-rose-600">저장 실패</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {note.can_edit && (
              <>
                <button
                  type="button"
                  onClick={() => setShareManageOpen(true)}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
                  title="공유 직원 추가·제거"
                >
                  <Users className="h-3 w-3" />
                  공유 관리
                </button>
                <button
                  type="button"
                  onClick={() => renotify.mutate()}
                  disabled={note.share_count === 0 || renotify.isPending}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-50"
                  title="공유 직원에게 알림 재발송"
                >
                  <Bell className="h-3 w-3" />
                  알림 재발송
                </button>
              </>
            )}
            {/* 본문 탭일 때만 TOC 토글 노출. 상태 localStorage 영속. */}
            {tab === "body" && (
              <button
                type="button"
                onClick={() => {
                  const next = !tocOpen;
                  setTocOpen(next);
                  try {
                    localStorage.setItem(
                      "meetingNoteTocOpen",
                      next ? "1" : "0",
                    );
                  } catch {
                    /* ignore */
                  }
                }}
                className={
                  "h-8 inline-flex items-center gap-1 rounded-md border px-2 text-xs " +
                  (tocOpen
                    ? "border-primary text-primary bg-primary/5 hover:bg-primary/10"
                    : "border-border hover:bg-muted")
                }
                title="목차 패널 토글"
              >
                <ListOrdered className="h-3 w-3" />
                목차
              </button>
            )}
            {/* 저장 — 본문/마인드맵/다이어그램 탭에서 노출. 모든 권한자가 사용. */}
            {(tab === "body" || tab === "mindmap" || tab === "drawio") && (
              <button
                type="button"
                onClick={onClickSave}
                disabled={savingBody === "saving"}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                title="현재 탭 저장"
              >
                <Save className="h-3 w-3" />
                {savingBody === "saving" ? "저장 중..." : "저장"}
              </button>
            )}
            {note.can_edit && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await dialog.confirm(
                    "이 회의록을 삭제하시겠습니까?",
                    { title: "삭제 확인", confirmText: "삭제" },
                  );
                  if (ok) deleteNote.mutate();
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2 text-xs text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3" />
                삭제
              </button>
            )}
            {/* PDF 다운로드 — 본문 HTML 을 html2canvas+jsPDF 로 A4 페이지로
                분할 저장. 권한 게이트 없음 (=조회 권한자 누구나). */}
            <button
              type="button"
              disabled={!note}
              onClick={async () => {
                if (!note) return;
                // 다운로드 전에 본문 즉시 저장 — 사용자가 입력 직후 받을 수 있어서.
                if (tab === "body") await bodySaveRef.current?.();
                const bodyHtml = (await bodyHtmlRef.current?.()) ?? "";
                try {
                  await downloadMeetingNotePdf(
                    {
                      id: note.id,
                      title: note.title,
                      customer_name: note.customer_name,
                      project_name: note.project_name,
                      author_name: note.author_name,
                      created_at: note.created_at,
                      updated_at: note.updated_at,
                    },
                    bodyHtml,
                  );
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.error("PDF 내보내기 실패:", e);
                  await dialog.alert("PDF 내보내기에 실패했습니다. 잠시 후 다시 시도해주세요.");
                }
              }}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-50"
              title="회의록 PDF 다운로드"
            >
              <FileDown className="h-3 w-3" />
              PDF
            </button>
            {/* 이메일 발송 — 작성자 + 공유받은 사람 모두 (=조회 권한 있는 누구나).
                메타 변경/삭제 권한과 무관해서 can_edit 게이트와 별도. */}
            <button
              type="button"
              onClick={async () => {
                // 발송 전에 본문 즉시 저장 — 사용자가 입력 직후 보낼 수 있어서.
                if (tab === "body") await bodySaveRef.current?.();
                setEmailOpen(true);
              }}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
              title="회의록 이메일 발송"
            >
              <Mail className="h-3 w-3" />
              이메일 발송
            </button>
          </div>
        </div>

        {/* Tab */}
        <TabBar>
          <TabItem active={tab === "body"} onClick={() => setTab("body")}>
            <FileText className="h-3 w-3 inline mr-1" />
            본문
          </TabItem>
          <TabItem active={tab === "mindmap"} onClick={() => setTab("mindmap")}>
            <Network className="h-3 w-3 inline mr-1" />
            마인드맵
            {note.has_mindmap && (
              <span className="ml-1 text-emerald-600">●</span>
            )}
          </TabItem>
          <TabItem active={tab === "drawio"} onClick={() => setTab("drawio")}>
            <Network className="h-3 w-3 inline mr-1" />
            다이어그램
            {note.has_drawio && (
              <span className="ml-1 text-emerald-600">●</span>
            )}
          </TabItem>
          <TabItem
            active={tab === "attachments"}
            onClick={() => setTab("attachments")}
          >
            <Paperclip className="h-3 w-3 inline mr-1" />
            첨부 ({note.attachments.length})
          </TabItem>
          <TabItem
            active={tab === "actions"}
            onClick={() => setTab("actions")}
          >
            <ListChecks className="h-3 w-3 inline mr-1" />
            액션 ({(note.action_items ?? []).filter((it) => it.status !== "DONE").length}/{(note.action_items ?? []).length})
          </TabItem>
        </TabBar>

        <div className="flex-1 min-h-0 flex">
          {tab === "body" && (
            <>
              <div className="flex-1 min-w-0 min-h-0 overflow-auto">
                <MeetingNoteEditor
                  initialBody={note.body}
                  onSave={onSaveBody}
                  saveRef={bodySaveRef}
                  htmlRef={bodyHtmlRef}
                  onHeadingsChange={setHeadings}
                />
              </div>
              {tocOpen && (
                <>
                  {/* 드래그 separator — 마우스 좌클릭으로 좌·우 드래그해 폭 조절.
                      double-click 으로 기본값(240px) 리셋. localStorage 영속. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="목차 패널 폭 조절"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const startWidth = tocWidth;
                      let latest = startWidth;
                      document.body.style.cursor = "col-resize";
                      document.body.style.userSelect = "none";
                      const onMove = (ev: MouseEvent) => {
                        // 마우스 ←: width 증가 (TOC 가 오른쪽 끝). →: width 감소.
                        const delta = startX - ev.clientX;
                        latest = Math.max(160, Math.min(720, startWidth + delta));
                        setTocWidth(latest);
                      };
                      const onUp = () => {
                        document.removeEventListener("mousemove", onMove);
                        document.removeEventListener("mouseup", onUp);
                        document.body.style.cursor = "";
                        document.body.style.userSelect = "";
                        try {
                          localStorage.setItem("meetingNoteTocWidth", String(latest));
                        } catch {
                          /* ignore */
                        }
                      };
                      document.addEventListener("mousemove", onMove);
                      document.addEventListener("mouseup", onUp);
                    }}
                    onDoubleClick={() => {
                      setTocWidth(240);
                      try {
                        localStorage.setItem("meetingNoteTocWidth", "240");
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="shrink-0 w-1 cursor-col-resize bg-border hover:bg-primary/40 transition-colors"
                    title="드래그하여 폭 조절 · 더블클릭으로 기본값(240px) 복원"
                  />
                  <MeetingNoteToc
                    headings={headings}
                    width={tocWidth}
                    onClose={() => {
                      setTocOpen(false);
                      try {
                        localStorage.setItem("meetingNoteTocOpen", "0");
                      } catch {
                        /* ignore — quota / private mode */
                      }
                    }}
                  />
                </>
              )}
            </>
          )}
          {tab === "mindmap" && (
            <div className="flex-1 min-h-0 overflow-auto">
              <div className="w-full h-full min-h-[480px]">
                <MindmapEditor
                  initialData={note.mindmap_data}
                  onSave={onSaveMindmap}
                  filenameBase={`mindmap_${note.title || "회의록"}`}
                  saveRef={mindmapSaveRef}
                />
              </div>
            </div>
          )}
          {tab === "drawio" && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <MeetingNoteDrawio
                initialXml={note.drawio_xml}
                onSave={onSaveDrawio}
                saveRef={drawioSaveRef}
                readOnly={!note.can_edit}
              />
            </div>
          )}
          {tab === "attachments" && (
            <div className="flex-1 min-h-0 overflow-auto">
              <AttachmentsPanel noteId={noteId} />
            </div>
          )}
          {tab === "actions" && (
            <div className="flex-1 min-h-0 overflow-auto">
              <ActionItemsPanel
                noteId={noteId}
                items={note.action_items ?? []}
                canEdit={note.can_edit}
              />
            </div>
          )}
        </div>
      </div>

      {note.can_edit && (
        <>
          <EditMetaDialog
            open={editMetaOpen}
            onClose={() => setEditMetaOpen(false)}
            note={note}
            onSubmit={(payload) => updateMeta.mutate(payload)}
            submitting={updateMeta.isPending}
          />
          <ShareManageDialog
            open={shareManageOpen}
            onClose={() => setShareManageOpen(false)}
            note={note}
            onSubmit={(payload) => updateMeta.mutate(payload)}
            submitting={updateMeta.isPending}
          />
        </>
      )}

      <EmailMeetingNoteDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        noteId={note.id}
        noteTitle={note.title}
        authorDeveloperId={note.author_id ?? null}
        getBodyHtml={async () => (await bodyHtmlRef.current?.()) ?? ""}
      />
    </>
  );
}


// ---------------------------------------------------------------------------
// 첨부 패널
// ---------------------------------------------------------------------------

function AttachmentsPanel({ noteId }: { noteId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();

  // 부모 페이지와 동일한 queryKey + queryFn — TanStack Query 캐시를 공유.
  // queryFn 을 생략하면 default queryFn 이 없을 때 런타임 에러가 나므로 명시.
  const { data: note } = useQuery<MeetingDetail>({
    queryKey: ["meeting-note", noteId],
    queryFn: async () => (await api.get(`/meeting-notes/${noteId}`)).data,
  });

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      return (
        await api.post(`/meeting-notes/${noteId}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data as Attachment[];
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meeting-note", noteId] });
      qc.invalidateQueries({ queryKey: ["meeting-notes"] });
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "업로드 실패", { title: "오류" }),
  });

  const renameM = useMutation({
    mutationFn: async ({ id, file_name }: { id: string; file_name: string }) =>
      (
        await api.patch(`/meeting-notes/${noteId}/attachments/${id}`, {
          file_name,
        })
      ).data as Attachment,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["meeting-note", noteId] }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/meeting-notes/${noteId}/attachments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meeting-note", noteId] });
      qc.invalidateQueries({ queryKey: ["meeting-notes"] });
    },
  });

  const download = async (att: Attachment) => {
    const res = await api.get(
      `/meeting-notes/${noteId}/attachments/${att.id}/download`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  if (!note) return null;
  const attachments = note.attachments;

  return (
    <div className="flex flex-col gap-3">
      <FileDropZone
        onFiles={(files) => uploadM.mutate(files)}
        label={uploadM.isPending ? "업로드 중…" : undefined}
        disabled={uploadM.isPending}
      />
      {attachments.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-4">
          첨부파일이 없습니다.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              downloadPath={`/meeting-notes/${noteId}/attachments/${a.id}/download`}
              onRename={(n) => renameM.mutate({ id: a.id, file_name: n })}
              onDelete={async () => {
                const ok = await dialog.confirm("이 첨부를 삭제하시겠습니까?", {
                  title: "삭제 확인",
                  confirmText: "삭제",
                });
                if (ok) deleteM.mutate(a.id);
              }}
              onDownload={() => download(a)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  downloadPath,
  onRename,
  onDelete,
  onDownload,
}: {
  attachment: Attachment;
  downloadPath: string;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(attachment.file_name);
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-xs">
      <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() && draft !== attachment.file_name) onRename(draft.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (draft.trim() && draft !== attachment.file_name) onRename(draft.trim());
              setEditing(false);
            } else if (e.key === "Escape") {
              setDraft(attachment.file_name);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex-1 min-w-0 text-left truncate hover:underline"
          title="클릭하여 이름 변경"
        >
          {attachment.file_name}
        </button>
      )}
      <span className="text-muted-foreground shrink-0">
        {fmtSize(attachment.size)}
      </span>
      {attachment.uploaded_by_name && (
        <span className="text-muted-foreground shrink-0">
          · {attachment.uploaded_by_name}
        </span>
      )}
      <span className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted shrink-0">
        <AttachmentPreviewButton
          filename={attachment.file_name}
          mime={attachment.mime_type ?? null}
          downloadPath={downloadPath}
        />
      </span>
      <button
        type="button"
        onClick={onDownload}
        className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted shrink-0"
        title="다운로드"
      >
        <Download className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="h-7 w-7 inline-flex items-center justify-center rounded-md text-destructive hover:bg-destructive/10 shrink-0"
        title="삭제"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 메타 수정 다이얼로그 (제목 / 고객사 / 프로젝트 / 공유)
// ---------------------------------------------------------------------------

function EditMetaDialog({
  open,
  onClose,
  note,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  note: MeetingDetail;
  onSubmit: (payload: any) => void;
  submitting: boolean;
}) {
  const [title, setTitle] = useState(note.title);
  const [customerId, setCustomerId] = useState<string | null>(note.customer_id);
  const [projectId, setProjectId] = useState<string | null>(note.project_id);
  const [shareIds, setShareIds] = useState<string[]>(
    note.shares.map((s) => s.developer_id),
  );

  // 모든 role 사용 — 메뉴 권한과 별개의 공용 picker.
  const { data: customers = [] } = useQuery<CustomerLite[]>({
    queryKey: ["pickers", "customers"],
    queryFn: async () => (await api.get("/pickers/customers")).data,
    staleTime: 60_000,
    enabled: open,
  });
  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ["pickers", "projects"],
    queryFn: async () => (await api.get("/pickers/projects")).data,
    staleTime: 60_000,
    enabled: open,
  });
  const { data: developers = [] } = useQuery<DevLite[]>({
    queryKey: ["developers", "share-pool"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: { employment_type: "FULL_TIME", status_filter: "ACTIVE" },
        })
      ).data,
    staleTime: 60_000,
    enabled: open,
  });

  const sortedCustomers = useMemo(
    () => customers.slice().sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [customers],
  );
  const filteredProjects = useMemo(() => {
    const list = customerId
      ? projects.filter((p) => p.customer_id === customerId)
      : projects;
    return list.slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [projects, customerId]);
  const sortedDevs = useMemo(
    () => sortDevelopersKo(developers),
    [developers],
  );

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="회의록 수정"
      width="max-w-3xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            disabled={!title.trim() || submitting}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                customer_id: customerId || null,
                project_id: projectId || null,
                share_developer_ids: shareIds,
              })
            }
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {submitting ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="제목 *" colSpan={2}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="고객사">
          <select
            value={customerId ?? ""}
            onChange={(e) => {
              setCustomerId(e.target.value || null);
              setProjectId(null);
            }}
            className={input}
          >
            <option value="">미지정</option>
            {sortedCustomers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="프로젝트">
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
            className={input}
          >
            <option value="">미지정</option>
            {filteredProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="공유 직원" colSpan={2}>
          <SharePicker
            developers={sortedDevs}
            excludeIds={note.author_id ? [note.author_id] : []}
            selectedIds={shareIds}
            setSelectedIds={setShareIds}
            helpText="새로 추가된 직원에게는 저장 시 Slack/Mattermost DM 이 발송됩니다."
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 공유 관리 다이얼로그 — 제목/고객사/프로젝트 변경 없이 공유 목록만 빠르게
// 추가·제거. PATCH /{id} 에 share_developer_ids 만 보내고 백엔드가 set 차분
// 처리. 신규 추가 대상은 자동으로 알림 발송 (생성 시점 알림 흐름과 동일).
// ---------------------------------------------------------------------------

function ShareManageDialog({
  open,
  onClose,
  note,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  note: MeetingDetail;
  onSubmit: (payload: any) => void;
  submitting: boolean;
}) {
  const [shareIds, setShareIds] = useState<string[]>(
    note.shares.map((s) => s.developer_id),
  );

  // open 될 때마다 현재 share 목록으로 동기화 — 외부에서 share 갱신된 뒤
  // 다시 열면 stale state 가 남지 않도록.
  useEffect(() => {
    if (open) {
      setShareIds(note.shares.map((s) => s.developer_id));
    }
  }, [open, note.shares]);

  const { data: developers = [] } = useQuery<DevLite[]>({
    queryKey: ["developers", "share-pool"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: { employment_type: "FULL_TIME", status_filter: "ACTIVE" },
        })
      ).data,
    staleTime: 60_000,
    enabled: open,
  });

  const sortedDevs = useMemo(
    () => sortDevelopersKo(developers),
    [developers],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="공유 관리"
      width="max-w-xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmit({ share_developer_ids: shareIds })}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {submitting ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <SharePicker
        developers={sortedDevs}
        excludeIds={note.author_id ? [note.author_id] : []}
        selectedIds={shareIds}
        setSelectedIds={setShareIds}
        defaultOpen
        helpText="새로 추가된 직원에게는 저장 시 Slack/Mattermost DM 이 발송됩니다. 제거는 알림이 가지 않습니다."
      />
    </Dialog>
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
  return (
    <label className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

function fmtDate(s: string): string {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSize(n?: number | null): string {
  if (!n || n <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + " " + units[i];
}

// ---------------------------------------------------------------------------
// 액션 아이템 패널 (TODO)
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<ActionItemStatus, string> = {
  TODO: "할 일",
  IN_PROGRESS: "진행",
  DONE: "완료",
  BLOCKED: "막힘",
};
const STATUS_COLORS: Record<ActionItemStatus, string> = {
  TODO: "bg-slate-100 text-slate-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  DONE: "bg-emerald-100 text-emerald-700",
  BLOCKED: "bg-rose-100 text-rose-700",
};

function ActionItemsPanel({
  noteId,
  items,
  canEdit,
}: {
  noteId: string;
  items: ActionItem[];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [adding, setAdding] = useState(false);

  const { data: staff = [] } = useQuery<
    { id: string; name: string; tag: string | null }[]
  >({
    queryKey: ["developer-directory", "FULL_TIME"],
    queryFn: async () =>
      (await api.get("/developers/directory?employment_type=FULL_TIME")).data,
    staleTime: 60 * 60 * 1000,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["meeting-note", noteId] });

  const createM = useMutation({
    mutationFn: async (payload: Partial<ActionItem>) =>
      (await api.post(`/meeting-notes/${noteId}/action-items`, payload)).data,
    onSuccess: () => {
      invalidate();
      setAdding(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "추가 실패"),
  });
  const updateM = useMutation({
    mutationFn: async ({ id, ...rest }: Partial<ActionItem> & { id: string }) =>
      (await api.patch(`/meeting-notes/${noteId}/action-items/${id}`, rest))
        .data,
    onSuccess: invalidate,
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "수정 실패"),
  });
  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/meeting-notes/${noteId}/action-items/${id}`),
    onSuccess: invalidate,
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패"),
  });

  // 정렬: 미완료 먼저 → due_date asc → 만든 순
  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const aDone = a.status === "DONE" ? 1 : 0;
      const bDone = b.status === "DONE" ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const ad = a.due_date || "9999";
      const bd = b.due_date || "9999";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.created_at < b.created_at ? -1 : 1;
    });
  }, [items]);

  const open = sorted.filter((it) => it.status !== "DONE");
  const done = sorted.filter((it) => it.status === "DONE");

  return (
    <div className="p-4 space-y-3">
      {canEdit && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3 w-3" />
            액션 추가
          </button>
          <span className="text-xs text-muted-foreground">
            완료 {done.length} / 전체 {items.length}
          </span>
        </div>
      )}

      {adding && (
        <ActionItemEditor
          staff={staff}
          onCancel={() => setAdding(false)}
          onSave={(payload) => createM.mutate(payload)}
          submitting={createM.isPending}
        />
      )}

      {/* 미완료 */}
      <ActionItemList
        items={open}
        staff={staff}
        canEdit={canEdit}
        onUpdate={(id, payload) => updateM.mutate({ id, ...payload })}
        onDelete={async (id) => {
          const ok = await dialog.confirm("이 액션 아이템을 삭제할까요?", {
            title: "삭제",
            confirmText: "삭제",
            destructive: true,
          });
          if (ok) deleteM.mutate(id);
        }}
        emptyHint="미완료 항목 없음"
      />

      {done.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            완료된 항목 보기 ({done.length})
          </summary>
          <div className="mt-2">
            <ActionItemList
              items={done}
              staff={staff}
              canEdit={canEdit}
              onUpdate={(id, payload) => updateM.mutate({ id, ...payload })}
              onDelete={async (id) => {
                const ok = await dialog.confirm("이 액션 아이템을 삭제할까요?", {
                  title: "삭제",
                  confirmText: "삭제",
                  destructive: true,
                });
                if (ok) deleteM.mutate(id);
              }}
              dim
            />
          </div>
        </details>
      )}
    </div>
  );
}

function ActionItemList({
  items,
  staff,
  canEdit,
  onUpdate,
  onDelete,
  emptyHint,
  dim,
}: {
  items: ActionItem[];
  staff: { id: string; name: string; tag: string | null }[];
  canEdit: boolean;
  onUpdate: (id: string, payload: Partial<ActionItem>) => void;
  onDelete: (id: string) => void;
  emptyHint?: string;
  dim?: boolean;
}) {
  if (items.length === 0)
    return emptyHint ? (
      <div className="text-xs text-muted-foreground p-3">{emptyHint}</div>
    ) : null;
  return (
    <ul className="divide-y divide-border border border-border rounded-md bg-card">
      {items.map((it) => (
        <ActionItemRow
          key={it.id}
          item={it}
          staff={staff}
          canEdit={canEdit}
          onUpdate={(payload) => onUpdate(it.id, payload)}
          onDelete={() => onDelete(it.id)}
          dim={dim}
        />
      ))}
    </ul>
  );
}

function ActionItemRow({
  item,
  staff,
  canEdit,
  onUpdate,
  onDelete,
  dim,
}: {
  item: ActionItem;
  staff: { id: string; name: string; tag: string | null }[];
  canEdit: boolean;
  onUpdate: (payload: Partial<ActionItem>) => void;
  onDelete: () => void;
  dim?: boolean;
}) {
  const dialog = useDialog();
  const [editing, setEditing] = useState(false);

  const onCheckChange = async (checked: boolean) => {
    if (!checked) {
      onUpdate({ status: "TODO" });
      return;
    }
    const comment = await dialog.prompt(
      <>
        <b>{item.title}</b>
        <div className="text-xs text-muted-foreground mt-1">
          완료 코멘트를 남기시겠어요? (선택)
        </div>
      </>,
      {
        title: "액션 완료",
        placeholder: "예: PR 머지 완료 / 고객 송부 / 보류 사유",
        confirmText: "완료 처리",
        cancelText: "취소",
      },
    );
    if (comment === null) return;
    onUpdate({
      status: "DONE",
      completion_comment: comment.trim() || null,
    });
  };
  if (editing) {
    return (
      <li className="p-3">
        <ActionItemEditor
          staff={staff}
          initial={item}
          onCancel={() => setEditing(false)}
          onSave={(payload) => {
            onUpdate(payload);
            setEditing(false);
          }}
        />
      </li>
    );
  }
  const overdue =
    item.due_date &&
    item.status !== "DONE" &&
    new Date(item.due_date) < new Date(new Date().toDateString());
  return (
    <li
      className={
        "flex items-start gap-3 p-3 " + (dim ? "opacity-60" : "")
      }
    >
      <input
        type="checkbox"
        checked={item.status === "DONE"}
        disabled={!canEdit}
        onChange={(e) => onCheckChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div
          className={
            "text-sm " + (item.status === "DONE" ? "line-through" : "")
          }
        >
          {item.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={
              "inline-block px-1.5 py-0.5 rounded " +
              STATUS_COLORS[item.status]
            }
          >
            {STATUS_LABELS[item.status]}
          </span>
          {item.assignee_name && (
            <span className="text-muted-foreground">
              👤 {item.assignee_name}
            </span>
          )}
          {item.due_date && (
            <span
              className={
                overdue
                  ? "text-rose-600 font-semibold"
                  : "text-muted-foreground"
              }
            >
              📅 {item.due_date}
              {overdue && " (지남)"}
            </span>
          )}
          {item.note_text && (
            <span className="text-muted-foreground italic">
              · {item.note_text}
            </span>
          )}
          {item.completion_comment && (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <MessageSquare className="h-3 w-3" />
              {item.completion_comment}
            </span>
          )}
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-7 px-2 text-xs rounded border border-border hover:bg-muted"
          >
            편집
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
            title="삭제"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </li>
  );
}

function ActionItemEditor({
  staff,
  initial,
  onCancel,
  onSave,
  submitting,
}: {
  staff: { id: string; name: string; tag: string | null }[];
  initial?: ActionItem;
  onCancel: () => void;
  onSave: (payload: Partial<ActionItem>) => void;
  submitting?: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [assigneeId, setAssigneeId] = useState<string | null>(
    initial?.assignee_id ?? null,
  );
  const [assigneeName, setAssigneeName] = useState<string>(
    initial?.assignee_name ?? "",
  );
  const [dueDate, setDueDate] = useState<string>(initial?.due_date ?? "");
  const [status, setStatus] = useState<ActionItemStatus>(
    initial?.status ?? "TODO",
  );
  const [noteText, setNoteText] = useState<string>(initial?.note_text ?? "");
  const [completionComment, setCompletionComment] = useState<string>(
    initial?.completion_comment ?? "",
  );

  const input =
    "h-8 rounded-md border border-input bg-background px-2 text-xs";
  const submit = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      assignee_id: assigneeId,
      assignee_name: assigneeName.trim() || null,
      due_date: dueDate || null,
      status,
      note_text: noteText.trim() || null,
      completion_comment: completionComment.trim() || null,
    });
  };

  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="액션 아이템 (예: 견적서 초안 작성)"
        className={input + " w-full text-sm"}
      />
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground mb-0.5">담당자 (정규직)</div>
          <select
            value={assigneeId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              setAssigneeId(id);
              if (id) {
                const s = staff.find((x) => x.id === id);
                setAssigneeName(s?.name ?? "");
              }
            }}
            className={input + " w-full"}
          >
            <option value="">— 선택 —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.tag ? ` · ${s.tag}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-muted-foreground mb-0.5">또는 외부 이름</div>
          <input
            value={assigneeName}
            onChange={(e) => {
              setAssigneeName(e.target.value);
              setAssigneeId(null);
            }}
            placeholder="외부 인력"
            className={input + " w-full"}
          />
        </div>
        <div>
          <div className="text-muted-foreground mb-0.5">마감일</div>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={input + " w-full"}
          />
        </div>
        <div>
          <div className="text-muted-foreground mb-0.5">상태</div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ActionItemStatus)}
            className={input + " w-full"}
          >
            <option value="TODO">할 일</option>
            <option value="IN_PROGRESS">진행</option>
            <option value="BLOCKED">막힘</option>
            <option value="DONE">완료</option>
          </select>
        </div>
      </div>
      <input
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        placeholder="메모 (선택)"
        className={input + " w-full"}
      />
      {(status === "DONE" || completionComment) && (
        <input
          value={completionComment}
          onChange={(e) => setCompletionComment(e.target.value)}
          placeholder="완료 코멘트 (선택)"
          className={input + " w-full"}
        />
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 rounded-md border border-border text-xs"
        >
          취소
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !title.trim()}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
        >
          {submitting ? "저장 중..." : initial ? "저장" : "추가"}
        </button>
      </div>
    </div>
  );
}
