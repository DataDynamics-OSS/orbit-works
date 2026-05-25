"use client";

/**
 * 회의록 사이드 목차 패널.
 *
 * 부모가 MeetingNoteEditor 에서 추출한 heading 목록을 받아 sticky nav
 * 로 노출. 클릭 시 BlockNote 가 렌더한 해당 블록 DOM 으로 smooth scroll.
 *
 * heading 이 없으면 빈 상태 안내. 패널 자체의 표시/숨김은 부모가 토글 prop
 * (onClose) 으로 제어 — 토글 상태는 페이지가 localStorage 에 저장.
 */

import { useCallback } from "react";
import { ListOrdered, X } from "lucide-react";
import type { TocItem } from "./MeetingNoteEditor";

type Props = {
  headings: TocItem[];
  onClose: () => void;
  /** 패널 폭 (px). 미지정 시 240px. 부모가 드래그로 변경한 값 주입. */
  width?: number;
};

export function MeetingNoteToc({ headings, onClose, width = 240 }: Props) {
  const scrollTo = useCallback((id: string) => {
    // BlockNote 는 각 블록 wrapper 에 data-id="..." 부여.
    const el =
      document.querySelector<HTMLElement>(`[data-id="${id}"]`) ??
      document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // 일시 하이라이트 — outline ring 으로 위치 인지.
    el.style.transition = "background-color .25s ease";
    const prev = el.style.backgroundColor;
    el.style.backgroundColor = "rgba(59,130,246,0.10)";
    setTimeout(() => {
      el.style.backgroundColor = prev;
    }, 900);
  }, []);

  return (
    <aside
      className="shrink-0 border-l border-border bg-card overflow-auto"
      style={{ width: `${width}px` }}
    >
      <div className="sticky top-0 bg-card z-10 flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <ListOrdered className="h-3.5 w-3.5" />
          목차
          {headings.length > 0 && (
            <span className="text-muted-foreground font-normal">
              ({headings.length})
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="목차 닫기"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {headings.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground leading-relaxed">
          본문에 제목(Heading)을 추가하면 여기에 목차가 표시됩니다.
          <br />
          슬래시 메뉴에서 <code className="px-1 rounded bg-muted">/h1</code>~
          <code className="px-1 rounded bg-muted">/h6</code> 입력.
        </div>
      ) : (
        <ul className="p-2 flex flex-col gap-0.5">
          {headings.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => scrollTo(h.id)}
                title={h.text || "(제목 없음)"}
                style={{ paddingLeft: 8 + (Math.max(1, h.level) - 1) * 12 }}
                className={
                  "w-full text-left rounded px-2 py-1 hover:bg-muted truncate transition-colors text-sm " +
                  (h.level === 1
                    ? "font-semibold"
                    : h.level === 2
                      ? "font-medium"
                      : "text-muted-foreground")
                }
              >
                {h.text || (
                  <span className="italic text-muted-foreground/60">
                    (제목 없음)
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
