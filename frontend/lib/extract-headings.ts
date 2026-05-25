/**
 * 본문 컨테이너 (TipTap viewer 등) 의 DOM 에서 heading 목록 추출.
 *
 * 각 heading 에 id 가 없으면 텍스트로 slug 를 만들어 부여 → TOC 클릭 시
 * scrollIntoView 가 동작. 동일 slug 가 여러 번 나오면 자동으로 -2, -3 …
 * suffix.
 *
 * 한글·기호도 그대로 유지하면서 anchor 로 쓸 수 있는 형태로만 손질
 * (공백·연속 하이픈 압축, 처음/끝 하이픈 trim).
 */

export type TocItem = { id: string; level: number; text: string };

export function extractHeadings(container: HTMLElement | null): TocItem[] {
  if (!container) return [];
  const nodes = container.querySelectorAll<HTMLHeadingElement>(
    "h1, h2, h3, h4, h5, h6",
  );
  const items: TocItem[] = [];
  const used = new Set<string>();
  nodes.forEach((el) => {
    const text = (el.textContent ?? "").trim();
    let id = el.id;
    if (!id) {
      id = uniquify(slugify(text || "section"), used);
      el.id = id;
    } else {
      used.add(id);
    }
    used.add(id);
    // data-toc-id 도 함께 — TocPanel 의 다단계 룩업에서 fallback 으로 사용.
    el.dataset.tocId = id;
    items.push({
      id,
      level: Number(el.tagName.slice(1)) || 1,
      text,
    });
  });
  return items;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s ]+/g, "-")     // whitespace → hyphen
    .replace(/[?#/\\]/g, "")          // anchor·path 와 충돌하는 기호 제거
    .replace(/-+/g, "-")              // 연속 하이픈 압축
    .replace(/^-+|-+$/g, "")          // 처음/끝 하이픈 제거
    .slice(0, 80) || "section";
}

function uniquify(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}
