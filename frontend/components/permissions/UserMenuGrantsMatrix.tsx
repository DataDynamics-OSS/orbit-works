"use client";

/**
 * 사용자별 추가 메뉴 — 매트릭스 뷰 (rows: 임직원, cols: 메뉴).
 *
 * - rows: FULL_TIME ACTIVE 임직원, 가나다순.
 * - cols: MENU_REGISTRY 전체. MENU_GROUP_ORDER 별로 column-group 헤더로 묶음.
 * - 셀: checkbox. 토글 시 그 user 의 grant set 전체를 PUT (backend API 가
 *   set replace 만 지원).
 * - 좌측 임직원 열 sticky, 헤더 sticky. wide 매트릭스라 가로 스크롤.
 *
 * 데이터:
 *   - /developers?employment_type=FULL_TIME&status_filter=ACTIVE → 임직원 + user_id.
 *     (directory endpoint 는 user_id 미포함이라 풀 endpoint 사용.)
 *   - /user-menu-grants/all → {user_id: [menu_key]} 전체 batch.
 *
 * PUT 시 user_id 가 없는(매핑 안 된) 임직원은 토글 불가 — 셀 disabled + tooltip.
 */

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import {
  MENU_GROUP_ORDER,
  MENU_REGISTRY,
} from "@/components/layout/menu-registry";

type DeveloperRow = {
  id: string;
  name: string;
  user_id: string | null;
  status: string;
  employment_type: string;
};

export function UserMenuGrantsMatrix() {
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

  // 가나다순.
  const employees = useMemo(
    () =>
      developers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "ko-KR")),
    [developers],
  );

  // tenant 전체 grants — {user_id: Set<menu_key>}.
  const grantsQ = useQuery<Record<string, string[]>>({
    queryKey: ["user-menu-grants", "all"],
    queryFn: async () => (await api.get("/user-menu-grants/all")).data,
    staleTime: 30_000,
  });
  const grantSets = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [uid, keys] of Object.entries(grantsQ.data ?? {})) {
      m.set(uid, new Set(keys));
    }
    return m;
  }, [grantsQ.data]);

  const saveM = useMutation({
    mutationFn: async ({ userId, keys }: { userId: string; keys: string[] }) =>
      (await api.put(`/user-menu-grants/${userId}`, keys)).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["user-menu-grants", "all"] }),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  // 컬럼 그룹 — 메뉴 가시화 + tax_invoices.dashboard 같이 key 가 점(.)을 포함한
  // 항목도 그대로 노출.
  const grouped = MENU_GROUP_ORDER.map((g) => ({
    group: g,
    items: MENU_REGISTRY.filter((m) => m.group === g),
  })).filter((g) => g.items.length > 0);

  function toggle(userId: string, menuKey: string, currentOn: boolean) {
    const set = new Set(grantSets.get(userId) ?? []);
    if (currentOn) set.delete(menuKey);
    else set.add(menuKey);
    saveM.mutate({ userId, keys: Array.from(set) });
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">사용자별 추가 메뉴 — 정규직 일괄</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          역할(role) 매트릭스에 더해 개별 임직원에게 추가 노출할 사이드바 메뉴를
          체크하세요. 매핑된 사용자 계정이 없는 임직원은 체크 불가 (회색).
        </p>
      </header>

      <div className="overflow-auto max-h-[70vh] relative">
        <table className="text-[12px] border-separate border-spacing-0">
          <thead className="sticky top-0 z-20 bg-muted/80 backdrop-blur">
            {/* group row */}
            <tr>
              <th
                className="sticky left-0 z-30 bg-muted px-3 py-1.5 text-left font-medium border-b border-r border-border"
                rowSpan={2}
                style={{ minWidth: 160 }}
              >
                임직원
              </th>
              {grouped.map((g) => (
                <th
                  key={g.group}
                  colSpan={g.items.length}
                  className="px-2 py-1 text-center text-[11px] uppercase tracking-wide text-muted-foreground border-b border-r border-border bg-muted/60"
                >
                  {g.group}
                </th>
              ))}
            </tr>
            {/* menu row */}
            <tr>
              {grouped.map((g) => (
                <Fragment key={g.group}>
                  {g.items.map((m) => (
                    <th
                      key={m.key}
                      className="px-2 py-1 font-medium border-b border-r border-border whitespace-nowrap text-[11px]"
                      title={m.key}
                    >
                      {m.label}
                    </th>
                  ))}
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 && (
              <tr>
                <td
                  colSpan={1 + MENU_REGISTRY.length}
                  className="text-center px-3 py-6 text-sm text-muted-foreground"
                >
                  표시할 임직원이 없습니다.
                </td>
              </tr>
            )}
            {employees.map((emp) => {
              const uid = emp.user_id ?? null;
              const mySet = uid ? (grantSets.get(uid) ?? new Set<string>()) : new Set<string>();
              const noUser = !uid;
              return (
                <tr key={emp.id} className="hover:bg-muted/30">
                  <td
                    className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium border-b border-r border-border whitespace-nowrap"
                    title={noUser ? "로그인 가능한 사용자 계정이 없습니다." : emp.name}
                  >
                    {emp.name}
                    {noUser && (
                      <span className="ml-1 text-[10px] text-amber-600">
                        (계정 X)
                      </span>
                    )}
                  </td>
                  {grouped.map((g) => (
                    <Fragment key={g.group}>
                      {g.items.map((m) => {
                        const on = mySet.has(m.key);
                        const busy =
                          saveM.isPending &&
                          saveM.variables?.userId === uid;
                        return (
                          <td
                            key={m.key}
                            className="text-center px-1 py-1 border-b border-r border-border/60"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={noUser || busy}
                              onChange={() => uid && toggle(uid, m.key, on)}
                              className="h-3.5 w-3.5 accent-primary disabled:opacity-40"
                            />
                          </td>
                        );
                      })}
                    </Fragment>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
