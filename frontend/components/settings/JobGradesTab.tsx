"use client";

/**
 * Settings → 직위 / 직책 — 결재선 라우팅의 hierarchy 마스터.
 *
 * 두 마스터는 같은 shape (이름, level, 활성, 정렬). UI 도 공유 컴포넌트로 묶어
 * 두 endpoint 만 갈아끼움.
 *
 * - 직위 (Rank)    — 모든 임직원이 1개씩. /job-ranks
 * - 직책 (Position) — 선택적 job role. /job-positions
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

type Grade = {
  id: string;
  name: string;
  level: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  years: number | null;   // 진급 기준 연차 — '직위별 총 경력 분포' 차트 가이드
};

type GradeKind = "rank" | "position";
const ENDPOINT: Record<GradeKind, string> = {
  rank: "/job-ranks",
  position: "/job-positions",
};
const QUERY_KEY: Record<GradeKind, string> = {
  rank: "job-ranks",
  position: "job-positions",
};

export function JobGradesTab() {
  const [sub, setSub] = useState<GradeKind>("rank");

  return (
    <section className="space-y-3">
      {/* 직위 / 직책 sub-tab */}
      <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5 w-fit">
        <SubTabButton active={sub === "rank"} onClick={() => setSub("rank")}>
          직위
        </SubTabButton>
        <SubTabButton
          active={sub === "position"}
          onClick={() => setSub("position")}
        >
          직책
        </SubTabButton>
      </div>

      <GradeMaster kind={sub} />
    </section>
  );
}

function SubTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-7 rounded px-3 text-sm transition-colors " +
        (active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted")
      }
    >
      {children}
    </button>
  );
}

function GradeMaster({ kind }: { kind: GradeKind }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [includeInactive, setIncludeInactive] = useState(false);

  const { data: rows = [] } = useQuery<Grade[]>({
    queryKey: [QUERY_KEY[kind], includeInactive],
    queryFn: async () =>
      (
        await api.get(ENDPOINT[kind], {
          params: { include_inactive: includeInactive },
        })
      ).data,
  });

  const [draft, setDraft] = useState<{
    name: string;
    level: string;
    description: string;
    years: string;
  }>({ name: "", level: "", description: "", years: "" });

  const createM = useMutation({
    mutationFn: async () => {
      const lvl = parseFloat(draft.level);
      if (!draft.name.trim() || isNaN(lvl)) {
        throw new Error("이름과 level 을 입력해 주세요.");
      }
      const yrs = draft.years.trim() === "" ? null : parseInt(draft.years, 10);
      return api.post(ENDPOINT[kind], {
        name: draft.name.trim(),
        level: lvl,
        description: draft.description || null,
        years: yrs && yrs > 0 ? yrs : null,
      });
    },
    onSuccess: () => {
      setDraft({ name: "", level: "", description: "", years: "" });
      qc.invalidateQueries({ queryKey: [QUERY_KEY[kind]] });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  const patchM = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Grade>;
    }) => api.patch(`${ENDPOINT[kind]}/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QUERY_KEY[kind]] }),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`${ENDPOINT[kind]}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QUERY_KEY[kind]] }),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  const label = kind === "rank" ? "직위" : "직책";

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-semibold">{label} 마스터</h2>
        <label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          비활성 포함
        </label>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        {kind === "rank"
          ? "모든 임직원이 1개씩 보유하는 career grade. 결재선의 기본 hierarchy."
          : "선택적 job role (팀장 / 본부장 / CEO 등). 결재 룰의 명시 직책에 사용."}
        {" "}
        <b>level</b> 이 높을수록 상위. 사이 추가가 가능하도록 sparse 100 단위 권장.
        {kind === "rank" && (
          <>
            {" "}
            <b>연차</b> = 「직위별 총 경력 분포」 차트의 가이드 라인 (승진 기준).
            빈 값이면 차트에 표시 안 함.
          </>
        )}
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground border-b">
            <th className="py-1.5 pr-3 font-medium">이름</th>
            <th className="py-1.5 pr-3 font-medium tabular-nums">Level</th>
            <th className="py-1.5 pr-3 font-medium">설명</th>
            {/* 연차 — 헤더 라벨 없이 input 만 노출 (요청대로). */}
            <th className="py-1.5 pr-3 w-20"></th>
            <th className="py-1.5 pr-3 font-medium w-24">활성</th>
            <th className="py-1.5 w-16"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              onPatch={(patch) => patchM.mutate({ id: r.id, patch })}
              onDelete={async () => {
                const ok = await dialog.confirm(
                  <span>
                    <b>{r.name}</b> {label}을(를) 삭제하시겠습니까?
                  </span>,
                  {
                    title: `${label} 삭제`,
                    confirmText: "삭제",
                    destructive: true,
                  },
                );
                if (ok) deleteM.mutate(r.id);
              }}
            />
          ))}
          <tr className="border-t-2 border-border bg-muted/20">
            <td className="py-1.5 pr-3">
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={kind === "rank" ? "예: 주임연구원" : "예: 부서장"}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
            </td>
            <td className="py-1.5 pr-3">
              <input
                type="number"
                step="0.01"
                value={draft.level}
                onChange={(e) => setDraft({ ...draft, level: e.target.value })}
                placeholder="예: 250"
                className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
              />
            </td>
            <td className="py-1.5 pr-3">
              <input
                type="text"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="설명 (선택)"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
            </td>
            <td className="py-1.5 pr-3">
              <input
                type="number"
                min={1}
                max={99}
                value={draft.years}
                onChange={(e) => setDraft({ ...draft, years: e.target.value })}
                placeholder="연차"
                className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
              />
            </td>
            <td className="py-1.5 pr-3 text-muted-foreground">—</td>
            <td className="py-1.5 text-right">
              <button
                type="button"
                onClick={() => createM.mutate()}
                disabled={createM.isPending || !draft.name || !draft.level}
                className="h-8 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-4 min-w-[5.5rem] text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> 추가
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Row({
  row,
  onPatch,
  onDelete,
}: {
  row: Grade;
  onPatch: (patch: Partial<Grade>) => void;
  onDelete: () => void;
}) {
  // DB 가 NUMERIC(8,2) 라 응답은 "100.00" 같은 trailing-zero 형식. JS Number()
  // 로 한 번 통과시켜 정수면 "100", 소수면 "100.5" 형태로 정리.
  const initialLevel = String(Number(row.level));
  const initialYears = row.years == null ? "" : String(row.years);
  const [name, setName] = useState(row.name);
  const [level, setLevel] = useState(initialLevel);
  const [desc, setDesc] = useState(row.description ?? "");
  const [years, setYears] = useState(initialYears);

  const dirty =
    name !== row.name ||
    level !== initialLevel ||
    desc !== (row.description ?? "") ||
    years !== initialYears;

  function commit() {
    if (!dirty) return;
    const lvl = parseFloat(level);
    if (!name.trim() || isNaN(lvl)) return;
    const yrs = years.trim() === "" ? null : parseInt(years, 10);
    onPatch({
      name: name.trim(),
      level: lvl,
      description: desc || null,
      years: yrs && yrs > 0 ? yrs : null,
    });
  }

  return (
    <tr className={"border-b last:border-0 " + (row.is_active ? "" : "opacity-60")}>
      <td className="py-1.5 pr-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-8 w-full rounded-md border border-transparent hover:border-input focus:border-input bg-transparent focus:bg-background px-2 text-sm"
        />
      </td>
      <td className="py-1.5 pr-3">
        <input
          type="number"
          step="0.01"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-8 w-24 rounded-md border border-transparent hover:border-input focus:border-input bg-transparent focus:bg-background px-2 text-sm tabular-nums"
        />
      </td>
      <td className="py-1.5 pr-3">
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-8 w-full rounded-md border border-transparent hover:border-input focus:border-input bg-transparent focus:bg-background px-2 text-sm"
        />
      </td>
      <td className="py-1.5 pr-3">
        <input
          type="number"
          min={1}
          max={99}
          value={years}
          onChange={(e) => setYears(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          placeholder="연차"
          title="진급 기준 연차 — 빈 값이면 차트 가이드 라인에 표시 안 함"
          className="h-8 w-20 rounded-md border border-transparent hover:border-input focus:border-input bg-transparent focus:bg-background px-2 text-sm tabular-nums"
        />
      </td>
      <td className="py-1.5 pr-3">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={row.is_active}
            onChange={(e) => onPatch({ is_active: e.target.checked })}
          />
          {row.is_active ? "활성" : "비활성"}
        </label>
      </td>
      <td className="py-1.5 text-right">
        <button
          type="button"
          onClick={onDelete}
          aria-label="삭제"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
