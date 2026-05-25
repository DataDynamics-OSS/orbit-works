"use client";

/**
 * 도움말 변경 이력 — 좌측 목록(시간 desc) + 우측 본문 미리보기. 선택한 revision
 * 으로 복원 가능. 복원은 backend 가 현재 상태도 별도 revision 으로 snapshot.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RotateCcw } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";

type RevisionListItem = {
  id: string;
  title: string;
  change_note: string | null;
  saved_by_user_id: string | null;
  saved_at: string;
};

type RevisionOut = RevisionListItem & {
  article_id: string;
  group: string | null;
  sort_order: number;
  summary: string | null;
  body_html: string;
  body_text: string | null;
};

export default function HelpRevisionsPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const key = (params?.key as string | undefined) ?? "";

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canRestore =
    me?.role === "ADMIN" || me?.role === "SUPER_ADMIN" || me?.role === "HR";

  const { data: list = [], isLoading } = useQuery<RevisionListItem[]>({
    queryKey: ["help-revisions", key],
    queryFn: async () =>
      (await api.get(`/help-articles/${key}/revisions`)).data,
    enabled: !!key,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && list.length > 0) setSelectedId(list[0].id);
  }, [list, selectedId]);

  const { data: rev } = useQuery<RevisionOut | null>({
    queryKey: ["help-revision", selectedId],
    queryFn: async () =>
      selectedId
        ? ((await api.get(`/help-articles/revisions/${selectedId}`)).data as RevisionOut)
        : null,
    enabled: !!selectedId,
  });

  const restoreM = useMutation({
    mutationFn: async (revId: string) =>
      (await api.post(`/help-articles/${key}/restore/${revId}`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["help-article", key] });
      qc.invalidateQueries({ queryKey: ["help-revisions", key] });
      router.push(`/help/${key}`);
    },
    onError: (e: any) => alert(e?.response?.data?.detail ?? "복원 실패"),
  });

  return (
    <>
      <DashboardHeader
        title={`${key} (이력)`}
        actions={
          <Link
            href={`/help/${key}`}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 보기
          </Link>
        }
      />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* 좌측 — revision 목록 */}
        <aside className="w-80 shrink-0 border-r border-border overflow-y-auto bg-background">
          <ul className="divide-y divide-border">
            {isLoading && (
              <li className="p-3 text-sm text-muted-foreground">불러오는 중…</li>
            )}
            {!isLoading && list.length === 0 && (
              <li className="p-3 text-sm text-muted-foreground italic">
                저장 이력이 없습니다.
              </li>
            )}
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={
                    "w-full text-left p-3 hover:bg-muted/40 " +
                    (selectedId === r.id ? "bg-muted/60" : "")
                  }
                >
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {r.saved_at.replace("T", " ").slice(0, 19)}
                  </div>
                  <div className="text-sm font-medium truncate">{r.title}</div>
                  {r.change_note && (
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      {r.change_note}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* 우측 — 선택 revision 본문 미리보기 + 복원 */}
        <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto">
          {!rev ? (
            <div className="text-sm text-muted-foreground">
              좌측에서 이력을 선택하세요.
            </div>
          ) : (
            <section className="rounded-md border border-border bg-card p-4">
              <header className="flex items-start justify-between gap-3 pb-3 border-b border-border">
                <div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {rev.saved_at.replace("T", " ").slice(0, 19)}
                  </div>
                  <h2 className="text-base font-semibold">{rev.title}</h2>
                  {rev.summary && (
                    <p className="text-sm text-muted-foreground">{rev.summary}</p>
                  )}
                  {rev.change_note && (
                    <p className="text-xs text-muted-foreground mt-1">
                      변경 사유: <em>{rev.change_note}</em>
                    </p>
                  )}
                </div>
                {canRestore && (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          "이 시점으로 복원할까요? 현재 본문도 자동으로 이력에 저장됩니다.",
                        )
                      )
                        restoreM.mutate(rev.id);
                    }}
                    disabled={restoreM.isPending}
                    className="h-8 inline-flex items-center gap-1 rounded-md border border-primary text-primary bg-background px-3 text-sm hover:bg-primary/10 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> 이 시점으로 복원
                  </button>
                )}
              </header>
              <div
                className="tiptap-content mt-3"
                dangerouslySetInnerHTML={{ __html: rev.body_html }}
              />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
