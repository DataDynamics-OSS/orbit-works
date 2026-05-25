"use client";

/**
 * 공항 IATA autocomplete — IATA / 도시 / 공항명 부분일치.
 *
 * 선택 시 IATA(3 letter) 만 부모로 전달. TZ 매핑은 부모가 `findAirport()` 로 수행.
 */

import { useEffect, useRef, useState } from "react";
import { searchAirports, findAirport, type Airport } from "@/lib/airports";

export function AirportPicker({
  value,
  onChange,
  placeholder = "IATA / 도시 / 공항명",
}: {
  value: string;
  onChange: (iata: string) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<Airport[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // 외부에서 value 가 IATA 로 주어지면 표시 라벨도 그에 맞춰 동기화.
  useEffect(() => {
    const a = findAirport(value);
    setQ(a ? `${a.iata} – ${a.city}` : value);
  }, [value]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function handleInput(v: string) {
    setQ(v);
    setMatches(searchAirports(v));
    setOpen(true);
  }

  function pick(a: Airport) {
    onChange(a.iata);
    setQ(`${a.iata} – ${a.city}`);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <input
        value={q}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={() => {
          if (matches.length === 0 && q) setMatches(searchAirports(q));
          setOpen(true);
        }}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {open && matches.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-popover shadow-lg">
          {matches.map((a) => (
            <li
              key={a.iata}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-muted"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold">
                  {a.iata}
                </span>
                <span className="text-xs text-muted-foreground">{a.tz}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {a.city} · {a.country} — {a.name}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
