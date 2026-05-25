"use client";

/**
 * 마인드맵 유틸 — 레이아웃·트리 탐색·히스토리·내보내기 헬퍼.
 *
 * 트리 탐색은 nodes 의 connectivity 를 edges 로 계산. 마인드맵은 단일 부모를
 * 가정하지만, 사용자가 핸들 드래그로 다중 입력 엣지를 만들 수도 있으므로
 * 형제·자식 탐색은 첫 번째 입력 엣지 기준으로 단순화 처리.
 */

import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

// ---------------------------------------------------------------------------
// 색상 팔레트 (5색 + default)
// ---------------------------------------------------------------------------

export type ColorKey =
  | "default"
  | "slate"
  | "red"
  | "orange"
  | "amber"
  | "lime"
  | "emerald"
  | "teal"
  | "sky"
  | "indigo"
  | "violet"
  | "rose";

export const COLOR_PALETTE: Record<
  ColorKey,
  { bg: string; border: string; text: string; label: string }
> = {
  default: { bg: "#ffffff", border: "#cbd5e1", text: "#0f172a", label: "기본" },
  slate:   { bg: "#f1f5f9", border: "#94a3b8", text: "#0f172a", label: "회색" },
  red:     { bg: "#fee2e2", border: "#f87171", text: "#7f1d1d", label: "빨강" },
  orange:  { bg: "#ffedd5", border: "#fb923c", text: "#7c2d12", label: "주황" },
  amber:   { bg: "#fef3c7", border: "#fbbf24", text: "#78350f", label: "황색" },
  lime:    { bg: "#ecfccb", border: "#a3e635", text: "#365314", label: "라임" },
  emerald: { bg: "#d1fae5", border: "#34d399", text: "#065f46", label: "초록" },
  teal:    { bg: "#ccfbf1", border: "#2dd4bf", text: "#134e4a", label: "청록" },
  sky:     { bg: "#e0f2fe", border: "#38bdf8", text: "#0c4a6e", label: "하늘" },
  indigo:  { bg: "#e0e7ff", border: "#818cf8", text: "#312e81", label: "남보라" },
  violet:  { bg: "#ede9fe", border: "#a78bfa", text: "#4c1d95", label: "보라" },
  rose:    { bg: "#ffe4e6", border: "#fb7185", text: "#881337", label: "분홍" },
};

// ---------------------------------------------------------------------------
// Edge style
// ---------------------------------------------------------------------------

export type EdgeStyleKey = "bezier" | "straight" | "step" | "smoothstep";

export const EDGE_STYLE_LABEL: Record<EdgeStyleKey, string> = {
  bezier: "곡선",
  smoothstep: "꺾인 곡선",
  step: "꺾은선",
  straight: "직선",
};

// ---------------------------------------------------------------------------
// 트리 탐색
// ---------------------------------------------------------------------------

/** 노드의 부모 ID — 첫 번째 입력 엣지 기준. 없으면 null. */
export function parentOf(nodeId: string, edges: Edge[]): string | null {
  for (const e of edges) {
    if (e.target === nodeId) return e.source;
  }
  return null;
}

/** 노드의 직속 자식 ID 리스트. */
export function childrenOf(nodeId: string, edges: Edge[]): string[] {
  return edges.filter((e) => e.source === nodeId).map((e) => e.target);
}

/** 노드의 자손 전체 (BFS). 자기 자신은 미포함. */
export function descendantsOf(nodeId: string, edges: Edge[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...childrenOf(nodeId, edges)];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...childrenOf(id, edges));
  }
  return visited;
}

/** 루트 노드들 — 입력 엣지가 없는 노드. */
export function rootIds(nodes: Node[], edges: Edge[]): string[] {
  const hasParent = new Set(edges.map((e) => e.target));
  return nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
}

/** node.id → parent.id 맵 (없으면 missing). */
export function buildParentMap(edges: Edge[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of edges) {
    if (!m.has(e.target)) m.set(e.target, e.source);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 자동 레이아웃 — dagre
// ---------------------------------------------------------------------------

const NODE_W = 160;
const NODE_H = 48;

export function autoLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
): Node[] {
  if (nodes.length === 0) return nodes;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 30, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  return nodes.map((n) => {
    const p = g.node(n.id);
    if (!p) return n;
    return {
      ...n,
      // dagre 는 중심좌표를 반환 — xyflow 는 좌상단 좌표라 보정.
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
    };
  });
}

// ---------------------------------------------------------------------------
// 방향키 노드 이동 — 인접 노드 중 가장 가까운 후보 선택
// ---------------------------------------------------------------------------

export function nearestInDirection(
  current: Node,
  candidates: Node[],
  dir: "left" | "right" | "up" | "down",
): Node | null {
  const cx = current.position.x;
  const cy = current.position.y;
  let best: Node | null = null;
  let bestScore = Infinity;
  for (const n of candidates) {
    if (n.id === current.id) continue;
    const dx = n.position.x - cx;
    const dy = n.position.y - cy;
    let inDir = false;
    if (dir === "right") inDir = dx > 5;
    else if (dir === "left") inDir = dx < -5;
    else if (dir === "down") inDir = dy > 5;
    else if (dir === "up") inDir = dy < -5;
    if (!inDir) continue;
    // 점수 = 진행축 거리 + 직각축 페널티(2배)
    const main = Math.abs(dir === "left" || dir === "right" ? dx : dy);
    const cross = Math.abs(dir === "left" || dir === "right" ? dy : dx);
    const score = main + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 외부 export 형식
// ---------------------------------------------------------------------------

type LabelOf = (id: string) => string;

/** 트리 → Markdown outline 문자열. */
export function toMarkdownOutline(
  nodes: Node[],
  edges: Edge[],
  labelOf: LabelOf,
): string {
  const roots = rootIds(nodes, edges);
  const lines: string[] = [];
  const visited = new Set<string>();

  const walk = (id: string, depth: number) => {
    if (visited.has(id)) return; // 사이클 방어
    visited.add(id);
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${labelOf(id) || "(빈 노드)"}`);
    for (const child of childrenOf(id, edges)) {
      walk(child, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  // 누락 노드 (사이클·고립) 보강
  for (const n of nodes) if (!visited.has(n.id)) walk(n.id, 0);
  return lines.join("\n");
}

/** 트리 → OPML XML 문자열 (XMind/MindMeister 호환). */
export function toOPML(
  nodes: Node[],
  edges: Edge[],
  labelOf: LabelOf,
  title = "Mindmap",
): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const visited = new Set<string>();
  const lines: string[] = [];

  const walk = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const indent = "  ".repeat(depth + 2);
    const label = escape(labelOf(id) || "(빈 노드)");
    const kids = childrenOf(id, edges);
    if (kids.length === 0) {
      lines.push(`${indent}<outline text="${label}"/>`);
      return;
    }
    lines.push(`${indent}<outline text="${label}">`);
    for (const c of kids) walk(c, depth + 1);
    lines.push(`${indent}</outline>`);
  };

  const roots = rootIds(nodes, edges);
  for (const r of roots) walk(r, 0);
  for (const n of nodes) if (!visited.has(n.id)) walk(n.id, 0);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head><title>${escape(title)}</title></head>`,
    `  <body>`,
    ...lines,
    `  </body>`,
    `</opml>`,
  ].join("\n");
}

/** 데이터 다운로드 트리거 — 클립보드/저장 모두 활용. */
export function downloadFile(
  filename: string,
  content: string | Blob,
  mime = "text/plain;charset=utf-8",
): void {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
