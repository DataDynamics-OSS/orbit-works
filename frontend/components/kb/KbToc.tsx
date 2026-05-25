"use client";

/**
 * KB 사이드 목차 패널 — 회의록의 MeetingNoteToc 패턴 차용.
 *
 * 부모가 TipTap 본문 HTML 에서 추출한 heading 목록을 받아 sticky nav 로 노출.
 * 클릭 시 viewer/editor 컨테이너 안 해당 element 로 smooth scroll + 일시 하이라이트.
 *
 * heading 없으면 빈 상태 안내. 패널 표시/숨김은 부모가 토글 (localStorage 영속).
 */

import { useCallback } from "react";
import { ListOrdered, X } from "lucide-react";

export type KbHeading = { id: string; text: string; level: number };

type Props = {
  headings: KbHeading[];
  onClose: () => void;
  /** 패널 폭(px). 미지정 시 240. 부모가 드래그로 변경한 값. */
  width?: number;
};

export function KbToc({ headings, onClose, width = 240 }: Props) {
  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
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
          본문에 제목(Heading) 을 추가하면 여기에 목차가 표시됩니다.
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

/**
 * TipTap body HTML 에서 heading 추출.
 * 결과: [{ id, text, level }]. id 는 인덱스 기반 (kb-h-0, kb-h-1, ...).
 * 부모가 이 id 를 본문 컨테이너 안 같은 heading 에 setAttribute("id") 로 부여.
 */
export function extractKbHeadings(html: string | null | undefined): KbHeading[] {
  if (!html) return [];
  if (typeof document === "undefined") return [];
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const nodes = tmp.querySelectorAll("h1,h2,h3,h4,h5,h6");
  return Array.from(nodes).map((el, i) => ({
    id: `kb-h-${i}`,
    text: (el.textContent || "").trim(),
    level: parseInt(el.tagName.slice(1), 10),
  }));
}

/**
 * 본문 컨테이너 ref 안의 heading 들에 인덱스 기반 id 를 부여.
 * useEffect 안에서 body 변경 마다 호출. extractKbHeadings 와 id 규칙 일치.
 */
export function applyHeadingIds(root: HTMLElement | null): void {
  if (!root) return;
  const nodes = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
  nodes.forEach((el, i) => {
    el.id = `kb-h-${i}`;
  });
}
