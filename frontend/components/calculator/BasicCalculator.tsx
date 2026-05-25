"use client";

/**
 * macOS 스타일 일반 계산기.
 *
 * 상태 머신:
 *   display: 화면에 보이는 raw 숫자 문자열 ('0', '12', '3.14')
 *   accum: 누적 피연산자 (이전 결과). null = 신규 입력 중.
 *   op: 보류 중인 연산자.
 *   waiting: 다음 숫자 입력 시 display 를 새로 시작할지.
 *   history: 디스플레이 위 작은 보조 줄 ('123 +', '123 + 4 =').
 *
 * 키보드:
 *   0-9, .  → 입력
 *   + - * / → 연산자
 *   Enter / = → 평가
 *   Backspace → 마지막 자리 삭제
 *   Esc / c / C → AC (전체 클리어)
 *   %        → 100 으로 나누기
 *
 * 키 listener 는 active prop 일 때만 활성 (탭이 계산기일 때만).
 * focus 가 input/textarea 인 상황은 무시.
 */

import { useCallback, useEffect, useState } from "react";

type Op = "+" | "−" | "×" | "÷";

const KEY_OP: Record<string, Op> = {
  "+": "+",
  "-": "−",
  "*": "×",
  "/": "÷",
};

function evalOp(a: number, b: number, op: Op): number {
  switch (op) {
    case "+": return a + b;
    case "−": return a - b;
    case "×": return a * b;
    case "÷": return b === 0 ? NaN : a / b;
  }
}

// 표시용 포맷 — 정수는 콤마, 소수는 trailing zero 정리. 부동소수점 누적
// 오차는 12자리에서 반올림 후 제거.
function formatNumber(n: number): string {
  if (!isFinite(n)) return "Error";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) {
    return n.toLocaleString("en-US");
  }
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  const [intPart, decPart] = s.split(".");
  const intFmt = Number(intPart).toLocaleString("en-US");
  return decPart !== undefined ? `${intFmt}.${decPart}` : intFmt;
}

// 사용자가 직접 입력한 raw 문자열 ("123", "0.5") → display 콤마 포맷.
function commafy(raw: string): string {
  if (raw === "Error") return raw;
  const negative = raw.startsWith("-");
  const abs = negative ? raw.slice(1) : raw;
  const [intPart, decPart] = abs.split(".");
  const intNum = intPart === "" ? 0 : Number(intPart);
  const intFmt = intNum.toLocaleString("en-US");
  return (negative ? "-" : "") + intFmt + (decPart !== undefined ? `.${decPart}` : "");
}

export function BasicCalculator({ active }: { active: boolean }) {
  const [display, setDisplay] = useState("0");
  const [accum, setAccum] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [history, setHistory] = useState("");

  const inputDigit = useCallback((d: string) => {
    setDisplay((cur) => {
      if (waiting) return d;
      if (cur === "0") return d;
      // 너무 긴 입력은 무시 (16자리).
      if (cur.replace(/[^\d]/g, "").length >= 16) return cur;
      return cur + d;
    });
    if (waiting) setWaiting(false);
  }, [waiting]);

  const inputDecimal = useCallback(() => {
    setDisplay((cur) => {
      if (waiting) return "0.";
      return cur.includes(".") ? cur : cur + ".";
    });
    if (waiting) setWaiting(false);
  }, [waiting]);

  const performOp = useCallback((newOp: Op) => {
    const cur = parseFloat(display);
    if (accum === null || waiting) {
      setAccum(cur);
      setHistory(`${formatNumber(cur)} ${newOp}`);
    } else if (op) {
      const result = evalOp(accum, cur, op);
      setAccum(result);
      setDisplay(formatNumber(result));
      setHistory(`${formatNumber(result)} ${newOp}`);
    }
    setOp(newOp);
    setWaiting(true);
  }, [accum, display, op, waiting]);

  const equals = useCallback(() => {
    if (op === null || accum === null) return;
    const cur = parseFloat(display);
    const result = evalOp(accum, cur, op);
    setHistory(`${formatNumber(accum)} ${op} ${formatNumber(cur)} =`);
    setDisplay(formatNumber(result));
    setAccum(null);
    setOp(null);
    setWaiting(true);
  }, [accum, display, op]);

  const clear = useCallback(() => {
    setDisplay("0");
    setAccum(null);
    setOp(null);
    setWaiting(false);
    setHistory("");
  }, []);

  const negate = useCallback(() => {
    setDisplay((cur) => {
      if (cur === "0") return cur;
      return cur.startsWith("-") ? cur.slice(1) : "-" + cur;
    });
  }, []);

  const percent = useCallback(() => {
    const v = parseFloat(display);
    setDisplay(formatNumber(v / 100));
  }, [display]);

  const backspace = useCallback(() => {
    setDisplay((cur) => {
      if (cur.length <= 1 || (cur.length === 2 && cur.startsWith("-"))) return "0";
      return cur.slice(0, -1);
    });
  }, []);

  // 글로벌 키보드 리스너 — active 일 때만, input/textarea focus 시는 무시.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const key = e.key;
      if (key >= "0" && key <= "9") {
        inputDigit(key);
        e.preventDefault();
      } else if (key === ".") {
        inputDecimal();
        e.preventDefault();
      } else if (KEY_OP[key]) {
        performOp(KEY_OP[key]);
        e.preventDefault();
      } else if (key === "Enter" || key === "=") {
        equals();
        e.preventDefault();
      } else if (key === "Backspace") {
        backspace();
        e.preventDefault();
      } else if (key === "Escape" || key === "c" || key === "C") {
        // Esc 또는 c/C — macOS 계산기와 동일하게 AC 동작.
        clear();
        e.preventDefault();
      } else if (key === "%") {
        percent();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, inputDigit, inputDecimal, performOp, equals, backspace, clear, percent]);

  return (
    <div className="flex flex-col gap-2">
      {/* 디스플레이 */}
      <div className="bg-zinc-900 text-white rounded-lg p-3 flex flex-col items-end justify-end h-[88px]">
        <div className="text-[11px] text-zinc-400 h-4 truncate w-full text-right tabular-nums">
          {history}&nbsp;
        </div>
        <div className="text-3xl font-light tabular-nums truncate w-full text-right">
          {display.includes(",") ? display : commafy(display)}
        </div>
      </div>

      {/* 버튼 그리드 — gap 8, 정사각 (h ≈ w). 너비는 부모(드로어) 따라감. */}
      <div className="grid grid-cols-4 gap-1.5">
        <CalcBtn variant="fn" onClick={clear}>AC</CalcBtn>
        <CalcBtn variant="fn" onClick={negate}>±</CalcBtn>
        <CalcBtn variant="fn" onClick={percent}>%</CalcBtn>
        <CalcBtn variant="op" active={op === "÷" && waiting} onClick={() => performOp("÷")}>÷</CalcBtn>

        <CalcBtn onClick={() => inputDigit("7")}>7</CalcBtn>
        <CalcBtn onClick={() => inputDigit("8")}>8</CalcBtn>
        <CalcBtn onClick={() => inputDigit("9")}>9</CalcBtn>
        <CalcBtn variant="op" active={op === "×" && waiting} onClick={() => performOp("×")}>×</CalcBtn>

        <CalcBtn onClick={() => inputDigit("4")}>4</CalcBtn>
        <CalcBtn onClick={() => inputDigit("5")}>5</CalcBtn>
        <CalcBtn onClick={() => inputDigit("6")}>6</CalcBtn>
        <CalcBtn variant="op" active={op === "−" && waiting} onClick={() => performOp("−")}>−</CalcBtn>

        <CalcBtn onClick={() => inputDigit("1")}>1</CalcBtn>
        <CalcBtn onClick={() => inputDigit("2")}>2</CalcBtn>
        <CalcBtn onClick={() => inputDigit("3")}>3</CalcBtn>
        <CalcBtn variant="op" active={op === "+" && waiting} onClick={() => performOp("+")}>+</CalcBtn>

        <CalcBtn onClick={() => inputDigit("0")} className="col-span-2">0</CalcBtn>
        <CalcBtn onClick={inputDecimal}>.</CalcBtn>
        <CalcBtn variant="op" onClick={equals}>=</CalcBtn>
      </div>
    </div>
  );
}

function CalcBtn({
  children,
  onClick,
  variant = "num",
  active,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "num" | "fn" | "op";
  active?: boolean;
  className?: string;
}) {
  const base =
    "h-12 rounded-md text-base font-medium select-none transition-colors active:scale-[.98]";
  const tone =
    variant === "op"
      ? active
        ? "bg-white text-orange-500 ring-2 ring-orange-500 hover:bg-orange-50"
        : "bg-orange-500 text-white hover:bg-orange-600"
      : variant === "fn"
        ? "bg-zinc-300 text-zinc-900 hover:bg-zinc-400/90 dark:bg-zinc-700 dark:text-white dark:hover:bg-zinc-600"
        : "bg-zinc-200 text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-white dark:hover:bg-zinc-700";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${tone} ${className}`}
    >
      {children}
    </button>
  );
}
