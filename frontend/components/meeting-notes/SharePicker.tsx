"use client";

/**
 * 회의록 공유 직원 선택 — 이벤트 페이지의 `ParticipantsSection` 동일 패턴.
 *
 * - 상단: 선택 인원수 + "직원 추가" 토글 버튼
 * - 선택된 직원: chip(이름) 리스트, X 클릭으로 제거
 * - picker 패널(토글): 검색 입력 + 후보 직원 버튼 그리드, 클릭 시 즉시 추가
 *   (이미 선택된 직원과 작성자(excludeIds) 는 후보에서 자동 제외)
 */

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

export type ShareDev = {
  id: string;
  name: string;
  title?: string | null;
};

type Props = {
  developers: ShareDev[];
  excludeIds?: string[];      // 작성자 등 항상 후보에서 제외해야 할 id
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  helpText?: string;
  /** 패널을 항상 펼친 상태로 둘지 (기본 false — 토글) */
  defaultOpen?: boolean;
};

export function SharePicker({
  developers,
  excludeIds = [],
  selectedIds,
  setSelectedIds,
  helpText,
  defaultOpen = false,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(defaultOpen);
  const [pickerQuery, setPickerQuery] = useState("");

  const byId = useMemo(() => {
    const m = new Map<string, ShareDev>();
    for (const d of developers) m.set(d.id, d);
    return m;
  }, [developers]);

  const candidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const excluded = new Set([...excludeIds, ...selectedIds]);
    return developers
      .filter((d) => !excluded.has(d.id))
      .filter((d) => {
        if (!q) return true;
        return [d.name, d.title].filter(Boolean).join(" ").toLowerCase().includes(q);
      });
  }, [developers, excludeIds, selectedIds, pickerQuery]);

  function add(id: string) {
    if (selectedIds.includes(id)) return;
    setSelectedIds([...selectedIds, id]);
  }
  function remove(id: string) {
    setSelectedIds(selectedIds.filter((x) => x !== id));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          선택된 직원 {selectedIds.length}명
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          직원 추가
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {selectedIds.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">선택된 직원 없음</span>
        ) : (
          selectedIds.map((id) => {
            const d = byId.get(id);
            const label = d?.name ?? "(직원)";
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-primary/30 bg-primary/5 text-xs"
              >
                {label}
                {d?.title && (
                  <span className="text-[10px] text-muted-foreground">
                    · {d.title}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => remove(id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })
        )}
      </div>

      {pickerOpen && (
        <div className="rounded-md border border-border p-3 bg-muted/10 space-y-2">
          <input
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="이름·직함 검색…"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            autoFocus
          />
          <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
            {candidates.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                {pickerQuery
                  ? "검색 결과 없음"
                  : "추가 가능한 직원이 없습니다."}
              </span>
            ) : (
              candidates.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    add(d.id);
                    setPickerQuery("");
                  }}
                  className="px-2 py-1 rounded border border-border bg-background hover:bg-muted text-xs"
                >
                  {d.name}
                  {d.title && (
                    <span className="text-[10px] text-muted-foreground ml-1">
                      · {d.title}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {helpText && (
        <div className="text-xs text-muted-foreground">{helpText}</div>
      )}
    </div>
  );
}
