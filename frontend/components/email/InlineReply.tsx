"use client";

/**
 * 본문 영역 인라인 답장 — Outlook 처럼 읽기 페인이 편집 모드로 전환된다(팝업 X).
 *
 * - 편집기: 게시판과 동일한 TipTap(HTML 입출력). 인용 원본은 <blockquote> 로 감싸
 *   좌측 | 바로 표시된다.
 * - 발송 시: body_html(리치) + body_text(평문, 인용부 줄마다 "| " prefix) 양쪽 전송
 *   → SMTP multipart/alternative (sender._build_mime 참고).
 */

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookUser, Loader2, Paperclip, Send, X } from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { TipTapEditor } from "@/components/board/TipTapEditor";
import { RecipientInput, AddressEntry } from "./RecipientInput";
import { AddressBookDialog } from "./AddressBookDialog";

// page.tsx 의 MessageDetail 과 구조적으로 호환되는 최소 필드.
type ReplyOriginal = {
  id: string;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string[] | null;
  cc_addrs: string[] | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  sent_at: string | null;
  attachments: { filename: string; is_inline: boolean }[];
};

const INPUT = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

function splitAddrs(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtDate(v: string | null): string {
  return v ? new Date(v).toLocaleString("ko-KR") : "";
}

function fmtSize(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// /email/outbox/upload 가 돌려주는 첨부 참조.
type UploadedAttachment = {
  filename: string;
  file_path: string;
  content_type: string | null;
  size_bytes: number | null;
};

// 답장 본문 HTML → 평문. blockquote 안의 줄은 "| " 로 인용 표시.
function htmlToPlainText(html: string): string {
  if (typeof window === "undefined" || !html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  const blockText = (el: Element) =>
    (el.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  const walk = (node: Element, inQuote: boolean) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName;
      if (tag === "BLOCKQUOTE") {
        walk(child, true);
      } else if (/^(UL|OL|TABLE|THEAD|TBODY|TR)$/.test(tag)) {
        walk(child, inQuote);
      } else {
        out.push((inQuote ? "| " : "") + blockText(child));
      }
    }
  };
  walk(doc.body, false);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type ReplyMode = "new" | "reply" | "reply_all" | "forward";

const MODE_LABEL: Record<ReplyMode, string> = {
  new: "새 메일",
  reply: "답장",
  reply_all: "전체답장",
  forward: "전달",
};

// 주소 목록에서 내 주소(self) 제거 + 중복 제거. 빈 값 제외.
function dedupExcludingSelf(
  addrs: (string | null | undefined)[],
  self: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const selfLower = self.trim().toLowerCase();
  for (const a of addrs) {
    const v = (a ?? "").trim();
    if (!v) continue;
    const lower = v.toLowerCase();
    if (lower === selfLower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(v);
  }
  return out;
}

export type DraftInitial = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyHtml?: string;
  /** 서버에 이미 보관된 첨부(읽기전용 표시). */
  existingAttachments?: { filename: string }[];
};

export function InlineReply({
  accountId,
  original,
  mode,
  selfAddr,
  onClose,
  draftId,
  initial,
}: {
  accountId: string;
  /** 답장/전달의 원본 메일. 새 메일("new")이면 null. */
  original: ReplyOriginal | null;
  mode: ReplyMode;
  /** 이 계정의 메일 주소 — 전체답장 수신자에서 자기 자신 제외. */
  selfAddr: string;
  onClose: () => void;
  /** 임시보관(DRAFT) 편집 시 그 id. 있으면 PATCH(+발송) 경로. */
  draftId?: string;
  /** 임시보관 편집 시 초기값(수신자/제목/본문/기존첨부). */
  initial?: DraftInitial;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  // 모드별 수신자/참조.
  const initialTo = useMemo(() => {
    if (!original || mode === "forward" || mode === "new") return "";
    if (mode === "reply_all") {
      return dedupExcludingSelf(
        [original.from_addr, ...(original.to_addrs ?? [])],
        selfAddr,
      ).join(", ");
    }
    return original.from_addr ?? "";
  }, [mode, original, selfAddr]);

  const initialCc = useMemo(() => {
    if (original && mode === "reply_all") {
      return dedupExcludingSelf(original.cc_addrs ?? [], selfAddr).join(", ");
    }
    return "";
  }, [mode, original, selfAddr]);

  const [to, setTo] = useState(initial?.to ?? initialTo);
  const [cc, setCc] = useState(initial?.cc ?? initialCc);
  const [bcc, setBcc] = useState(initial?.bcc ?? "");
  const [subject, setSubject] = useState(() => {
    if (initial) return initial.subject ?? "";
    if (!original || mode === "new") return "";
    const base = original.subject ?? "";
    if (mode === "forward") {
      return base.startsWith("Fwd:") ? base : `Fwd: ${base}`;
    }
    return base.startsWith("Re:") ? base : `Re: ${base}`;
  });

  // 초기 본문 — 새 메일은 빈 본문, 그 외엔 빈 줄(작성 위치) + 인용/전달 헤더 + blockquote(원본).
  const initialBody = useMemo(() => {
    if (!original || mode === "new") return "<p></p>";
    const quotedInner = original.body_html?.trim()
      ? original.body_html
      : escapeHtml(original.body_text ?? "").replace(/\n/g, "<br>");
    const sender = original.from_name || original.from_addr || "";
    const when = fmtDate(original.received_at || original.sent_at);
    if (mode === "forward") {
      // 전달: "전달된 메시지" 헤더(보낸/날짜/받는/제목) + 원본.
      const lines = [
        "---------- 전달된 메시지 ----------",
        `보낸사람: ${sender}`,
        `날짜: ${when}`,
        `받는사람: ${(original.to_addrs ?? []).join(", ")}`,
        `제목: ${original.subject ?? ""}`,
      ];
      const head = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
      return `<p></p><p></p>${head}<blockquote>${quotedInner}</blockquote>`;
    }
    const header = [when, sender].filter(Boolean).join(", ");
    return `<p></p><p></p><p>${escapeHtml(header)} 작성:</p><blockquote>${quotedInner}</blockquote>`;
  }, [mode, original]);

  const [body, setBody] = useState(initial?.bodyHtml ?? initialBody);

  // 전달 시 함께 보낼 원본 첨부(비인라인). 표시용.
  const fwdAttachments = useMemo(
    () =>
      original && mode === "forward"
        ? original.attachments.filter((a) => !a.is_inline)
        : [],
    [mode, original],
  );

  // 사용자가 업로드한 첨부.
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 주소록(자동완성·피커) — 계정별 캐시.
  const { data: addressBook } = useQuery<AddressEntry[]>({
    queryKey: ["email-address-book", accountId],
    queryFn: async () =>
      (await api.get("/email/address-book", { params: { account_id: accountId } }))
        .data,
    enabled: !!accountId,
    staleTime: 60_000,
  });
  const book = addressBook ?? [];
  // 주소록 피커가 열린 대상 필드(받는사람/참조/숨은참조).
  const [bookTarget, setBookTarget] = useState<"to" | "cc" | "bcc" | null>(null);

  const SETTER = { to: setTo, cc: setCc, bcc: setBcc } as const;

  // 대상 필드에 주소들을 dedup 병합.
  function addToField(field: "to" | "cc" | "bcc", emails: string[]) {
    SETTER[field]((prev) => {
      const present = new Set(
        prev
          .split(/[,;]/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
      const adds = emails.filter((e) => !present.has(e.trim().toLowerCase()));
      if (adds.length === 0) return prev;
      const base = prev.trim().replace(/[,;]\s*$/, "");
      return (base ? base + ", " : "") + adds.join(", ");
    });
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const done: UploadedAttachment[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        const { data } = await api.post("/email/outbox/upload", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        done.push(data as UploadedAttachment);
      }
      setAttachments((prev) => [...prev, ...done]);
    } catch (e: any) {
      dialog.alert(e?.response?.data?.detail ?? "첨부 업로드 실패", {
        title: "오류",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onPickFiles(files: FileList | null) {
    if (files) uploadFiles(Array.from(files));
  }

  // 드래그 앤 드롭 첨부 — 드래그 중 오버레이를 띄워 편집기로 드롭이 새지 않게 한다.
  const [dragOver, setDragOver] = useState(false);
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const sendM = useMutation({
    mutationFn: async (status: "DRAFT" | "QUEUED") => {
      if (draftId) {
        // 기존 임시보관 수정 → (발송 시) 발송. 기존 첨부는 서버에서 보존.
        await api.patch(`/email/outbox/${draftId}`, {
          to_addrs: splitAddrs(to),
          cc_addrs: splitAddrs(cc),
          bcc_addrs: splitAddrs(bcc),
          subject,
          body_html: body,
          body_text: htmlToPlainText(body),
          add_attachments: attachments,
        });
        if (status === "QUEUED") {
          return (await api.post(`/email/outbox/${draftId}/send`)).data;
        }
        return null;
      }
      return (
        await api.post("/email/outbox", {
          account_id: accountId,
          to_addrs: splitAddrs(to),
          cc_addrs: splitAddrs(cc),
          bcc_addrs: splitAddrs(bcc),
          subject,
          body_html: body,
          body_text: htmlToPlainText(body),
          // 답장 계열만 스레딩(In-Reply-To/References). 전달은 원본 첨부 포함.
          in_reply_to:
            original && (mode === "reply" || mode === "reply_all")
              ? original.id
              : null,
          attach_from_email:
            original && mode === "forward" ? original.id : null,
          attachments,
          status,
        })
      ).data;
    },
    onSuccess: async (_d, status) => {
      qc.invalidateQueries({ queryKey: ["email-outbox"] });
      onClose();
      if (status === "QUEUED") await dialog.alert("발송되었습니다.");
      else if (draftId) await dialog.alert("임시보관함에 저장했습니다.");
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "발송 실패", { title: "오류" }),
  });

  const canSend = splitAddrs(to).length > 0 && !sendM.isPending && !uploading;

  return (
    <div
      className="relative flex flex-1 min-h-0 flex-col"
      onDragEnter={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
    >
      {/* 드래그 중 오버레이 드롭존 — 편집기 위를 덮어 드롭을 가로챈다. */}
      {dragOver && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-background/80"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            // 컴포저 밖으로 나갈 때만 해제(자식으로 이동 시 무시).
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOver(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            uploadFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="pointer-events-none flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary px-10 py-8 text-primary">
            <Paperclip className="h-7 w-7" />
            <span className="text-sm font-medium">여기에 놓아 첨부</span>
          </div>
        </div>
      )}

      {/* 수신/참조/제목 — 상단 고정 */}
      <div className="shrink-0 space-y-2 border-b border-border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{MODE_LABEL[mode]}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {([
          { key: "to", label: "받는사람", value: to, set: setTo },
          { key: "cc", label: "참조", value: cc, set: setCc },
          { key: "bcc", label: "숨은참조", value: bcc, set: setBcc },
        ] as const).map((f) => (
          <div key={f.key} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">
              {f.label}
            </span>
            <RecipientInput
              value={f.value}
              onChange={f.set}
              suggestions={book}
              className={INPUT}
            />
            <button
              type="button"
              onClick={() => setBookTarget(f.key)}
              title="주소록에서 선택"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] hover:bg-muted"
            >
              <BookUser className="h-3.5 w-3.5" /> 주소록
            </button>
          </div>
        ))}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-muted-foreground">제목</span>
          <input
            className={INPUT}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        {/* 첨부 — 전달 원본(읽기전용) + 사용자 업로드(삭제 가능) + 파일 추가 */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onPickFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Paperclip className="h-3.5 w-3.5" />
            )}
            파일 첨부
          </button>
          {fwdAttachments.map((a, i) => (
            <span
              key={`fwd-${i}`}
              title="원본 첨부(전달 시 포함)"
              className="inline-flex max-w-[200px] items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="truncate">{a.filename}</span>
            </span>
          ))}
          {(initial?.existingAttachments ?? []).map((a, i) => (
            <span
              key={`ex-${i}`}
              title="기존 첨부(보관됨)"
              className="inline-flex max-w-[200px] items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="truncate">{a.filename}</span>
            </span>
          ))}
          {attachments.map((a, i) => (
            <span
              key={`up-${i}`}
              className="inline-flex max-w-[220px] items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
            >
              <span className="truncate">{a.filename}</span>
              {a.size_bytes ? (
                <span className="shrink-0 text-muted-foreground">
                  {fmtSize(a.size_bytes)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  setAttachments((prev) => prev.filter((_, j) => j !== i))
                }
                className="shrink-0 text-muted-foreground hover:text-rose-600"
                aria-label="첨부 제거"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 편집기 — 남은 높이를 채우고(bottom 맞춤) 내부 스크롤 */}
      <div className="min-h-0 flex-1 p-4">
        <TipTapEditor value={body} onChange={setBody} fillHeight />
      </div>

      {/* 액션 — 하단 고정 */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-3">
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => sendM.mutate("DRAFT")}
          disabled={sendM.isPending}
          className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
        >
          임시저장
        </button>
        <button
          type="button"
          onClick={() => sendM.mutate("QUEUED")}
          disabled={!canSend}
          className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {sendM.isPending ? "보내는 중…" : "보내기"}
        </button>
      </div>

      {bookTarget && (
        <AddressBookDialog
          entries={book}
          onClose={() => setBookTarget(null)}
          onConfirm={(emails) => {
            addToField(bookTarget, emails);
            setBookTarget(null);
          }}
        />
      )}
    </div>
  );
}
