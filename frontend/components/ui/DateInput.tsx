"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, X } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { ko } from "date-fns/locale";
import "react-day-picker/dist/style.css";
import { Tooltip } from "@/components/ui/Tooltip";

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  /** YYYY-MM-DD (inclusive) */
  min?: string;
  /** YYYY-MM-DD (inclusive) */
  max?: string;
  id?: string;
  /** 공란 허용시 'X' 클리어 버튼 노출 */
  clearable?: boolean;
};

// "20260420", "2026/04/20", "2026-4-20", "2026 04 20" → "2026-04-20"
// 유효하지 않으면 null.
function normalizeYmd(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  const date = new Date(`${y}-${m}-${d}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  // 월/일이 오버플로(예: 02-30 → 03-02) 되지 않았는지 역검증
  const yy = date.getFullYear();
  const mm = date.getMonth() + 1;
  const dd = date.getDate();
  if (yy !== Number(y) || mm !== Number(m) || dd !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

function parseYmd(value: string): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function DateInput({
  value,
  onChange,
  placeholder = "YYYY-MM-DD",
  className = "",
  disabled,
  required,
  min,
  max,
  id,
  clearable = true,
}: Props) {
  const [text, setText] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 부모 value 변경 → 로컬 text 동기화 (부모가 강제 reset 하는 경우)
  useEffect(() => {
    setText(value ?? "");
  }, [value]);

  // 외부 클릭 시 popup 닫기
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function commit(next: string) {
    // 빈 문자열은 clear 로 간주
    if (next === "") {
      onChange("");
      return;
    }
    const n = normalizeYmd(next);
    if (n) {
      onChange(n);
      setText(n);
    } else {
      // 복원
      setText(value ?? "");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(text);
      inputRef.current?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText(value ?? "");
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  }

  const selectedDate = parseYmd(value || text);
  const minDate = min ? parseYmd(min) : undefined;
  const maxDate = max ? parseYmd(max) : undefined;

  return (
    <div ref={wrapperRef} className="relative inline-block w-full">
      <div className={"relative flex items-center " + className}>
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => commit(text)}
          onKeyDown={handleKeyDown}
          className="w-full rounded-md border border-input bg-background pl-3 pr-14 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
        {clearable && text && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setText("");
              onChange("");
            }}
            className="absolute right-8 text-muted-foreground hover:text-foreground"
            aria-label="지우기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          className="group/tt absolute right-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
          aria-label="달력 열기"
        >
          <Calendar className="h-4 w-4" />
          <Tooltip label="달력 열기" side="bottom" inline />
        </button>
      </div>
      {open && (
        <div
          className="absolute z-50 mt-1 rounded-md border border-border bg-popover p-2 shadow-md"
          role="dialog"
        >
          <DayPicker
            mode="single"
            locale={ko}
            selected={selectedDate}
            defaultMonth={selectedDate}
            disabled={
              minDate || maxDate
                ? [
                    ...(minDate ? [{ before: minDate }] : []),
                    ...(maxDate ? [{ after: maxDate }] : []),
                  ]
                : undefined
            }
            onSelect={(d) => {
              if (d) {
                const v = fmtYmd(d);
                setText(v);
                onChange(v);
                setOpen(false);
              }
            }}
            showOutsideDays
            weekStartsOn={0}
          />
        </div>
      )}
    </div>
  );
}
