"use client";

/**
 * 사업공고 상세 드로어 — 우측 슬라이딩.
 *
 * 리스트에서 제목 클릭·더블클릭 시 열림. 원문 링크, 첨부, 북마크 메모, 영업기회
 * 전환 기능을 제공한다.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark,
  BookmarkCheck,
  ExternalLink,
  Paperclip,
  Save,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

type AnnouncementDetail = {
  id: string;
  source_code: string | null;
  source_name: string | null;
  external_id: string;
  title: string;
  agency: string | null;
  department: string | null;
  business_type: string | null;
  category: string | null;
  region: string | null;
  posted_at: string | null;
  deadline_at: string | null;
  days_to_deadline: number | null;
  budget_amount: number | null;
  currency: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  detail_url: string | null;
  attachment_urls: string[] | null;
  summary: string | null;
  bookmarked: boolean;
  bookmark_memo: string | null;
  converted_opportunity_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

const KRW = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("ko-KR").format(n);

function ddayLabel(days: number | null) {
  if (days == null) return "—";
  if (days < 0) return "마감됨";
  if (days === 0) return "오늘 마감";
  return `D-${days}`;
}

export function AnnouncementDetailDrawer({
  announcementId,
  onClose,
  onBookmarkToggle,
}: {
  announcementId: string | null;
  onClose: () => void;
  onBookmarkToggle: (id: string, add: boolean, memo: string | null) => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [memo, setMemo] = useState("");

  const { data } = useQuery<AnnouncementDetail>({
    queryKey: ["announcement-detail", announcementId],
    queryFn: async () =>
      (await api.get(`/announcements/${announcementId}`)).data,
    enabled: !!announcementId,
  });

  useEffect(() => {
    if (data) setMemo(data.bookmark_memo ?? "");
  }, [data]);

  useEffect(() => {
    if (!announcementId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [announcementId, onClose]);

  const convertM = useMutation({
    mutationFn: async () => {
      if (!data) return null;
      const payload = {
        name: data.title,
        business_type:
          data.business_type === "RESEARCH"
            ? "RESEARCH"
            : data.business_type === "PUBLIC_BID"
              ? "PUBLIC"
              : "PRIVATE",
        expected_amount: data.budget_amount ?? 0,
        expected_close_date: data.deadline_at?.slice(0, 10) ?? null,
        source: data.source_name ?? data.source_code ?? "announcement",
        description:
          `[${data.source_name ?? ""}] ${data.external_id}\n` +
          (data.detail_url ?? "") +
          "\n\n" +
          (data.summary ?? ""),
      };
      const opp = (await api.post("/opportunities", payload)).data;
      await api.patch(`/announcements/${data.id}`, {
        converted_opportunity_id: opp.id,
      });
      return opp;
    },
    onSuccess: async (opp) => {
      qc.invalidateQueries({ queryKey: ["announcement-detail"] });
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      if (opp) {
        await dialog.alert(
          `영업기회 [${opp.name}] 가 생성되었습니다. Opportunities 메뉴에서 확인.`,
        );
      }
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "영업기회 전환 실패", {
        title: "오류",
      }),
  });

  if (!announcementId) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="h-full w-full max-w-[560px] bg-card border-l border-border shadow-xl flex flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">
            {data?.source_name ?? "사업공고"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {!data ? (
          <div className="p-6 text-sm text-muted-foreground">로딩 중…</div>
        ) : (
          <div className="flex-1 overflow-auto px-4 py-3 space-y-4">
            <div>
              <h1 className="text-lg font-semibold leading-snug">{data.title}</h1>
              <div className="mt-1 text-xs text-muted-foreground">
                {data.agency ?? "—"}
                {data.department ? ` · ${data.department}` : ""}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <Field label="게시일" value={data.posted_at ?? "—"} />
              <Field
                label="마감"
                value={`${data.deadline_at?.replace("T", " ").slice(0, 16) ?? "—"} (${ddayLabel(data.days_to_deadline)})`}
              />
              <Field label="예산" value={`${KRW(data.budget_amount)} ${data.currency}`} />
              <Field label="지역" value={data.region ?? "—"} />
              <Field label="분야" value={data.category ?? "—"} />
              <Field label="유형" value={data.business_type ?? "—"} />
            </div>

            {(data.contact_name || data.contact_phone || data.contact_email) && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1">
                <div className="text-[11px] text-muted-foreground">담당</div>
                <div>{data.contact_name ?? "—"}</div>
                {data.contact_phone && <div>{data.contact_phone}</div>}
                {data.contact_email && <div>{data.contact_email}</div>}
              </div>
            )}

            {data.summary && (
              <div className="rounded-md border border-border p-3 text-sm whitespace-pre-wrap">
                {data.summary}
              </div>
            )}

            {data.attachment_urls && data.attachment_urls.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] text-muted-foreground">첨부</div>
                {data.attachment_urls.map((u) => (
                  <a
                    key={u}
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <Paperclip className="h-4 w-4" />
                    <span className="truncate">{u}</span>
                  </a>
                ))}
              </div>
            )}

            <div className="rounded-md border border-dashed border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">내 북마크</div>
                <button
                  type="button"
                  onClick={() =>
                    onBookmarkToggle(data.id, !data.bookmarked, memo || null)
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                >
                  {data.bookmarked ? (
                    <>
                      <BookmarkCheck className="h-3 w-3 text-amber-500" /> 해제
                    </>
                  ) : (
                    <>
                      <Bookmark className="h-3 w-3" /> 북마크
                    </>
                  )}
                </button>
              </div>
              <textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="메모 (북마크와 함께 저장됨)"
                rows={2}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
              {data.bookmarked && (
                <button
                  type="button"
                  onClick={() => onBookmarkToggle(data.id, true, memo || null)}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
                >
                  <Save className="h-3 w-3" /> 메모 저장
                </button>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              {data.detail_url && (
                <a
                  href={data.detail_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-4 w-4" /> 원문 보기
                </a>
              )}
              <button
                type="button"
                onClick={() => convertM.mutate()}
                disabled={convertM.isPending || !!data.converted_opportunity_id}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                {data.converted_opportunity_id
                  ? "이미 영업기회로 등록됨"
                  : "영업기회로 전환"}
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
