"use client";

/**
 * Settings > 북마크 — 회사 공용 북마크 CRUD (ADMIN/HR).
 *
 * 헤더 빠른 도구의 "공용 북마크" 탭에 노출되는 row. 메뉴 권한과 동일하게
 * SECURITY_ROLES 별 가시성 체크박스로 노출 대상 제한 (NULL/빈배열 = 전직원,
 * ADMIN 은 항상). 본 탭은 PERSONAL 북마크 미노출 — 그쪽은 헤더 드로어에서.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Save, Trash2 } from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import {
  SECURITY_ROLES,
  SECURITY_ROLE_LABEL,
  type SecurityRole,
} from "@/components/layout/menu-registry";

type Bookmark = {
  id: string;
  scope: "PERSONAL" | "COMPANY";
  category: string | null;
  label: string;
  url: string;
  info: string | null;
  visible_roles: string[] | null;
  // 정보 가시성: NULL = row 가시 사용자 전원, [] = 아무도, [role,…] = 그 role.
  info_visible_roles: string[] | null;
  sort_order: number;
  can_edit: boolean;
};

type NonAdminRole = Exclude<SecurityRole, "ADMIN">;

type FormState = {
  label: string;
  url: string;
  category: string;
  info: string;
  // ADMIN 은 항상 노출이라 매트릭스에 포함하지 않음. 비어있으면 전직원 노출.
  roles: Set<NonAdminRole>;
  // info_visible_roles UI 표현 — null 의미 (전직원 노출) 를 별도 플래그로:
  // info_all_visible=true → 저장 시 info_visible_roles=null
  // info_all_visible=false → 저장 시 info_visible_roles=[...info_roles]
  // 비어있고 false 면 [] (아무도 미노출 — default).
  info_all_visible: boolean;
  info_roles: Set<NonAdminRole>;
};

const EMPTY: FormState = {
  label: "",
  url: "",
  category: "",
  info: "",
  roles: new Set(),
  info_all_visible: false,
  info_roles: new Set(),
};

const NON_ADMIN_ROLES = SECURITY_ROLES.filter(
  (r) => r !== "ADMIN",
) as Exclude<SecurityRole, "ADMIN">[];

function normalizeUrl(s: string): string {
  const t = s.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return "https://" + t;
}

export function BookmarksTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: rows = [], isFetching } = useQuery<Bookmark[]>({
    queryKey: ["settings-bookmarks-company"],
    queryFn: async () =>
      (await api.get("/bookmarks", { params: { scope: "company" } })).data,
    staleTime: 30_000,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY);
    setAdding(true);
  }

  function startEdit(b: Bookmark) {
    setAdding(false);
    setEditingId(b.id);
    const ivr = b.info_visible_roles;
    setForm({
      label: b.label,
      url: b.url,
      category: b.category ?? "",
      info: b.info ?? "",
      roles: new Set(
        (b.visible_roles ?? []).filter(
          (r): r is NonAdminRole =>
            (NON_ADMIN_ROLES as string[]).includes(r),
        ),
      ),
      // null = 전직원 노출 (row 가시성과 동일), 그 외엔 명시 매트릭스.
      info_all_visible: ivr === null,
      info_roles: new Set(
        (ivr ?? []).filter(
          (r): r is NonAdminRole =>
            (NON_ADMIN_ROLES as string[]).includes(r),
        ),
      ),
    });
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
    setForm(EMPTY);
  }

  function buildPayload(): {
    label: string;
    url: string;
    category: string | null;
    info: string | null;
    visible_roles: string[] | null;
    info_visible_roles: string[] | null;
  } {
    // info_visible_roles 결정:
    // - "row 와 동일" 토글 ON → NULL (row 가시 사용자 전원에게 정보 노출)
    // - OFF → 명시 매트릭스. 단, info_roles ⊆ roles 강제 (UI 도 강제하지만 백엔드도
    //   정규화). roles 미체크 인 항목은 빠짐.
    let ivr: string[] | null;
    if (form.info_all_visible) {
      ivr = null;
    } else {
      const filtered = [...form.info_roles].filter((r) => form.roles.has(r));
      ivr = filtered;
    }
    return {
      label: form.label.trim(),
      url: normalizeUrl(form.url),
      category: form.category.trim() || null,
      info: form.info.trim() || null,
      visible_roles: form.roles.size > 0 ? [...form.roles] : null,
      info_visible_roles: ivr,
    };
  }

  const createM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/bookmarks", { scope: "COMPANY", ...buildPayload() })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-bookmarks-company"] });
      qc.invalidateQueries({ queryKey: ["bookmarks", "company"] });
      cancel();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const updateM = useMutation({
    mutationFn: async (id: string) =>
      (await api.patch(`/bookmarks/${id}`, buildPayload())).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-bookmarks-company"] });
      qc.invalidateQueries({ queryKey: ["bookmarks", "company"] });
      cancel();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/bookmarks/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-bookmarks-company"] });
      qc.invalidateQueries({ queryKey: ["bookmarks", "company"] });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  const inputCls =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">북마크 (공용)</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            헤더 빠른 도구의 "공용 북마크" 탭에 노출. 표시 대상은 역할별
            체크박스로 제한 — 모두 미체크 = 전직원 (+ ADMIN 항상).
          </p>
        </div>
        {!adding && editingId === null && (
          <button
            type="button"
            onClick={startCreate}
            className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3.5 w-3.5" />
            추가
          </button>
        )}
      </div>

      {(adding || editingId !== null) && (
        <div className="rounded-md border border-border bg-background p-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">표시명 *</span>
              <input
                autoFocus
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">카테고리</span>
              <input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">URL *</span>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="example.com 또는 https://..."
                className={inputCls}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                정보 (옵션, 로그인 정보 등)
              </span>
              <textarea
                value={form.info}
                onChange={(e) => setForm({ ...form, info: e.target.value })}
                rows={6}
                className={inputCls + " font-mono"}
              />
            </label>
          </div>

          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              표시 대상 역할 (모두 미체크 = 전직원)
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked
                  disabled
                  className="h-3.5 w-3.5 accent-primary"
                />
                {SECURITY_ROLE_LABEL.ADMIN}
                <span className="text-[10px]">(항상)</span>
              </label>
              {NON_ADMIN_ROLES.map((r) => (
                <label
                  key={r}
                  className="inline-flex items-center gap-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={form.roles.has(r)}
                    onChange={(e) =>
                      setForm((p) => {
                        const nextRoles = new Set(p.roles);
                        const nextInfoRoles = new Set(p.info_roles);
                        if (e.target.checked) {
                          nextRoles.add(r);
                        } else {
                          nextRoles.delete(r);
                          // visible_roles 미체크 시 info_roles 에서도 자동 해제
                          // (info_visible_roles ⊆ visible_roles 강제).
                          nextInfoRoles.delete(r);
                        }
                        return {
                          ...p,
                          roles: nextRoles,
                          info_roles: nextInfoRoles,
                        };
                      })
                    }
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {SECURITY_ROLE_LABEL[r]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>정보 표시 대상 역할 (모두 미체크 = 정보 미노출)</span>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form.info_all_visible}
                  onChange={(e) =>
                    setForm({ ...form, info_all_visible: e.target.checked })
                  }
                  className="h-3.5 w-3.5 accent-primary"
                />
                row 보는 사람 모두 노출
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked
                  disabled
                  className="h-3.5 w-3.5 accent-primary"
                />
                {SECURITY_ROLE_LABEL.ADMIN}
                <span className="text-[10px]">(항상)</span>
              </label>
              {NON_ADMIN_ROLES.map((r) => {
                // 부분집합 강제 — visible_roles 의 부분집합. roles 가 비어있으면
                // (전직원 공개) 모든 role 체크 가능. roles 에 값이 있으면 그
                // 안에 든 role 만 체크 가능.
                const inVisible =
                  form.roles.size === 0 || form.roles.has(r);
                const disabled = !inVisible || form.info_all_visible;
                return (
                  <label
                    key={r}
                    className={
                      "inline-flex items-center gap-1.5 text-xs " +
                      (disabled ? "text-muted-foreground/50" : "")
                    }
                    title={
                      !inVisible
                        ? "위의 표시 대상 역할에 체크되어야 선택 가능"
                        : form.info_all_visible
                          ? "'row 보는 사람 모두 노출' 이 켜져 있어 비활성화"
                          : ""
                    }
                  >
                    <input
                      type="checkbox"
                      checked={form.info_roles.has(r) && !disabled}
                      disabled={disabled}
                      onChange={(e) =>
                        setForm((p) => {
                          const next = new Set(p.info_roles);
                          if (e.target.checked) next.add(r);
                          else next.delete(r);
                          return { ...p, info_roles: next };
                        })
                      }
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    {SECURITY_ROLE_LABEL[r]}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
            >
              취소
            </button>
            <button
              type="button"
              disabled={
                !form.label.trim() ||
                !form.url.trim() ||
                createM.isPending ||
                updateM.isPending
              }
              onClick={() =>
                editingId ? updateM.mutate(editingId) : createM.mutate()
              }
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {editingId ? "수정" : "추가"}
            </button>
          </div>
        </div>
      )}

      {isFetching && rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          공용 북마크가 없습니다.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">표시명</th>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-left">URL</th>
                <th className="px-3 py-2 text-center">정보</th>
                <th className="px-3 py-2 text-left">표시 대상</th>
                <th className="px-3 py-2 text-right">작업</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{b.label}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {b.category ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[200px]">
                    {b.url}
                  </td>
                  <td className="px-3 py-2 text-center text-xs">
                    {b.info ? "✓" : "-"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {b.visible_roles && b.visible_roles.length > 0
                      ? b.visible_roles
                          .map(
                            (r) =>
                              SECURITY_ROLE_LABEL[r as SecurityRole] ?? r,
                          )
                          .join(", ")
                      : "전직원"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(b)}
                        title="편집"
                        aria-label="편집"
                        className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            await dialog.confirm(`"${b.label}" 을(를) 삭제하시겠습니까?`, {
                              destructive: true,
                            })
                          ) {
                            deleteM.mutate(b.id);
                          }
                        }}
                        title="삭제"
                        aria-label="삭제"
                        className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-destructive/40 bg-red-50 text-destructive hover:bg-red-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
