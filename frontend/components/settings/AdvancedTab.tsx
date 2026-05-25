"use client";

/**
 * Tier 3 — 고급 설정 (디렉터리 제외만 tenant 별).
 *
 * 시스템 전역 설정은 SUPER_ADMIN 영역으로 이동:
 * - JWT 만료 / 업로드 한도 / 로그 레벨 → /admin/system-settings
 * - 환율 / ECOS / FRED → /admin/data-sources
 *
 * "제외" 섹션:
 * - `directory.excluded_developer_ids` 의 편집 UI. 여기 등록된 임직원은
 *   주소록·할당·자산·보험 등 모든 picker 에서 자동 숨김된다
 *   (`/developers?include_hidden=false`).
 * - Employees·Payroll 페이지는 `include_hidden=true` 로 호출하므로 영향 없음.
 * - 숨김 후보 목록을 뽑을 때는 "이미 숨겨진 직원도 보여야" 다시 해제할 수 있으므로
 *   드롭다운 내 `/developers` 호출은 `include_hidden=true` 로 한다.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, X } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";
import { api } from "@/lib/api";
import { sortDevelopersKo } from "@/lib/sort-developers";

type DirectoryForm = { excluded_developer_ids: string[] };

type DeveloperLite = {
  id: string;
  name: string;
  tag?: string | null;
  status?: string | null;
  employment_type?: string | null;
};

export function AdvancedTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: dirCur } = useQuery<DirectoryForm>({
    queryKey: ["settings", "directory"],
    queryFn: () => fetchSection("directory"),
  });
  // 숨김 후보를 고르려면 이미 숨겨진 직원도 보여야 하므로 include_hidden=true.
  const { data: devList } = useQuery<DeveloperLite[]>({
    queryKey: ["developers", "all-for-directory-exclude"],
    queryFn: async () =>
      (await api.get("/developers", { params: { include_hidden: true } })).data,
    staleTime: 60_000,
  });

  const [dir, setDir] = useState<DirectoryForm | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (dirCur) setDir({ excluded_developer_ids: dirCur.excluded_developer_ids ?? [] });
  }, [dirCur]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (dir) await saveSection("directory", dir);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["developers"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" });
    },
  });

  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const ready = dir;

  const devById = useMemo(() => {
    const map = new Map<string, DeveloperLite>();
    (devList ?? []).forEach((d) => map.set(d.id, d));
    return map;
  }, [devList]);

  const sortedDevs = useMemo(
    () => sortDevelopersKo(devList ?? []),
    [devList],
  );

  if (!ready) return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;

  return (
    <div className="space-y-4">

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">제외 (주소록·picker 에서 숨김)</h3>
          <details className="relative">
            <summary className="h-9 inline-flex items-center px-3 rounded-md border border-border bg-background text-sm cursor-pointer select-none list-none marker:hidden [&::-webkit-details-marker]:hidden">
              임직원 추가
            </summary>
            <div className="absolute top-full right-0 z-20 mt-1 w-[320px] max-h-[360px] overflow-auto rounded-md border border-border bg-popover p-2 shadow-lg">
              {sortedDevs.length === 0 ? (
                <div className="text-xs text-muted-foreground p-2">불러오는 중…</div>
              ) : (
                sortedDevs.map((d) => {
                  const checked = dir!.excluded_developer_ids.includes(d.id);
                  const inactive = d.status && d.status !== "ACTIVE";
                  return (
                    <label
                      key={d.id}
                      className="flex items-center gap-2 py-1 text-sm cursor-pointer hover:bg-muted rounded px-2"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setDir((prev) => {
                            if (!prev) return prev;
                            const next = new Set(prev.excluded_developer_ids);
                            if (e.target.checked) next.add(d.id);
                            else next.delete(d.id);
                            return { excluded_developer_ids: Array.from(next) };
                          });
                        }}
                      />
                      <span className="flex-1 truncate">
                        {d.name}
                        {d.tag ? <span className="text-muted-foreground"> · {d.tag}</span> : null}
                      </span>
                      {inactive && (
                        <span className="text-[10px] text-muted-foreground">퇴사</span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </details>
        </div>
        <HelperText>
          여기에 포함된 임직원은 주소록·할당·자산 등 모든 picker 에서 자동 숨김됩니다.
          Employees·Payroll 페이지 및 과거 이력(급여·할당·보험)은 영향 없음.
          퇴사자는 이 리스트와 무관하게 주소록(직원/프리랜서 탭)에서 자동 제외됩니다.
        </HelperText>
        <div className="flex flex-wrap gap-1.5">
          {dir!.excluded_developer_ids.length === 0 ? (
            <span className="text-xs text-muted-foreground">선택된 임직원 없음</span>
          ) : (
            dir!.excluded_developer_ids.map((id) => {
              const d = devById.get(id);
              const label = d ? `${d.name}${d.tag ? ` · ${d.tag}` : ""}` : id;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                >
                  {label}
                  <button
                    type="button"
                    onClick={() =>
                      setDir((prev) =>
                        prev
                          ? {
                              excluded_developer_ids: prev.excluded_developer_ids.filter(
                                (x) => x !== id,
                              ),
                            }
                          : prev,
                      )
                    }
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="제거"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })
          )}
        </div>
      </section>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={saveM.isPending}
          className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saveM.isPending ? "저장 중..." : "모두 저장"}
        </button>
        {saved && <span className="text-xs text-emerald-600">저장되었습니다.</span>}
      </div>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const cls = colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function HelperText({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-muted-foreground">{children}</span>;
}
