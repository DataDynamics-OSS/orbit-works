"use client";

/**
 * 수신자 입력 — Gmail 식 칩(badge) + 주소록 자동완성.
 *
 * 외부 계약은 "a@x.com, b@y.com" 콤마 문자열(value/onChange). 내부적으로는
 * 마지막 토큰(마지막 콤마 뒤)을 "입력 중" 으로 보고 나머지는 칩으로 렌더한다.
 *  - 콤마 입력 → 자동으로 칩 확정(문자열 분해 모델이 처리).
 *  - Enter/Tab/추천 선택 → 현재 입력을 칩으로 확정.
 *  - 칩의 X → 해당 주소만 한 번에 제거(글자단위 삭제 X).
 *  - 빈 입력에서 Backspace → 마지막 칩 제거.
 *  - 포커스 시 끝에 ", " 를 보장해 기존 주소를 건드리지 않고 새 주소를 추가.
 */

import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

export type AddressEntry = { name: string; email: string; source: string };

const SOURCE_LABEL: Record<string, string> = {
  user: "직원",
  contact: "고객",
  history: "이전",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RecipientInput({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: AddressEntry[];
  placeholder?: string;
  /** (호환용, 미사용 — 컨테이너 스타일은 내부에서 처리) */
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const parts = value.split(/[,;]/);
  const committed = parts.slice(0, -1).map((s) => s.trim()).filter(Boolean);
  const allChips = parts.map((s) => s.trim()).filter(Boolean);
  const editing = (parts[parts.length - 1] ?? "").replace(/^\s+/, "");
  const chips = focused ? committed : allChips;
  const inputVal = focused ? editing : "";

  const matches = useMemo(() => {
    const t = editing.toLowerCase();
    if (!focused || !t) return [];
    const present = new Set(allChips.map((c) => c.toLowerCase()));
    return suggestions
      .filter(
        (e) =>
          !present.has(e.email.toLowerCase()) &&
          (e.email.toLowerCase().includes(t) ||
            e.name.toLowerCase().includes(t)),
      )
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, editing, suggestions, value]);

  const showList = focused && matches.length > 0;

  function setEditing(text: string) {
    onChange([...committed, text].join(", "));
  }
  function commit(email: string) {
    const e = email.trim();
    const next = e ? [...committed, e] : committed;
    onChange(next.length ? next.join(", ") + ", " : "");
    setActive(0);
  }
  function removeAt(idx: number) {
    const list = chips.slice();
    list.splice(idx, 1);
    if (focused) {
      onChange((list.length ? list.join(", ") + ", " : "") + editing);
    } else {
      onChange(list.join(", "));
    }
    inputRef.current?.focus();
  }

  return (
    <div className="relative flex-1">
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex min-h-[34px] w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1 text-sm"
      >
        {chips.map((c, i) => {
          const invalid = !EMAIL_RE.test(c);
          return (
            <span
              key={`${c}-${i}`}
              title={c}
              className={
                "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs " +
                (invalid
                  ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                  : "bg-muted text-foreground")
              }
            >
              <span className="truncate">{c}</span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => removeAt(i)}
                className="shrink-0 text-muted-foreground hover:text-rose-600"
                aria-label={`${c} 제거`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={inputVal}
          placeholder={chips.length === 0 ? placeholder : ""}
          onFocus={() => {
            setFocused(true);
            if (value.trim() && !/[,;]\s*$/.test(value)) {
              onChange(value.trim() + ", ");
            }
          }}
          onBlur={() => {
            setFocused(false);
            setActive(0);
          }}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (showList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((a) =>
                e.key === "ArrowDown"
                  ? Math.min(a + 1, matches.length - 1)
                  : Math.max(a - 1, 0),
              );
            } else if (e.key === "Enter" || e.key === "Tab") {
              if (showList) {
                e.preventDefault();
                commit((matches[active] ?? matches[0]).email);
              } else if (editing.trim()) {
                e.preventDefault();
                commit(editing);
              }
            } else if (e.key === "Escape") {
              setFocused(false);
            } else if (e.key === "Backspace" && editing === "" && committed.length) {
              e.preventDefault();
              const rest = committed.slice(0, -1);
              onChange(rest.length ? rest.join(", ") + ", " : "");
            }
          }}
        />
      </div>
      {showList && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-card shadow-md">
          {matches.map((m, i) => (
            <button
              key={m.email}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(m.email)}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${
                i === active ? "bg-muted" : "hover:bg-muted"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                {m.name ? (
                  <>
                    <span className="font-medium">{m.name}</span>{" "}
                    <span className="text-muted-foreground">{m.email}</span>
                  </>
                ) : (
                  m.email
                )}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {SOURCE_LABEL[m.source] ?? m.source}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
