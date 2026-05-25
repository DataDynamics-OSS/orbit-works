"use client";

/**
 * Creatable Combobox — 드롭다운 + 자유 타이핑 + 새 값 추가.
 *
 * 동작:
 *  - input 에 타이핑하면 옵션 목록을 substring 매칭으로 필터.
 *  - 매칭되는 옵션이 없거나 사용자가 새 값을 원하면 마지막 항목 "+ 새로 추가" 클릭.
 *  - value 는 현재 텍스트 (label). 부모는 onChange 로 받아 폼 상태 관리.
 *  - 백엔드가 lookup-or-create 처리하므로 클라이언트는 label 만 전달.
 */

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronDown, Plus, X } from "lucide-react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** 새 값을 입력하는 것을 허용할지. true = "+ 새로 추가" 옵션 노출. */
  allowCreate?: boolean;
};

export function Combobox({
  value,
  onChange,
  options,
  placeholder = "선택 또는 입력",
  disabled = false,
  className,
  allowCreate = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 외부에서 value 갱신되면 query 도 sync.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // 바깥 클릭으로 닫기.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
        // 입력은 있지만 옵션 미선택이면 입력값 그대로 commit.
        if (query !== value) onChange(query);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, query, value, onChange]);

  const lower = query.trim().toLowerCase();
  const filtered = options.filter((o) => o.toLowerCase().includes(lower));
  const exact = options.some((o) => o.toLowerCase() === lower);
  const showCreate = allowCreate && query.trim() && !exact;

  function commit(v: string) {
    setQuery(v);
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={wrapperRef} className={clsx("relative", className)}>
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length === 1) commit(filtered[0]);
              else if (showCreate) commit(query.trim());
              else if (exact) commit(query.trim());
            } else if (e.key === "Escape") {
              setOpen(false);
              setQuery(value);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="h-9 w-full rounded-md border border-input bg-background pl-3 pr-14 text-sm disabled:opacity-50"
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => commit("")}
            className="absolute right-7 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="지우기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center text-muted-foreground"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-md max-h-60 overflow-auto">
          {filtered.length === 0 && !showCreate && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              일치하는 항목 없음
            </div>
          )}
          {filtered.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => commit(o)}
              className={clsx(
                "block w-full text-left px-3 py-2 text-sm hover:bg-muted",
                o === value && "bg-muted/60 font-medium",
              )}
            >
              {o}
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              onClick={() => commit(query.trim())}
              className="block w-full text-left px-3 py-2 text-sm text-primary hover:bg-muted border-t border-border inline-flex items-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />새로 추가: "{query.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
