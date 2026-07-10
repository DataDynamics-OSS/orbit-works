"use client";

/**
 * 회의록 이메일 발송 다이얼로그.
 *
 * - 직원 picker: 신규 회의록 작성 모달과 동일한 SharePicker 컴포넌트.
 *   FULL_TIME 정규직 풀에서 다중 선택 (작성자 본인은 제외).
 * - 추가 메시지: 선택, 줄바꿈 보존되어 메일·DM 본문에 삽입됨.
 * - 발송 시 BlockNote 본문을 HTML 로 export 한 뒤 API 로 함께 전달.
 *   서버가 sanitize 한 뒤 이메일 본문에 삽입.
 *
 * 권한은 호출 페이지가 책임 — 작성자/공유자 둘 다 발송 가능.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { SharePicker } from "@/components/meeting-notes/SharePicker";
import { sortDevelopersKo } from "@/lib/sort-developers";
import { highlightHtmlForEmail } from "@/lib/highlight-code";

type DevLite = {
  id: string;
  name: string;
  title?: string | null;
};

type EmailResult = {
  sent_count: number;
  notify_sent_count: number;
  skipped: { developer_id: string; reason: string }[];
};

export function EmailMeetingNoteDialog({
  open,
  onClose,
  noteId,
  noteTitle,
  authorDeveloperId,
  /** BlockNote 본문 → HTML export 함수 (MeetingNoteEditor 의 htmlRef.current). */
  getBodyHtml,
}: {
  open: boolean;
  onClose: () => void;
  noteId: string;
  noteTitle: string;
  authorDeveloperId: string | null;
  getBodyHtml: () => Promise<string>;
}) {
  const dialog = useDialog();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customMessage, setCustomMessage] = useState("");

  // 다이얼로그 열 때마다 입력값 초기화.
  useEffect(() => {
    if (open) {
      setSelectedIds([]);
      setCustomMessage("");
    }
  }, [open]);

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

  const sortedDevs = useMemo(() => sortDevelopersKo(developers), [developers]);

  const sendM = useMutation({
    mutationFn: async () => {
      // 저장 HTML 의 코드 블록을 강조 + 인라인 스타일로 구워 보낸다 (이메일은 외부
      // CSS/JS 미적용이라 토큰 색·다크 배경을 인라인으로 박아야 보인다).
      const body_html = highlightHtmlForEmail(await getBodyHtml());
      return (
        await api.post(`/meeting-notes/${noteId}/email`, {
          developer_ids: selectedIds,
          body_html,
          custom_message: customMessage.trim() || null,
        })
      ).data as EmailResult;
    },
    onSuccess: async (result) => {
      const summary =
        `이메일 ${result.sent_count}명 발송, 알림 ${result.notify_sent_count}명 발송.` +
        (result.skipped.length > 0
          ? ` (${result.skipped.length}명 제외 — 이메일 미등록 또는 발송 실패)`
          : "");
      await dialog.alert(summary, { title: "발송 완료" });
      onClose();
    },
    onError: async (e: any) => {
      await dialog.alert(
        e?.response?.data?.detail ?? "이메일 발송 실패",
        { title: "오류" },
      );
    },
  });

  const canSend = selectedIds.length > 0 && !sendM.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="회의록 이메일 발송"
      width="max-w-xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={sendM.isPending}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => sendM.mutate()}
            disabled={!canSend}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {sendM.isPending ? "발송 중..." : "발송"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div>
          <div className="text-xs text-muted-foreground mb-1">제목</div>
          <div className="text-sm font-medium">{noteTitle}</div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">받는 직원 (정규직)</span>
          <SharePicker
            developers={sortedDevs}
            excludeIds={authorDeveloperId ? [authorDeveloperId] : []}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            helpText="선택된 직원에게 이메일 + Slack/Mattermost DM 동시 발송. 회사 이메일이 없으면 자동 제외."
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            추가 메시지 (선택)
          </span>
          <textarea
            value={customMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            rows={3}
            placeholder="회의록과 함께 전달할 짧은 메시지를 입력하세요."
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
          />
        </label>

        <div className="text-[11px] text-muted-foreground rounded-md bg-muted/50 p-2">
          이메일과 메신저 DM 둘 다에 회의록 링크 + 본문 내용이 포함됩니다.
          첨부파일은 발송되지 않습니다.
        </div>
      </div>
    </Dialog>
  );
}
