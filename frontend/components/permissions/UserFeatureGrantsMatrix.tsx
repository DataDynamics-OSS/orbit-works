"use client";

/**
 * 사용자별 추가 기능 권한 — 매트릭스 뷰 (rows: 임직원, cols: feature).
 *
 * - rows: FULL_TIME ACTIVE 임직원, 가나다순.
 * - cols: `/user-feature-grants/catalog` 의 GrantableFeature 전체.
 * - 셀: checkbox. 토글 시 POST(추가) 또는 DELETE(해제). menu grants 와 달리
 *   set replace 가 아닌 row 단위 add/remove API.
 *
 * 데이터:
 *   - /developers/directory?employment_type=FULL_TIME
 *   - /user-feature-grants/catalog
 *   - /user-feature-grants (user_id 미지정 → tenant 전체)
 */

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

type DeveloperRow = {
  id: string;
  name: string;
  user_id: string | null;
  status: string;
  employment_type: string;
};

type GrantableFeature = { feature_key: string; label: string };
type FeatureGrant = { user_id: string; feature_key: string; granted_at: string };

export function UserFeatureGrantsMatrix() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: developers = [] } = useQuery<DeveloperRow[]>({
    queryKey: ["developers", "list", "permissions"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: {
            employment_type: "FULL_TIME",
            status_filter: "ACTIVE",
          },
        })
      ).data,
    staleTime: 60_000,
  });

  const employees = useMemo(
    () =>
      developers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "ko-KR")),
    [developers],
  );

  const { data: catalog = [] } = useQuery<GrantableFeature[]>({
    queryKey: ["grantable-features"],
    queryFn: async () =>
      (await api.get("/user-feature-grants/catalog")).data,
    staleTime: 5 * 60_000,
  });

  const { data: grants = [] } = useQuery<FeatureGrant[]>({
    queryKey: ["user-feature-grants", "all"],
    queryFn: async () => (await api.get("/user-feature-grants")).data,
    staleTime: 30_000,
  });
  // {user_id: Set<feature_key>}.
  const grantSets = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const g of grants) {
      const s = m.get(g.user_id) ?? new Set<string>();
      s.add(g.feature_key);
      m.set(g.user_id, s);
    }
    return m;
  }, [grants]);

  const addM = useMutation({
    mutationFn: async ({
      userId,
      featureKey,
    }: {
      userId: string;
      featureKey: string;
    }) =>
      api.post("/user-feature-grants", {
        user_id: userId,
        feature_key: featureKey,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["user-feature-grants", "all"] }),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "부여 실패", { title: "오류" }),
  });
  const removeM = useMutation({
    mutationFn: async ({
      userId,
      featureKey,
    }: {
      userId: string;
      featureKey: string;
    }) => api.delete(`/user-feature-grants/${userId}/${featureKey}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["user-feature-grants", "all"] }),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "해제 실패", { title: "오류" }),
  });

  function toggle(userId: string, featureKey: string, on: boolean) {
    if (on) removeM.mutate({ userId, featureKey });
    else addM.mutate({ userId, featureKey });
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">사용자별 추가 권한 — 정규직 일괄</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          역할(role) 매트릭스 외에 개별 임직원에게 위임할 기능 권한을 체크하세요.
          매핑된 사용자 계정이 없는 임직원은 체크 불가 (회색).
        </p>
      </header>

      {catalog.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground text-center">
          현재 부여 가능한 기능이 없습니다.
        </div>
      ) : (
        <div className="overflow-auto max-h-[70vh] relative">
          <table className="text-[12px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-20 bg-muted/80 backdrop-blur">
              <tr>
                <th
                  className="sticky left-0 z-30 bg-muted px-3 py-1.5 text-left font-medium border-b border-r border-border"
                  style={{ minWidth: 160 }}
                >
                  임직원
                </th>
                {catalog.map((f) => (
                  <th
                    key={f.feature_key}
                    className="px-2 py-1 font-medium border-b border-r border-border whitespace-nowrap text-[11px]"
                    title={f.feature_key}
                  >
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && (
                <tr>
                  <td
                    colSpan={1 + catalog.length}
                    className="text-center px-3 py-6 text-sm text-muted-foreground"
                  >
                    표시할 임직원이 없습니다.
                  </td>
                </tr>
              )}
              {employees.map((emp) => {
                const uid = emp.user_id ?? null;
                const mySet = uid
                  ? (grantSets.get(uid) ?? new Set<string>())
                  : new Set<string>();
                const noUser = !uid;
                return (
                  <tr key={emp.id} className="hover:bg-muted/30">
                    <td
                      className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium border-b border-r border-border whitespace-nowrap"
                      title={
                        noUser
                          ? "로그인 가능한 사용자 계정이 없습니다."
                          : emp.name
                      }
                    >
                      {emp.name}
                      {noUser && (
                        <span className="ml-1 text-[10px] text-amber-600">
                          (계정 X)
                        </span>
                      )}
                    </td>
                    {catalog.map((f) => {
                      const on = mySet.has(f.feature_key);
                      const busyAdd =
                        addM.isPending &&
                        addM.variables?.userId === uid &&
                        addM.variables?.featureKey === f.feature_key;
                      const busyRm =
                        removeM.isPending &&
                        removeM.variables?.userId === uid &&
                        removeM.variables?.featureKey === f.feature_key;
                      return (
                        <td
                          key={f.feature_key}
                          className="text-center px-1 py-1 border-b border-r border-border/60"
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={noUser || busyAdd || busyRm}
                            onChange={() => uid && toggle(uid, f.feature_key, on)}
                            className="h-3.5 w-3.5 accent-primary disabled:opacity-40"
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
