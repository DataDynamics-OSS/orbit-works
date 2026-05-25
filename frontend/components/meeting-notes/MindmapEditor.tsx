"use client";

/**
 * 회의록 마인드맵 (P3-Lite) — A/B/C 등급 기능 통합.
 *
 * 키보드:
 * - Tab            : 선택 노드의 자식 추가 + 자동 편집 진입
 * - Shift+Tab      : 선택 노드의 형제 추가 (부모의 자식으로)
 * - Enter          : 선택 노드 라벨 편집 시작
 * - Esc            : 편집 종료 / 선택 해제 / 검색 닫기
 * - ↑↓←→          : 인접 노드로 선택 이동
 * - Backspace/Del  : 선택 노드/엣지 삭제
 * - Ctrl/Cmd+Z     : Undo
 * - Ctrl/Cmd+Shift+Z 또는 Ctrl/Cmd+Y : Redo
 * - Ctrl/Cmd+F     : 검색 열기
 * - Ctrl/Cmd+S     : 즉시 저장 (브라우저 저장 다이얼로그 차단)
 *
 * 노드 데이터:
 * - label, color, task/taskDone, url(hyperlink), memo, image, collapsed
 *
 * 협업(P3-Full) 전환 시: state setter 를 Y.Map binding 으로 교체, 이 컴포넌트는
 * 그대로 유지 가능.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as htmlToImage from "html-to-image";
import jsPDF from "jspdf";
import {
  Bold,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileImage,
  FileText as FileTextIcon,
  Image as ImageIcon,
  Layout,
  Link as LinkIcon,
  ListTree,
  Palette,
  Pencil,
  Plus,
  Redo2,
  Search,
  Settings2,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  Handle,
  Position,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { compressImageToDataUrl } from "@/lib/image-compress";
import {
  COLOR_PALETTE,
  EDGE_STYLE_LABEL,
  type ColorKey,
  type EdgeStyleKey,
  autoLayout,
  buildParentMap,
  childrenOf,
  descendantsOf,
  downloadFile,
  nearestInDirection,
  parentOf,
  rootIds,
  toMarkdownOutline,
  toOPML,
} from "./mindmap-utils";

type Viewport = { x: number; y: number; zoom: number };
type MindmapData = {
  nodes: Node[];
  edges: Edge[];
  // 마지막 저장 시점의 캔버스 카메라 (pan + zoom). 다시 열 때 같은 화면을 복원
  // 하기 위함. 없으면 원점·100% 기본값.
  viewport?: Viewport;
};

import type { MutableRefObject } from "react";

type Props = {
  initialData: MindmapData | null;
  readOnly?: boolean;
  onSave: (data: MindmapData) => Promise<void> | void;
  /** autosave 디바운스 (ms). 기본 5000. */
  debounceMs?: number;
  /** 내보내기 파일명 prefix (회의록 제목 등). */
  filenameBase?: string;
  /** 부모(저장 버튼) 가 즉시 저장을 호출하기 위한 ref. */
  saveRef?: MutableRefObject<(() => Promise<void>) | null>;
};

// ---------------------------------------------------------------------------
// 노드 데이터 타입
// ---------------------------------------------------------------------------

type MindmapNodeData = {
  label: string;
  color?: ColorKey;
  task?: boolean;
  taskDone?: boolean;
  url?: string;
  memo?: string;
  image?: string;
  collapsed?: boolean;
  autoEdit?: boolean;
  // 렌더 시점 주입
  onChange?: (id: string, patch: Partial<MindmapNodeData>) => void;
  onToggleCollapse?: (id: string) => void;
  isRoot?: boolean;
  hasChildren?: boolean;
  readOnly?: boolean;
};

// ---------------------------------------------------------------------------
// 커스텀 노드
// ---------------------------------------------------------------------------

function MindmapNode({ id, data, selected }: NodeProps<Node<MindmapNodeData>>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);

  useEffect(() => {
    setDraft(data.label);
  }, [data.label]);

  // autoEdit 플래그가 true 가 되면 편집 모드 진입 + 즉시 1회 소비.
  // 마운트 시점뿐 아니라 컨텍스트 메뉴의 "라벨 편집" 처럼 부모가 나중에
  // autoEdit:true 로 바꿔도 같은 effect 가 다시 발화하도록 deps 에 포함.
  useEffect(() => {
    if (data.autoEdit) {
      setEditing(true);
      data.onChange?.(id, { autoEdit: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.autoEdit]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== data.label) data.onChange?.(id, { label: trimmed });
    setEditing(false);
  };

  const palette = COLOR_PALETTE[data.color ?? "default"];
  const style: CSSProperties = {
    backgroundColor: palette.bg,
    color: palette.text,
    borderColor: selected ? "#2563eb" : palette.border,
    borderWidth: data.isRoot ? 2 : 1,
    boxShadow: selected ? "0 0 0 3px rgba(37,99,235,.25)" : undefined,
  };

  return (
    <div
      onDoubleClick={(e) => {
        if (data.readOnly) return;
        e.stopPropagation();
        setEditing(true);
      }}
      style={style}
      className={
        "px-3 py-2 rounded-md border bg-white text-xs min-w-28 max-w-60 shadow-sm transition-colors text-center " +
        (data.isRoot ? "font-bold" : "")
      }
    >
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* 좌측 : 자식 있을 때 접기 토글 (기존 대비 30% 축소: 20px→14px / 12px→8px) */}
      {data.hasChildren && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleCollapse?.(id);
          }}
          className="absolute -left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 inline-flex items-center justify-center rounded-full border border-slate-300 bg-white hover:bg-slate-100"
          title={data.collapsed ? "펼치기" : "접기"}
          aria-label={data.collapsed ? "펼치기" : "접기"}
        >
          {data.collapsed ? (
            <ChevronRight className="h-2 w-2" />
          ) : (
            <ChevronDown className="h-2 w-2" />
          )}
        </button>
      )}

      {/* 우측 상단 : task / hyperlink / memo 인디케이터 */}
      <div className="absolute -right-1 -top-2 flex items-center gap-0.5">
        {data.url && (
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 inline-flex items-center justify-center rounded-full bg-white border border-slate-300 text-sky-600 hover:bg-sky-50"
            title={data.url}
          >
            <LinkIcon className="h-2.5 w-2.5" />
          </a>
        )}
        {data.memo && (
          <span
            className="h-4 w-4 inline-flex items-center justify-center rounded-full bg-amber-100 border border-amber-300 text-amber-700"
            title="메모 있음"
          >
            <StickyNote className="h-2.5 w-2.5" />
          </span>
        )}
      </div>

      {/* 본문 */}
      <div className="flex items-center justify-center gap-1.5">
        {data.task && (
          <input
            type="checkbox"
            checked={!!data.taskDone}
            onChange={(e) => {
              e.stopPropagation();
              data.onChange?.(id, { taskDone: e.target.checked });
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-3 w-3 shrink-0"
          />
        )}
        {data.image && (
          <img
            src={data.image}
            alt=""
            className="max-h-12 max-w-full rounded object-contain"
          />
        )}
        {editing && !data.readOnly ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                setDraft(data.label);
                setEditing(false);
              }
              e.stopPropagation();
            }}
            className={
              "text-xs outline-none bg-transparent text-center w-full " +
              (data.taskDone ? "line-through text-slate-500" : "")
            }
          />
        ) : (
          <div
            className={
              "text-xs whitespace-pre-wrap break-words " +
              (data.taskDone ? "line-through text-slate-500" : "")
            }
          >
            {data.label || "(빈 노드)"}
          </div>
        )}
      </div>
    </div>
  );
}

const nodeTypes = { mindmap: MindmapNode };

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------

function InnerMindmapEditor({
  initialData,
  readOnly,
  onSave,
  debounceMs = 5000,
  filenameBase = "mindmap",
  saveRef,
}: Props) {
  const flow = useReactFlow();
  const viewport = useViewport();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 초기 viewport — 저장된 값이 있으면 그대로, 없으면 (0,0,100%).
  // useState 가 아니라 useMemo 로 두는 이유: ReactFlow 의 defaultViewport 는
  // mount 시점에만 사용되므로 매번 새 객체를 줘도 무방.
  const initialViewport: Viewport = useMemo(
    () => initialData?.viewport ?? { x: 0, y: 0, zoom: 1 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── state
  const [nodes, setNodes] = useState<Node[]>(() =>
    (initialData?.nodes ?? []).map((n) => ({ ...n, type: n.type ?? "mindmap" })),
  );
  const [edges, setEdges] = useState<Edge[]>(() => initialData?.edges ?? []);
  const [edgeStyle, setEdgeStyle] = useState<EdgeStyleKey>("smoothstep");
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [memoOpen, setMemoOpen] = useState(false);
  // 노드 컨텍스트 메뉴 — 우클릭 시 마우스 좌표에 띄움.
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; nodeId: string } | null
  >(null);

  // ── undo/redo history (snapshot stack)
  type Snap = { nodes: Node[]; edges: Edge[] };
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const pushHistory = useCallback(() => {
    past.current.push({
      nodes: nodes.map((n) => ({ ...n, data: { ...(n.data as object) } })),
      edges: edges.map((e) => ({ ...e })),
    });
    future.current = [];
    if (past.current.length > 100) past.current.shift();
  }, [nodes, edges]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ nodes, edges });
    setNodes(prev.nodes);
    setEdges(prev.edges);
  }, [nodes, edges]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes, edges });
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [nodes, edges]);

  // ── 노드 데이터 부분 변경
  const onNodeChange = useCallback(
    (id: string, patch: Partial<MindmapNodeData>) => {
      setNodes((cur) =>
        cur.map((n) =>
          n.id === id
            ? { ...n, data: { ...(n.data as MindmapNodeData), ...patch } }
            : n,
        ),
      );
    },
    [],
  );
  const onToggleCollapse = useCallback((id: string) => {
    setNodes((cur) =>
      cur.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...(n.data as MindmapNodeData),
                collapsed: !(n.data as MindmapNodeData).collapsed,
              },
            }
          : n,
      ),
    );
  }, []);

  // ── 표시 노드 계산 — collapse 처리. 검색어 매칭은 별도 highlight.
  const { visibleNodes, visibleEdges, hiddenSet } = useMemo(() => {
    const hidden = new Set<string>();
    for (const n of nodes) {
      if ((n.data as MindmapNodeData).collapsed) {
        for (const d of descendantsOf(n.id, edges)) hidden.add(d);
      }
    }
    const vn = nodes.filter((n) => !hidden.has(n.id));
    const ve = edges.filter(
      (e) => !hidden.has(e.source) && !hidden.has(e.target),
    );
    return { visibleNodes: vn, visibleEdges: ve, hiddenSet: hidden };
  }, [nodes, edges]);

  // 검색 매칭 셋
  const searchMatch = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(
      nodes
        .filter((n) =>
          (((n.data as MindmapNodeData).label ?? "") + "")
            .toLowerCase()
            .includes(q),
        )
        .map((n) => n.id),
    );
  }, [searchQuery, nodes]);

  // ── 렌더용 노드 데코레이션
  const decoratedNodes = useMemo(() => {
    const rootSet = new Set(rootIds(nodes, edges));
    const childCount = new Map<string, number>();
    for (const e of edges) {
      childCount.set(e.source, (childCount.get(e.source) ?? 0) + 1);
    }
    return visibleNodes.map((n) => {
      const isMatch = searchMatch.has(n.id);
      return {
        ...n,
        data: {
          ...(n.data as MindmapNodeData),
          onChange: onNodeChange,
          onToggleCollapse,
          isRoot: rootSet.has(n.id),
          hasChildren: (childCount.get(n.id) ?? 0) > 0,
          readOnly,
        },
        style: {
          ...n.style,
          ...(searchQuery && !isMatch
            ? { opacity: 0.3 }
            : isMatch
              ? { boxShadow: "0 0 0 3px rgba(245,158,11,.5)" }
              : {}),
        },
      };
    });
  }, [
    visibleNodes,
    edges,
    nodes,
    searchMatch,
    searchQuery,
    onNodeChange,
    onToggleCollapse,
    readOnly,
  ]);

  // ── 변경 핸들러 (xyflow native)
  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((cur) => applyNodeChanges(changes, cur)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) =>
      setEdges((cur) => applyEdgeChanges(changes, cur)),
    [],
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      pushHistory();
      setEdges((cur) => addEdge({ ...conn, type: edgeStyle }, cur));
    },
    [pushHistory, edgeStyle],
  );

  // ── 노드 추가 헬퍼
  const newId = () =>
    `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const addNodeAtCenter = useCallback(() => {
    if (readOnly) return;
    pushHistory();
    const last = nodes[nodes.length - 1];
    const base = last?.position ?? { x: 0, y: 0 };
    const pos =
      nodes.length === 0
        ? { x: 0, y: 0 }
        : { x: base.x + 200, y: base.y + 60 };
    const id = newId();
    setNodes((cur) => [
      ...cur.map((n) => ({ ...n, selected: false })),
      {
        id,
        type: "mindmap",
        position: pos,
        data: { label: "새 노드", autoEdit: true } as MindmapNodeData,
        selected: true,
      },
    ]);
  }, [readOnly, nodes, pushHistory]);

  const addChildOf = useCallback(
    (parentId: string) => {
      if (readOnly) return;
      const parent = nodes.find((n) => n.id === parentId);
      if (!parent) return;
      pushHistory();
      const id = newId();
      const newNode: Node = {
        id,
        type: "mindmap",
        position: { x: parent.position.x + 220, y: parent.position.y },
        data: { label: "", autoEdit: true } as MindmapNodeData,
        selected: true,
      };
      setNodes((cur) => [
        ...cur.map((n) => ({ ...n, selected: false })),
        newNode,
      ]);
      setEdges((cur) => [
        ...cur,
        {
          id: `e_${parentId}_${id}`,
          source: parentId,
          target: id,
          type: edgeStyle,
        },
      ]);
    },
    [readOnly, nodes, pushHistory, edgeStyle],
  );

  const addSiblingOf = useCallback(
    (selectedId: string) => {
      if (readOnly) return;
      const parentId = parentOf(selectedId, edges);
      const me = nodes.find((n) => n.id === selectedId);
      if (!me) return;
      pushHistory();
      const id = newId();
      const newNode: Node = {
        id,
        type: "mindmap",
        position: { x: me.position.x, y: me.position.y + 80 },
        data: { label: "", autoEdit: true } as MindmapNodeData,
        selected: true,
      };
      setNodes((cur) => [
        ...cur.map((n) => ({ ...n, selected: false })),
        newNode,
      ]);
      if (parentId) {
        setEdges((cur) => [
          ...cur,
          {
            id: `e_${parentId}_${id}`,
            source: parentId,
            target: id,
            type: edgeStyle,
          },
        ]);
      }
    },
    [readOnly, edges, nodes, pushHistory, edgeStyle],
  );

  // ── 빈 곳 더블클릭으로 노드 추가
  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      // pane 영역 자체 클릭에서만 동작 (.react-flow__pane 클래스 검사)
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      pushHistory();
      const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = newId();
      setNodes((cur) => [
        ...cur.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: "mindmap",
          position: pos,
          data: { label: "", autoEdit: true } as MindmapNodeData,
          selected: true,
        },
      ]);
    },
    [flow, readOnly, pushHistory],
  );

  // ── 드래그 reparent — 노드 release 시 다른 노드 위라면 그 노드를 새 부모로
  const onNodeDragStop = useCallback(
    (e: React.MouseEvent, dropped: Node) => {
      if (readOnly) return;
      // pointer 위치에서 자기 자신 제외 가장 가까운 노드 (drop 영역 ±60px)
      const target = nodes.find((n) => {
        if (n.id === dropped.id) return false;
        const w = (n.measured as any)?.width ?? 160;
        const h = (n.measured as any)?.height ?? 48;
        const within =
          dropped.position.x >= n.position.x - 30 &&
          dropped.position.x <= n.position.x + w + 30 &&
          dropped.position.y >= n.position.y - 30 &&
          dropped.position.y <= n.position.y + h + 30;
        return within;
      });
      if (!target) return;
      // 사이클 방지 — target 이 dropped 의 자손이면 reparent 거부
      const desc = descendantsOf(dropped.id, edges);
      if (desc.has(target.id) || target.id === dropped.id) return;
      pushHistory();
      // 기존 target=dropped 입력 엣지 제거 → target=target,source 새 엣지
      setEdges((cur) => [
        ...cur.filter((ed) => ed.target !== dropped.id),
        {
          id: `e_${target.id}_${dropped.id}`,
          source: target.id,
          target: dropped.id,
          type: edgeStyle,
        },
      ]);
    },
    [nodes, edges, readOnly, pushHistory, edgeStyle],
  );

  // ── 자동 정렬
  const applyAutoLayout = useCallback(
    (direction: "LR" | "TB") => {
      pushHistory();
      setNodes((cur) => autoLayout(cur, edges, direction));
      // viewport 는 변경하지 않음 — 사용자가 보고 있던 화면에서 노드만 정렬.
      // 전체를 보고 싶으면 좌측 하단 ReactFlow Controls 의 fit 버튼 사용.
    },
    [edges, pushHistory],
  );

  // ── 색상 적용 (선택 노드 일괄)
  const applyColor = useCallback(
    (color: ColorKey) => {
      pushHistory();
      setNodes((cur) =>
        cur.map((n) =>
          n.selected
            ? { ...n, data: { ...(n.data as MindmapNodeData), color } }
            : n,
        ),
      );
      setColorMenuOpen(false);
    },
    [pushHistory],
  );

  // ── 엣지 스타일 일괄 변경
  const applyEdgeStyle = useCallback((style: EdgeStyleKey) => {
    setEdgeStyle(style);
    setEdges((cur) => cur.map((e) => ({ ...e, type: style })));
  }, []);

  // ── 노드 삭제 (자손 엣지도 같이 정리)
  const deleteNode = useCallback(
    (id: string) => {
      pushHistory();
      setNodes((cur) => cur.filter((n) => n.id !== id));
      setEdges((cur) => cur.filter((e) => e.source !== id && e.target !== id));
    },
    [pushHistory],
  );

  // ── 단일 노드에 색상/속성 적용 (컨텍스트 메뉴용 — 선택과 무관하게 id 지정)
  const applyColorTo = useCallback(
    (id: string, color: ColorKey) => {
      pushHistory();
      setNodes((cur) =>
        cur.map((n) =>
          n.id === id
            ? { ...n, data: { ...(n.data as MindmapNodeData), color } }
            : n,
        ),
      );
    },
    [pushHistory],
  );

  // ── 컨텍스트 메뉴 트리거 — 우클릭한 노드를 선택 + 메뉴 좌표 저장
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      if (readOnly) return;
      e.preventDefault();
      // 우클릭 노드를 단일 선택 — 메뉴의 "메타" 등이 정확히 그 노드를 가리키도록
      setNodes((cur) =>
        cur.map((n) => ({ ...n, selected: n.id === node.id })),
      );
      setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
    },
    [readOnly],
  );

  // 외부 클릭/포커스 이동/Esc → 컨텍스트 메뉴 닫기
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".mn-context-menu")) return;
      setCtxMenu(null);
    };
    // 키보드/프로그램적 focus 가 메뉴 밖으로 옮겨가면 닫음
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.(".mn-context-menu")) return;
      setCtxMenu(null);
    };
    const onBlurWindow = () => setCtxMenu(null); // 탭/창 자체 포커스 잃을 때
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onBlurWindow);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onBlurWindow);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // ── 자동저장 + 직렬화
  const saveTimer = useRef<number | null>(null);
  const lastSerialized = useRef<string | null>(null);
  const flushSaveRef = useRef<() => Promise<void>>(async () => {});
  flushSaveRef.current = async () => {
    if (readOnly) return;
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const cleanNodes = nodes.map((n) => {
      const d = n.data as MindmapNodeData;
      return {
        id: n.id,
        type: n.type,
        position: n.position,
        data: {
          label: d.label ?? "",
          ...(d.color ? { color: d.color } : {}),
          ...(d.task ? { task: d.task } : {}),
          ...(d.taskDone ? { taskDone: d.taskDone } : {}),
          ...(d.url ? { url: d.url } : {}),
          ...(d.memo ? { memo: d.memo } : {}),
          ...(d.image ? { image: d.image } : {}),
          ...(d.collapsed ? { collapsed: d.collapsed } : {}),
        },
      };
    });
    const cleanEdges = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
    }));
    // 저장 시점의 카메라(viewport) 도 같이 저장 — 다시 열 때 같은 화면 복원.
    const vp = flow.getViewport();
    const payload: MindmapData = {
      nodes: cleanNodes as Node[],
      edges: cleanEdges,
      viewport: { x: vp.x, y: vp.y, zoom: vp.zoom },
    };
    const json = JSON.stringify(payload);
    if (json === lastSerialized.current) return;
    lastSerialized.current = json;
    try {
      await onSave(payload);
    } catch {
      lastSerialized.current = null;
    }
  };

  useEffect(() => {
    if (readOnly) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      flushSaveRef.current();
    }, debounceMs);
    return () => {
      if (saveTimer.current != null)
        window.clearTimeout(saveTimer.current);
    };
  }, [nodes, edges, readOnly, debounceMs]);

  // 부모(저장 버튼) 트리거용 ref 노출.
  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = () => flushSaveRef.current();
    return () => {
      saveRef.current = null;
    };
  }, [saveRef]);

  // ── 키보드 마스터 핸들러
  const onContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (readOnly) return;
      const isMod = e.ctrlKey || e.metaKey;

      // (Ctrl/Cmd + S 단축키 제거 — 상단 "저장" 버튼으로 대체)

      // Ctrl/Cmd + Z / Y — undo / redo
      if (isMod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
        return;
      }
      if (
        isMod &&
        ((e.shiftKey && (e.key === "z" || e.key === "Z")) ||
          e.key === "y" ||
          e.key === "Y")
      ) {
        e.preventDefault();
        redo();
        return;
      }
      // Ctrl/Cmd + F — 검색
      if (isMod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // Esc — 검색 닫기 + 선택 해제
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery("");
          return;
        }
        setNodes((cur) => cur.map((n) => ({ ...n, selected: false })));
        return;
      }

      // 아래 동작은 노드 1개 선택 시에만
      const selected = nodes.find((n) => n.selected);
      if (!selected) return;

      // Tab — 자식 추가
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        addChildOf(selected.id);
        return;
      }
      // Shift+Tab — 형제 추가
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        addSiblingOf(selected.id);
        return;
      }
      // Enter — 라벨 편집 진입
      if (e.key === "Enter") {
        e.preventDefault();
        onNodeChange(selected.id, { autoEdit: true });
        return;
      }
      // 방향키 — 인접 노드로 선택 이동
      const dirMap: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      if (dirMap[e.key]) {
        e.preventDefault();
        const next = nearestInDirection(selected, nodes, dirMap[e.key]);
        if (next) {
          setNodes((cur) =>
            cur.map((n) => ({ ...n, selected: n.id === next.id })),
          );
        }
        return;
      }
    },
    [readOnly, nodes, undo, redo, addChildOf, addSiblingOf, onNodeChange, searchOpen],
  );

  // ── 클립보드 이미지 paste → 선택 노드에 image 또는 새 image 노드
  useEffect(() => {
    if (readOnly) return;
    const onPaste = (e: ClipboardEvent) => {
      // xyflow `Node` 와 DOM `Node` 가 같은 모듈 스코프에 동시 존재 →
      // 명시적으로 globalThis.Node 사용.
      if (!wrapperRef.current?.contains(e.target as globalThis.Node)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (!file) continue;
          // 노드 안에 들어가는 작은 썸네일이라 600px 로 충분 — body/마인드맵
          // jsonb 가 비대해지지 않도록 강하게 압축.
          compressImageToDataUrl(file, { maxDim: 600, quality: 0.85 }).then(
            (dataUrl) => {
              const sel = nodes.find((n) => n.selected);
              pushHistory();
              if (sel) {
                onNodeChange(sel.id, { image: dataUrl });
              } else {
                const id = newId();
                setNodes((cur) => [
                  ...cur,
                  {
                    id,
                    type: "mindmap",
                    position: flow.screenToFlowPosition({
                      x: window.innerWidth / 2,
                      y: window.innerHeight / 2,
                    }),
                    data: { label: "", image: dataUrl } as MindmapNodeData,
                    selected: true,
                  },
                ]);
              }
            },
          );
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [readOnly, nodes, pushHistory, onNodeChange, flow]);

  // ── 내보내기
  const labelOf = (id: string) =>
    (nodes.find((n) => n.id === id)?.data as MindmapNodeData)?.label ?? "";

  // 내보내기 공통 — 모든 노드를 한 화면에 fit 하는 viewport transform 을 계산해
  // `.react-flow__viewport` 엘리먼트에 적용한 채로 html-to-image 에 넘긴다.
  // (`.react-flow` 전체를 그대로 캡처하면 edges 의 SVG 레이어가 누락되거나
  // viewport transform 이 어긋나 일부 노드/선이 화면 밖으로 잘려나간다 — 공식
  // 가이드의 export 패턴으로 우회.)
  const buildExportTarget = useCallback(() => {
    const viewportEl = wrapperRef.current?.querySelector(
      ".react-flow__viewport",
    ) as HTMLElement | null;
    if (!viewportEl) return null;
    const allNodes = flow.getNodes();
    if (allNodes.length === 0) return null;
    const bounds = getNodesBounds(allNodes);
    const imageWidth = 1600;
    const imageHeight = 1200;
    const vp = getViewportForBounds(
      bounds,
      imageWidth,
      imageHeight,
      0.3, // minZoom
      2,   // maxZoom
      0.1, // padding (10%)
    );
    return {
      el: viewportEl,
      width: imageWidth,
      height: imageHeight,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
      } as Record<string, string>,
    };
  }, [flow]);

  const exportPng = useCallback(async () => {
    setExportMenuOpen(false);
    const target = buildExportTarget();
    if (!target) return;
    const dataUrl = await htmlToImage.toPng(target.el, {
      backgroundColor: "#ffffff",
      width: target.width,
      height: target.height,
      style: target.style,
      pixelRatio: 2,
      cacheBust: true,
    });
    const blob = await (await fetch(dataUrl)).blob();
    downloadFile(`${filenameBase}.png`, blob, "image/png");
  }, [filenameBase, buildExportTarget]);

  const exportSvg = useCallback(async () => {
    setExportMenuOpen(false);
    const target = buildExportTarget();
    if (!target) return;
    const dataUrl = await htmlToImage.toSvg(target.el, {
      backgroundColor: "#ffffff",
      width: target.width,
      height: target.height,
      style: target.style,
      cacheBust: true,
    });
    const svgText = decodeURIComponent(
      dataUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""),
    );
    downloadFile(`${filenameBase}.svg`, svgText, "image/svg+xml");
  }, [filenameBase, buildExportTarget]);

  const exportPdf = useCallback(async () => {
    setExportMenuOpen(false);
    const target = buildExportTarget();
    if (!target) return;
    const dataUrl = await htmlToImage.toPng(target.el, {
      backgroundColor: "#ffffff",
      width: target.width,
      height: target.height,
      style: target.style,
      pixelRatio: 2,
      cacheBust: true,
    });
    const orientation = target.width >= target.height ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pageW / target.width, pageH / target.height);
    const w = target.width * ratio;
    const h = target.height * ratio;
    pdf.addImage(dataUrl, "PNG", (pageW - w) / 2, (pageH - h) / 2, w, h);
    pdf.save(`${filenameBase}.pdf`);
  }, [filenameBase, buildExportTarget]);

  const exportMarkdown = useCallback(() => {
    setExportMenuOpen(false);
    const md = toMarkdownOutline(nodes, edges, labelOf);
    downloadFile(`${filenameBase}.md`, md, "text/markdown;charset=utf-8");
  }, [nodes, edges, filenameBase]);

  const exportOpml = useCallback(() => {
    setExportMenuOpen(false);
    const opml = toOPML(nodes, edges, labelOf, filenameBase);
    downloadFile(`${filenameBase}.opml`, opml, "text/x-opml;charset=utf-8");
  }, [nodes, edges, filenameBase]);

  // ── 메모 사이드 패널 — 선택 노드 1개의 메타 편집
  const selectedNode = nodes.find((n) => n.selected);
  const selectedData = selectedNode?.data as MindmapNodeData | undefined;

  // 검색 결과 노드들로 fitView
  const focusMatches = useCallback(() => {
    const ids = Array.from(searchMatch);
    if (ids.length === 0) return;
    const targetNodes = nodes.filter((n) => ids.includes(n.id));
    flow.fitView({ nodes: targetNodes.map((n) => ({ id: n.id })), padding: 0.3, duration: 200 });
  }, [searchMatch, nodes, flow]);

  const isEmpty = nodes.length === 0;

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full min-h-[480px] rounded-md border border-border bg-white relative flex flex-col"
      tabIndex={0}
    >
      {/* 툴바 */}
      {!readOnly && (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 bg-muted/30 flex-wrap">
          <button
            type="button"
            onClick={addNodeAtCenter}
            className="h-7 inline-flex items-center gap-1 rounded-md bg-primary px-2 text-xs text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3 w-3" /> 노드
          </button>

          <ToolDivider />

          <ToolBtn onClick={undo} title="되돌리기 (Ctrl+Z)">
            <Undo2 className="h-3 w-3" />
          </ToolBtn>
          <ToolBtn onClick={redo} title="다시 (Ctrl+Shift+Z)">
            <Redo2 className="h-3 w-3" />
          </ToolBtn>

          <ToolDivider />

          <ToolBtn
            onClick={() => applyAutoLayout("LR")}
            title="자동 정렬 (좌→우 트리)"
          >
            <Layout className="h-3 w-3" /> 정렬
          </ToolBtn>
          <ToolBtn
            onClick={() => applyAutoLayout("TB")}
            title="자동 정렬 (상→하 트리)"
          >
            <ListTree className="h-3 w-3" />
          </ToolBtn>

          <ToolDivider />

          {/* 색상 팔레트 */}
          <div className="relative">
            <ToolBtn
              onClick={() => setColorMenuOpen((o) => !o)}
              title="선택 노드 색"
            >
              <Palette className="h-3 w-3" /> 색
            </ToolBtn>
            {colorMenuOpen && (
              <div className="absolute z-20 left-0 top-8 w-56 rounded-md border border-border bg-white shadow-md p-2 grid grid-cols-4 gap-1">
                {(Object.keys(COLOR_PALETTE) as ColorKey[]).map((k) => {
                  const p = COLOR_PALETTE[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => applyColor(k)}
                      className="h-7 rounded border text-[10px]"
                      style={{ backgroundColor: p.bg, borderColor: p.border, color: p.text }}
                      title={p.label}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 엣지 스타일 */}
          <div className="relative">
            <select
              value={edgeStyle}
              onChange={(e) => applyEdgeStyle(e.target.value as EdgeStyleKey)}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs"
              title="엣지 스타일"
            >
              {(Object.keys(EDGE_STYLE_LABEL) as EdgeStyleKey[]).map((k) => (
                <option key={k} value={k}>
                  {EDGE_STYLE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          {/* 그리드 스냅 */}
          <label className="h-7 inline-flex items-center gap-1 px-2 text-xs select-none cursor-pointer">
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(e) => setSnapToGrid(e.target.checked)}
              className="h-3 w-3"
            />
            스냅
          </label>

          <ToolDivider />

          <ToolBtn onClick={() => setSearchOpen(true)} title="검색 (Ctrl+F)">
            <Search className="h-3 w-3" />
          </ToolBtn>

          <ToolBtn
            onClick={() => setMemoOpen((o) => !o)}
            title="선택 노드 메타 (메모/링크/할일/이미지)"
            disabled={!selectedNode}
          >
            <StickyNote className="h-3 w-3" /> 메타
          </ToolBtn>

          <ToolDivider />

          {/* 내보내기 */}
          <div className="relative">
            <ToolBtn
              onClick={() => setExportMenuOpen((o) => !o)}
              title="내보내기"
            >
              <Download className="h-3 w-3" /> 내보내기
            </ToolBtn>
            {exportMenuOpen && (
              <div className="absolute z-20 right-0 top-8 w-44 rounded-md border border-border bg-white shadow-md py-1 text-xs">
                <ExportItem icon={<FileImage className="h-3 w-3" />} onClick={exportPng}>
                  PNG 이미지
                </ExportItem>
                <ExportItem icon={<FileImage className="h-3 w-3" />} onClick={exportSvg}>
                  SVG 벡터
                </ExportItem>
                <ExportItem icon={<FileTextIcon className="h-3 w-3" />} onClick={exportPdf}>
                  PDF
                </ExportItem>
                <ExportItem icon={<FileTextIcon className="h-3 w-3" />} onClick={exportMarkdown}>
                  Markdown 개요
                </ExportItem>
                <ExportItem icon={<FileTextIcon className="h-3 w-3" />} onClick={exportOpml}>
                  OPML
                </ExportItem>
              </div>
            )}
          </div>

          <span className="ml-auto text-[10px] text-muted-foreground">
            Tab=자식 · Shift+Tab=형제 · Enter=편집 · ↑↓←→=이동 · Backspace=삭제
            · Ctrl+Z=Undo
          </span>
        </div>
      )}

      {/* 검색 오버레이 */}
      {searchOpen && (
        <div className="absolute z-20 top-12 right-2 flex items-center gap-1 rounded-md border border-border bg-white shadow-md px-2 py-1">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                focusMatches();
              } else if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              }
              e.stopPropagation();
            }}
            placeholder="노드 검색"
            className="h-6 w-48 text-xs bg-transparent outline-none"
          />
          <span className="text-[10px] text-muted-foreground">
            {searchQuery ? `${searchMatch.size}건` : ""}
          </span>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div
        className="flex-1 min-h-0 relative flex"
        onKeyDownCapture={onContainerKeyDown}
      >
        <div className="flex-1 min-h-0 relative">
          <ReactFlow
            nodes={decoratedNodes}
            edges={visibleEdges.map((e) => ({ ...e, type: e.type ?? edgeStyle }))}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDoubleClick={onPaneDoubleClick}
            onNodeDragStop={onNodeDragStop}
            onNodeContextMenu={onNodeContextMenu}
            nodeTypes={nodeTypes}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            selectionOnDrag
            multiSelectionKeyCode={["Control", "Meta", "Shift"]}
            snapToGrid={snapToGrid}
            snapGrid={[16, 16]}
            defaultViewport={initialViewport}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>

          {/* 확대 비율 표시 — Controls 위쪽에 absolute. 클릭 시 100% 로 리셋. */}
          <button
            type="button"
            onClick={() => flow.zoomTo(1, { duration: 200 })}
            className="absolute left-3 bottom-32 z-10 h-6 px-2 rounded border border-border bg-white/90 text-[11px] tabular-nums hover:bg-white shadow-sm"
            title="100% 로 리셋"
          >
            {Math.round((viewport?.zoom ?? 1) * 100)}%
          </button>

          {isEmpty && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto flex flex-col items-center gap-2 text-center">
                <div className="text-xs text-muted-foreground">
                  마인드맵이 비어 있습니다
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={addNodeAtCenter}
                    className="h-8 inline-flex items-center gap-1 rounded-md border border-primary bg-primary/5 px-3 text-xs text-primary hover:bg-primary/10"
                  >
                    <Plus className="h-3 w-3" /> 첫 노드 추가
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 메타 사이드 패널 */}
        {memoOpen && selectedNode && (
          <aside className="w-72 border-l border-border bg-white p-3 overflow-auto text-xs flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold">노드 메타</span>
              <button
                type="button"
                onClick={() => setMemoOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <Field label="라벨">
              <input
                value={selectedData?.label ?? ""}
                onChange={(e) => onNodeChange(selectedNode.id, { label: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
              />
            </Field>
            <Field label="하이퍼링크">
              <div className="flex items-center gap-1">
                <input
                  value={selectedData?.url ?? ""}
                  onChange={(e) => onNodeChange(selectedNode.id, { url: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="https://..."
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                />
                {selectedData?.url && (
                  <a
                    href={selectedData.url}
                    target="_blank"
                    rel="noreferrer"
                    className="h-6 w-6 inline-flex items-center justify-center rounded border border-border hover:bg-muted"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </Field>
            <Field label="할일">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!!selectedData?.task}
                  onChange={(e) => onNodeChange(selectedNode.id, { task: e.target.checked })}
                  className="h-3 w-3"
                />
                <span>이 노드를 할일로 표시</span>
              </label>
            </Field>
            <Field label="메모">
              <textarea
                value={selectedData?.memo ?? ""}
                onChange={(e) => onNodeChange(selectedNode.id, { memo: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                rows={6}
                className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
              />
            </Field>
            <Field label="이미지">
              <div className="flex items-center gap-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const dataUrl = await compressImageToDataUrl(f, {
                      maxDim: 600,
                      quality: 0.85,
                    });
                    onNodeChange(selectedNode.id, { image: dataUrl });
                  }}
                  className="text-xs"
                />
                {selectedData?.image && (
                  <button
                    type="button"
                    onClick={() => onNodeChange(selectedNode.id, { image: undefined })}
                    className="h-6 px-2 text-[10px] rounded border border-border hover:bg-muted"
                  >
                    제거
                  </button>
                )}
              </div>
            </Field>
            <div className="text-[10px] text-muted-foreground">
              클립보드 이미지 paste 도 가능합니다.
            </div>
          </aside>
        )}
      </div>

      {/* 노드 우클릭 컨텍스트 메뉴 */}
      {ctxMenu && (() => {
        const node = nodes.find((n) => n.id === ctxMenu.nodeId);
        if (!node) return null;
        const d = node.data as MindmapNodeData;
        // 화면 밖으로 나가지 않게 우/하 끝에서 떨어뜨림
        const left = Math.min(ctxMenu.x, window.innerWidth - 240);
        const top = Math.min(ctxMenu.y, window.innerHeight - 380);
        const close = () => setCtxMenu(null);
        return (
          <div
            className="mn-context-menu fixed z-50 w-56 rounded-md border border-border bg-white shadow-lg text-xs py-1"
            style={{ left, top }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <CtxItem
              icon={<Pencil className="h-3 w-3" />}
              onClick={() => {
                onNodeChange(node.id, { autoEdit: true });
                close();
              }}
            >
              라벨 편집
            </CtxItem>
            <CtxItem
              icon={<Plus className="h-3 w-3" />}
              onClick={() => {
                addChildOf(node.id);
                close();
              }}
            >
              자식 노드 추가 <span className="ml-auto text-muted-foreground">Tab</span>
            </CtxItem>
            <CtxItem
              icon={<Plus className="h-3 w-3" />}
              onClick={() => {
                addSiblingOf(node.id);
                close();
              }}
            >
              형제 노드 추가{" "}
              <span className="ml-auto text-muted-foreground">⇧Tab</span>
            </CtxItem>

            <CtxDivider />

            {/* 색상 — 인라인 4×3 팔레트 */}
            <div className="px-2 py-1">
              <div className="text-[10px] text-muted-foreground mb-1 inline-flex items-center gap-1">
                <Palette className="h-3 w-3" /> 색상
              </div>
              <div className="grid grid-cols-4 gap-1">
                {(Object.keys(COLOR_PALETTE) as ColorKey[]).map((k) => {
                  const p = COLOR_PALETTE[k];
                  const active = (d.color ?? "default") === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        applyColorTo(node.id, k);
                        close();
                      }}
                      className={
                        "h-6 rounded text-[9px] " +
                        (active ? "ring-2 ring-primary" : "border")
                      }
                      style={{
                        backgroundColor: p.bg,
                        borderColor: p.border,
                        color: p.text,
                      }}
                      title={p.label}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <CtxDivider />

            <CtxItem
              icon={<CheckSquare className="h-3 w-3" />}
              onClick={() => {
                onNodeChange(node.id, { task: !d.task });
                close();
              }}
            >
              {d.task ? "할일 표시 해제" : "할일로 표시"}
            </CtxItem>
            <CtxItem
              icon={
                d.collapsed ? (
                  <ChevronRight className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )
              }
              onClick={() => {
                onNodeChange(node.id, { collapsed: !d.collapsed });
                close();
              }}
              disabled={!childrenOf(node.id, edges).length}
            >
              {d.collapsed ? "자식 펼치기" : "자식 접기"}
            </CtxItem>
            <CtxItem
              icon={<Settings2 className="h-3 w-3" />}
              onClick={() => {
                setMemoOpen(true);
                close();
              }}
            >
              메타 (메모/링크/이미지)
            </CtxItem>

            <CtxDivider />

            <CtxItem
              icon={<Trash2 className="h-3 w-3" />}
              danger
              onClick={() => {
                deleteNode(node.id);
                close();
              }}
            >
              노드 삭제{" "}
              <span className="ml-auto text-muted-foreground">Del</span>
            </CtxItem>
          </div>
        );
      })()}
    </div>
  );
}

function CtxItem({
  icon,
  onClick,
  disabled,
  danger,
  children,
}: {
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "w-full inline-flex items-center gap-2 px-3 py-1.5 text-left disabled:opacity-50 " +
        (danger
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-muted")
      }
    >
      {icon}
      {children}
    </button>
  );
}

function CtxDivider() {
  return <div className="my-1 border-t border-border" />;
}

function ToolBtn({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function ToolDivider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}

function ExportItem({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full inline-flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
    >
      {icon}
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function MindmapEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <InnerMindmapEditor {...props} />
    </ReactFlowProvider>
  );
}
