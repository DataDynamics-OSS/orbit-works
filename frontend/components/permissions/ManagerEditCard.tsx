"use client";

/**
 * 임직원의 상위 관리자(결재선 1차 승인자) 설정 + 체인 시각화 + 직속 부하.
 *
 * 임직원 상세에 있던 ManagerSection 의 *편집 가능* 버전 — 권한 관리 메뉴
 * (탭: 결재선·보안등급) 전용. 임직원 상세에서는 ApprovalChainView (읽기 전용)
 * 만 노출하고, 편집은 여기로 일원화.
 *
 * canEdit 는 ADMIN/HR 만 true — 호출자에서 판단.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

type ManagerCandidate = {
  id: string;
  name: string;
  title: string | null;
  employee_no: string | null;
};
type ApprovalChainNode = {
  level: number;
  id: string;
  name: string;
  title: string | null;
  employee_no: string | null;
};
type DirectReport = ManagerCandidate;

export function ManagerEditCard({
  developerId,
  currentManagerId,
  canEdit,
}: {
  developerId: string;
  currentManagerId: string | null;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [selected, setSelected] = useState<string | null>(currentManagerId);

  useEffect(() => {
    setSelected(currentManagerId);
  }, [currentManagerId]);

  const { data: candidates = [] } = useQuery<ManagerCandidate[]>({
    queryKey: ["manager-candidates", developerId],
    queryFn: async () =>
      (
        await api.get("/developers/manager-candidates", {
          params: { exclude_id: developerId },
        })
      ).data,
    enabled: canEdit,
    staleTime: 60_000,
  });

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

  const dirty = selected !== currentManagerId;

  const saveM = useMutation({
    mutationFn: async () =>
      api.patch(`/developers/${developerId}`, { manager_id: selected }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["developer", developerId] });
      qc.invalidateQueries({ queryKey: ["approval-chain", developerId] });
      dialog.alert("상위 관리자가 갱신되었습니다.");
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "저장 실패";
      dialog.alert(detail, { title: "오류" });
    },
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">결재선 (상위 관리자)</h2>
        <span className="text-xs text-muted-foreground">
          모든 결재(휴가·출장·경비)의 1차 승인자
        </span>
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value || null)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm min-w-[14rem]"
          >
            <option value="">상위 관리자 없음 (대표/외부)</option>
            {currentManagerId &&
              !candidates.some((c) => c.id === currentManagerId) && (
                <option value={currentManagerId}>
                  (현재){" "}
                  {chain.find((c) => c.id === currentManagerId)?.name ??
                    currentManagerId}
                </option>
              )}
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.title ? ` · ${c.title}` : ""}
                {c.employee_no ? ` (${c.employee_no})` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={!dirty || saveM.isPending}
            className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            저장
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => setSelected(currentManagerId)}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted inline-flex items-center gap-1"
            >
              <RotateCcw className="h-3.5 w-3.5" /> 되돌리기
            </button>
          )}
        </div>
      ) : (
        <div className="text-sm">
          {chain[1] ? (
            `${chain[1].name}${chain[1].title ? ` · ${chain[1].title}` : ""}`
          ) : (
            <span className="text-muted-foreground">미설정</span>
          )}
          <span className="ml-2 text-xs text-muted-foreground">
            (HR/ADMIN 만 변경 가능)
          </span>
        </div>
      )}

      <ChainPreview chain={chain} reports={reports} />
    </section>
  );
}


// 결재선 체인 + 직속 부하 — 읽기 전용. 임직원 상세와 권한 관리 화면이 공유.
function ChainPreview({
  chain,
  reports,
}: {
  chain: ApprovalChainNode[];
  reports: DirectReport[];
}) {
  return (
    <>
      <div>
        <div className="text-xs text-muted-foreground mb-1">결재선 체인</div>
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
    </>
  );
}
