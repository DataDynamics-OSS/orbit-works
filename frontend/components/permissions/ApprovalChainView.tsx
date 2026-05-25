"use client";

/**
 * 결재선 체인 + 직속 부하 — 읽기 전용 시각화.
 *
 * 임직원 상세에서 결재선 체인을 그대로 보여주기 위한 view-only 컴포넌트.
 * 편집은 권한 관리(/permissions) 의 결재선·보안등급 탭에서. 사용자 요청에
 * 따라 임직원 상세에서는 보안등급/연차 승인자/결재선 편집 섹션은 제거하고,
 * 이 체인 시각화만 남긴다.
 */

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

type ApprovalChainNode = {
  level: number;
  id: string;
  name: string;
  title: string | null;
  employee_no: string | null;
};
type DirectReport = ApprovalChainNode;

export function ApprovalChainView({ developerId }: { developerId: string }) {
  const { data: chain = [] } = useQuery<ApprovalChainNode[]>({
    queryKey: ["approval-chain", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/approval-chain`)).data,
    staleTime: 30_000,
  });
  const { data: reports = [] } = useQuery<DirectReport[]>({
    queryKey: ["direct-reports", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/reports`)).data,
    staleTime: 30_000,
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">결재선 체인</h2>
        <span className="text-xs text-muted-foreground">
          편집은 권한 관리 → 결재선·보안등급 탭
        </span>
      </div>

      <div>
        {chain.length <= 1 ? (
          <div className="text-xs text-amber-700">
            상위 관리자 미설정 — 현재 결재 신청 시 차단됩니다.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1 text-sm">
            {chain.map((c, i) => (
              <span key={c.id} className="inline-flex items-center gap-1">
                <span
                  className={
                    "rounded border px-2 py-0.5 " +
                    (i === 0
                      ? "bg-muted text-muted-foreground border-border"
                      : "bg-card border-primary/30")
                  }
                >
                  {i === 0 ? "본인" : `${i}차`} · {c.name}
                  {c.title ? ` (${c.title})` : ""}
                </span>
                {i < chain.length - 1 && (
                  <span className="text-muted-foreground">→</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {reports.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            직속 부하 {reports.length}명
          </div>
          <div className="flex flex-wrap gap-1 text-xs">
            {reports.map((r) => (
              <span
                key={r.id}
                className="rounded border border-border bg-muted/40 px-2 py-0.5"
              >
                {r.name}
                {r.title ? ` · ${r.title}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
