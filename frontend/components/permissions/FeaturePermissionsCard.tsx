"use client";

/**
 * 기능 권한 매트릭스 — menu 내부의 버튼·필드·탭 단위 통제.
 *
 * `FEATURE_REGISTRY` 의 menuKey 별로 그룹핑. 첫 그룹만 자동 펼침 (관리 매트릭스가
 * 길어서 한 번에 다 보여주면 부담).
 *
 * 저장 방식: 전체 교체 PUT — MenuPermissionsCard 와 동일 패턴.
 *
 * 원래 settings/page.tsx 에 있던 컴포넌트를 권한 관리 메뉴(`/permissions`) 신설에
 * 맞춰 추출.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import {
  MENU_REGISTRY,
  SECURITY_ROLES,
  SECURITY_ROLE_LABEL,
  type SecurityRole,
} from "@/components/layout/menu-registry";
import { FEATURE_REGISTRY } from "@/components/layout/feature-registry";

export function FeaturePermissionsCard() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [draft, setDraft] = useState<Record<string, Set<string>> | null>(null);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data } = useQuery<Record<string, string[]>>({
    queryKey: ["feature-permissions"],
    queryFn: async () => (await api.get("/feature-permissions")).data,
  });

  useEffect(() => {
    if (data && draft === null) {
      const next: Record<string, Set<string>> = {};
      for (const f of FEATURE_REGISTRY) {
        next[f.key] = new Set(data[f.key] ?? []);
      }
      setDraft(next);
      const firstMenuKey = FEATURE_REGISTRY[0]?.menuKey;
      if (firstMenuKey) setExpanded({ [firstMenuKey]: true });
    }
  }, [data, draft]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const payload: Record<string, string[]> = {};
      for (const f of FEATURE_REGISTRY) {
        payload[f.key] = Array.from(draft[f.key] ?? []).filter(
          (r) => r !== "ADMIN",
        );
      }
      return (await api.put("/feature-permissions", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feature-permissions"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", {
        title: "오류",
      });
    },
  });

  function toggle(featureKey: string, role: SecurityRole) {
    if (role === "ADMIN") return;
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = new Set(prev[featureKey] ?? []);
      if (cur.has(role)) cur.delete(role);
      else cur.add(role);
      return { ...prev, [featureKey]: cur };
    });
  }

  function resetToDefaults() {
    if (!data) return;
    const next: Record<string, Set<string>> = {};
    for (const f of FEATURE_REGISTRY) {
      next[f.key] = new Set(data[f.key] ?? []);
    }
    setDraft(next);
  }

  const groupedByMenu = useMemo(() => {
    const byMenu = new Map<string, typeof FEATURE_REGISTRY>();
    for (const f of FEATURE_REGISTRY) {
      const arr = byMenu.get(f.menuKey) ?? [];
      arr.push(f);
      byMenu.set(f.menuKey, arr);
    }
    return Array.from(byMenu.entries()).map(([menuKey, items]) => ({
      menuKey,
      menuLabel: MENU_REGISTRY.find((m) => m.key === menuKey)?.label ?? menuKey,
      items,
    }));
  }, []);

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">기능 권한</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            메뉴 내부의 버튼·필드·탭에 대한 역할별 허용 여부를 설정합니다.
            ADMIN 은 항상 모든 기능을 사용할 수 있습니다. 본인 데이터(자기 여권·
            연락처) 는 권한과 무관하게 항상 본인이 열람할 수 있습니다.
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
              <th className="text-left px-3 py-2 font-medium">기능</th>
              {SECURITY_ROLES.map((r) => (
                <th key={r} className="text-center px-3 py-2 font-medium whitespace-nowrap">
                  {SECURITY_ROLE_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupedByMenu.map((g) => {
              const open = expanded[g.menuKey] ?? false;
              return (
                <Fragment key={g.menuKey}>
                  <tr className="bg-muted/30">
                    <td
                      colSpan={1 + SECURITY_ROLES.length}
                      className="px-3 py-1.5 border-t border-border cursor-pointer select-none"
                      onClick={() =>
                        setExpanded((p) => ({ ...p, [g.menuKey]: !open }))
                      }
                    >
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground mr-2">
                        {open ? "▼" : "▶"} {g.menuLabel}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        ({g.items.length}개 기능)
                      </span>
                    </td>
                  </tr>
                  {open &&
                    g.items.map((f) => (
                      <tr key={f.key} className="border-t border-border/60">
                        <td className="px-3 py-2">
                          <div className="font-medium">{f.label}</div>
                          {f.description && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {f.description}
                            </div>
                          )}
                          <div className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">
                            {f.key}
                          </div>
                        </td>
                        {SECURITY_ROLES.map((r) => {
                          const isAdmin = r === "ADMIN";
                          const checked =
                            isAdmin || (draft?.[f.key]?.has(r) ?? false);
                          return (
                            <td key={r} className="text-center px-3 py-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={isAdmin || !draft}
                                onChange={() => toggle(f.key, r)}
                                className="h-4 w-4 accent-primary disabled:opacity-60"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
