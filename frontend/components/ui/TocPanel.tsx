"use client";

/**
 * 본문 옆 sticky 목차 패널 (게시판·공지 등).
 *
 * 부모는 본문 컨테이너 (TipTap viewer 등) 에서 heading 을 추출해 (예:
 * `extractHeadings`) 이 컴포넌트에 전달. 클릭 시 해당 heading id 의
 * DOM 으로 smooth scroll + 일시 하이라이트.
 *
 * 회의록의 MeetingNoteToc 와 동일 톤이며, 회의록은 BlockNote 의
 * `data-id` 를 직접 사용하므로 별도 컴포넌트 유지. 본 컴포넌트는 표준
 * `id` 속성으로 anchor.
 */

import { useCallback } from "react";
import { ListOrdered, X } from "lucide-react";

import type { TocItem } from "@/lib/extract-headings";

type Props = {
  headings: TocItem[];
  onClose?: () => void;
  /** 좁은 화면에서도 잘 들어가도록 폭 옵션 (Tailwind 클래스). 기본 w-60.
   *  `width` (픽셀) 이 지정되면 그쪽이 우선. */
  widthClass?: string;
  /** 픽셀 단위 폭. 드래그 separator(TocResizer) 와 같이 쓰는 경우 지정. */
  width?: number;
};

export function TocPanel({ headings, onClose, widthClass = "w-60", width }: Props) {
  // 다단계 룩업 — 동적으로 부여한 id 가 어떤 이유(예: dangerouslySetInnerHTML
  // 가 다시 set 되어 attr 이 사라짐)로 끊겼을 때를 위한 fallback 포함.
  //   1) document.getElementById(id)
  //   2) [data-toc-id="…"] (extractHeadings 가 함께 설정해 둠)
  //   3) 페이지의 모든 h1~h6 을 walk → 텍스트 일치하는 첫 항목, 발견 시 id 재부여
  const scrollTo = useCallback((id: string, text?: string) => {
    let el: HTMLElement | null = document.getElementById(id);
    if (!el) {
      el = document.querySelector<HTMLElement>(
        `[data-toc-id="${CSS.escape(id)}"]`,
      );
    }
    if (!el && text) {
      const all = document.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6",
      );
      const trimmed = text.trim();
      for (let i = 0; i < all.length; i += 1) {
        const h = all[i];
        if ((h.textContent ?? "").trim() === trimmed) {
          el = h;
          if (!el.id) el.id = id;
          el.dataset.tocId = id;
          break;
        }
      }
    }
    if (!el) return;
    const target = el; // 클로저 캡처 — setTimeout 콜백 안에서 타입 안정.
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    // 위치 인지를 위한 일시 하이라이트.
    const prev = target.style.backgroundColor;
    target.style.transition = "background-color .25s ease";
    target.style.backgroundColor = "rgba(59,130,246,0.10)";
    setTimeout(() => {
      target.style.backgroundColor = prev;
    }, 900);
  }, []);

  return (
    <aside
      // width(px) 지정 시 inline style 로 폭 고정 (resizer 와 함께 사용).
      // 미지정 시 widthClass(Tailwind) 적용 — 기존 호출자 호환성 유지.
      style={width != null ? { width } : undefined}
      className={
        (width != null ? "" : widthClass + " ") +
        "shrink-0 border-l border-border bg-card overflow-auto"
      }
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
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="목차 닫기"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {headings.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground leading-relaxed">
          본문에 제목(Heading) 이 없습니다. 작성 시 H1·H2·H3 으로 구분된
          제목을 사용하면 여기에 목차가 표시됩니다.
        </div>
      ) : (
        <ul className="p-2 flex flex-col gap-0.5">
          {headings.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => scrollTo(h.id, h.text)}
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
