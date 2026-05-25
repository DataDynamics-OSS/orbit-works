"use client";

/**
 * 임직원의 보안등급(role) 설정.
 *
 * 원래 임직원 상세에 있던 SecurityRoleSection 을 권한 관리 메뉴 (탭: 결재선·보안등급)
 * 로 이동. ADMIN/HR 만 변경 가능 (백엔드 invariant).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

const SECURITY_ROLES = ["ADMIN", "SALES", "HR", "SUPPORT", "ETC"] as const;
type SecRole = (typeof SECURITY_ROLES)[number];
const SEC_ROLE_LABEL: Record<SecRole, string> = {
  ADMIN: "관리자",
  SALES: "영업",
  HR: "HR (관리)",
  SUPPORT: "지원",
  ETC: "기타",
};

export function SecurityRoleSection({ developerId }: { developerId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { data: dev } = useQuery<{ security_role: SecRole; name: string }>({
    queryKey: ["developer-sec-role", developerId],
    queryFn: async () => (await api.get(`/developers/${developerId}`)).data,
    staleTime: 30_000,
  });
  const [pending, setPending] = useState<SecRole | null>(null);

  const updateM = useMutation({
    mutationFn: async (role: SecRole) =>
      api.patch(`/developers/${developerId}`, { security_role: role }),
    onSuccess: async (_data, role) => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ["developer-sec-role", developerId] });
      qc.invalidateQueries({ queryKey: ["developer", developerId] });
      await dialog.alert(
        `역할을 ${SEC_ROLE_LABEL[role]} 으로 변경했습니다.`,
        { title: "완료" },
      );
    },
    onError: async (e: any) => {
      setPending(null);
      await dialog.alert(e?.response?.data?.detail ?? "변경 실패", {
        title: "오류",
      });
    },
  });

  const current = (pending ?? dev?.security_role ?? "ETC") as SecRole;
  const dirty = pending !== null && pending !== dev?.security_role;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold">보안등급</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            이 임직원이 로그인한 뒤 접근 가능한 메뉴·기능을 결정합니다. ADMIN/HR
            만 변경 가능하며, 마지막 ADMIN 은 해제할 수 없습니다.
          </p>
        </div>
      </header>
      <div className="px-4 py-3 flex items-center gap-2">
        <select
          value={current}
          onChange={(e) => setPending(e.target.value as SecRole)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[160px]"
        >
          {SECURITY_ROLES.map((r) => (
            <option key={r} value={r}>
              {SEC_ROLE_LABEL[r]} ({r})
            </option>
          ))}
        </select>
        {dirty && (
          <>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={updateM.isPending}
              onClick={() => updateM.mutate(current)}
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {updateM.isPending ? "적용 중…" : "저장"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
