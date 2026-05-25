"use client";

/**
 * 메뉴 권한 매트릭스 — 역할(role) × 메뉴(menu_key) 의 가시성.
 *
 * 저장 방식: 전체 교체(PUT full map). 작은 매트릭스라 낙관적 부분 업데이트의
 * 복잡성을 피하고 '화면에 보이는 상태' 그대로를 서버에 푸시.
 *
 * ADMIN 열은 항상 체크되고 비활성 — 저장 시에도 필터 아웃되므로 DB 에 들어가지 않는다.
 * "변경 취소" 는 서버의 마지막 저장값으로 draft 를 되돌린다.
 *
 * 원래 settings/page.tsx 에 있던 컴포넌트를 권한 관리 메뉴(`/permissions`) 신설에
 * 맞춰 추출. 두 화면이 같은 컴포넌트를 공유하지는 않고, 새 메뉴에서만 사용.
 */

import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import {
  MENU_GROUP_ORDER,
  MENU_REGISTRY,
  SECURITY_ROLES,
  SECURITY_ROLE_LABEL,
  type SecurityRole,
} from "@/components/layout/menu-registry";

export function MenuPermissionsCard() {
  const qc = useQueryClient();
  const dialog = useDialog();
  // draft: null 이면 아직 서버 값이 로드되지 않은 상태. 로드 완료 후 1회 초기화.
  const [draft, setDraft] = useState<Record<string, Set<string>> | null>(null);
  const [saved, setSaved] = useState(false);

  const { data } = useQuery<Record<string, string[]>>({
    queryKey: ["menu-permissions"],
    queryFn: async () => (await api.get("/menu-permissions")).data,
  });

  useEffect(() => {
    if (data && draft === null) {
      const next: Record<string, Set<string>> = {};
      for (const m of MENU_REGISTRY) {
        next[m.key] = new Set(data[m.key] ?? []);
      }
      setDraft(next);
    }
  }, [data, draft]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const payload: Record<string, string[]> = {};
      for (const m of MENU_REGISTRY) {
        payload[m.key] = Array.from(draft[m.key] ?? []).filter(
          (r) => r !== "ADMIN",
        );
      }
      return (await api.put("/menu-permissions", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu-permissions"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", {
        title: "오류",
      });
    },
  });

  function toggle(menuKey: string, role: SecurityRole) {
    if (role === "ADMIN") return;
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = new Set(prev[menuKey] ?? []);
      if (cur.has(role)) cur.delete(role);
      else cur.add(role);
      return { ...prev, [menuKey]: cur };
    });
  }

  function resetToDefaults() {
    if (!data) return;
    const next: Record<string, Set<string>> = {};
    for (const m of MENU_REGISTRY) {
      next[m.key] = new Set(data[m.key] ?? []);
    }
    setDraft(next);
  }

  const grouped = MENU_GROUP_ORDER.map((g) => ({
    group: g,
    items: MENU_REGISTRY.filter((m) => m.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">메뉴 권한</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            역할별 사이드바 메뉴 표시 여부를 설정합니다. ADMIN 은 항상 모든
            메뉴를 볼 수 있습니다.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetToDefaults}
            disabled={!draft || saveM.isPending}
            className="h-9 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
          >
            변경 취소
          </button>
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={!draft || saveM.isPending}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {saveM.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
      {saved && (
        <div className="mb-2 text-xs text-emerald-600">저장되었습니다.</div>
      )}

      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-xs">
            <tr>
              <th className="text-left px-3 py-2 font-medium">메뉴</th>
              {SECURITY_ROLES.map((r) => (
                <th key={r} className="text-center px-3 py-2 font-medium whitespace-nowrap">
                  {SECURITY_ROLE_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.map((g) => (
              <Fragment key={g.group}>
                <tr className="bg-muted/30">
                  <td
                    colSpan={1 + SECURITY_ROLES.length}
                    className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground border-t border-border"
                  >
                    {g.group}
                  </td>
                </tr>
                {g.items.map((m) => (
                  <tr key={m.key} className="border-t border-border/60">
                    <td className="px-3 py-2">
                      <div className="font-medium">{m.label}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {m.href}
                      </div>
                    </td>
                    {SECURITY_ROLES.map((r) => {
                      const isAdmin = r === "ADMIN";
                      const checked =
                        isAdmin || (draft?.[m.key]?.has(r) ?? false);
                      return (
                        <td key={r} className="text-center px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isAdmin || !draft}
                            onChange={() => toggle(m.key, r)}
                            className="h-4 w-4 accent-primary disabled:opacity-60"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
