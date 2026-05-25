"use client";

/**
 * 게시판 글의 보안 역할 노출 선택기.
 *
 * 비워두면(empty) 전체 공개. 한 개 이상 체크하면 그 role 만 볼 수 있음.
 * ADMIN 은 항상 모든 글을 볼 수 있어 picker 에서 제외.
 */

import {
  SECURITY_ROLE_LABEL,
  SECURITY_ROLES,
  SecurityRole,
} from "@/components/layout/menu-registry";

const SELECTABLE: SecurityRole[] = SECURITY_ROLES.filter((r) => r !== "ADMIN");

export function VisibleRolesPicker({
  value,
  onChange,
  className,
}: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  className?: string;
}) {
  const selected = new Set(value ?? []);
  function toggle(role: string) {
    const next = new Set(selected);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    const arr = Array.from(next);
    onChange(arr.length === 0 ? null : arr);
  }
  return (
    <div className={"rounded-md border border-border bg-card p-3 " + (className ?? "")}>
      <div className="text-sm font-semibold mb-1">공개 대상 (보안 역할)</div>
      <div className="text-[11px] text-muted-foreground mb-2">
        비워두면 모든 사용자에게 공개됩니다. ADMIN 은 항상 볼 수 있습니다.
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SELECTABLE.map((r) => {
          const checked = selected.has(r);
          return (
            <label
              key={r}
              className={
                "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs cursor-pointer " +
                (checked
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-muted")
              }
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(r)}
                className="h-3.5 w-3.5"
              />
              {SECURITY_ROLE_LABEL[r]}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 게시글 상세에서 visible_roles 를 배지로 표시.
 *
 * `roles` 가 NULL/empty 이면 "전체 공개" 배지, 값 있으면 각 role 별 배지 + ADMIN.
 */
export function VisibleRolesBadges({
  roles,
}: {
  roles: string[] | null | undefined;
}) {
  if (!roles || roles.length === 0) {
    return (
      <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
        전체 공개
      </span>
    );
  }
  // ADMIN 은 늘 볼 수 있어 자동 포함된 것처럼 표시 (단, 시각적으로 구분).
  const displayed = [...roles, "ADMIN"];
  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      {displayed.map((r) => {
        const isAdmin = r === "ADMIN";
        return (
          <span
            key={r}
            className={
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] " +
              (isAdmin
                ? "border-purple-200 bg-purple-50 text-purple-700"
                : "border-primary/30 bg-primary/5 text-primary")
            }
            title={isAdmin ? "ADMIN 은 모든 글을 볼 수 있습니다" : undefined}
          >
            {SECURITY_ROLE_LABEL[r as SecurityRole] ?? r}
            {isAdmin && <span className="ml-0.5 text-[9px]">(자동)</span>}
          </span>
        );
      })}
    </div>
  );
}
