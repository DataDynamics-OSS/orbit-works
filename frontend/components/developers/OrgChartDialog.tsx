"use client";

/**
 * 결재선(조직도) 시각화 — full-screen 다이얼로그.
 *
 * /developers (와 /contacts) 페이지의 "결재선" 버튼이 띄움. ACTIVE 임직원
 * 전원을 AntV G6 로 노출. 노드 클릭 시 우측 사이드 패널에 간단 정보.
 *
 * - 자동 레이아웃: G6 `compact-box` LR 가 기본 — 동일 rank 의 형제 subtree 가
 *   각자 폭만큼만 차지하므로 한 layer 가 옆으로 길게 늘어지는 dagre 의
 *   "wide layer" 문제가 자연스럽게 해결됨. 카드가 가로로 길어 LR 이 화면을
 *   더 효율적으로 사용한다.
 * - 레이아웃 4종 토글(헤더 select)로 compact-box / mindmap / indented / dagre 전환.
 * - 노드는 canvas 기반 custom Rect 노드 (`org-card`) — html 노드의 zoom blur
 *   문제를 피하기 위함. 시각 디자인은 G6 fund-flow 예제 패턴.
 * - zoom 컨트롤 (+/−/Fit/100%) 을 헤더 우측에 표시.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Graph, type GraphData } from "@antv/g6";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import {
  ORG_CARD_H,
  ORG_CARD_W,
  ensureOrgCardRegistered,
  type SecurityRole,
} from "@/components/developers/org-card-node";

// 모듈 로드 시 1회 — G6 가 'org-card' 노드를 인식하도록.
ensureOrgCardRegistered();

type OrgNode = {
  id: string;
  name: string;
  title: string | null;
  employee_no: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  hire_date: string | null;
  career_months_at_hire: number | null;
  security_role: SecurityRole;
  employment_type: string;
  manager_id: string | null;
  report_count: number;
  rank_name: string | null;
  position_name: string | null;
};

const ROLE_LEGEND: Record<SecurityRole, string> = {
  ADMIN: "#a855f7",
  HR: "#10b981",
  SALES: "#3b82f6",
  SUPPORT: "#f59e0b",
  ETC: "#64748b",
};

// 범례 한글 라벨 — UI 표기. 카드 배지(헤더 우측)는 영문 코드 그대로 유지.
const ROLE_LABEL_KO: Record<SecurityRole, string> = {
  ADMIN: "관리자",
  HR: "인사",
  SALES: "영업",
  SUPPORT: "기술지원",
  ETC: "일반",
};

// 입사일(YYYY-MM-DD) → 근무한 총 개월 수. 입사 안 됐거나 미래면 null.
function tenureMonthsFrom(hireDateIso: string | null | undefined): number | null {
  if (!hireDateIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(hireDateIso);
  if (!m) return null;
  const sy = +m[1], smo = +m[2], sd = +m[3];
  const today = new Date();
  let months = (today.getFullYear() - sy) * 12 + (today.getMonth() + 1 - smo);
  if (today.getDate() < sd) months -= 1;
  return months >= 0 ? months : null;
}

// 개월 수 → "Y년 M개월". null/음수면 "-". 0개월은 "0개월" 로 표기 유지.
function fmtMonths(totalMonths: number | null | undefined): string {
  if (totalMonths == null || totalMonths < 0) return "-";
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  if (y === 0) return `${m}개월`;
  if (m === 0) return `${y}년`;
  return `${y}년 ${m}개월`;
}

function tenure(hireDateIso: string | null | undefined): string {
  return fmtMonths(tenureMonthsFrom(hireDateIso));
}

// 총 경력 = 입사 전 누적 (career_months_at_hire) + 현재까지 근무기간.
// 둘 다 null 이면 "-". hire_date 만 있고 사전 경력이 null 이면 근무기간만.
function totalCareer(
  hireDateIso: string | null | undefined,
  careerMonthsAtHire: number | null | undefined,
): string {
  const tenureM = tenureMonthsFrom(hireDateIso);
  if (tenureM == null && (careerMonthsAtHire == null || careerMonthsAtHire < 0)) {
    return "-";
  }
  const total = (tenureM ?? 0) + (careerMonthsAtHire ?? 0);
  return fmtMonths(total);
}

// G6 v5 layout 옵션 — mindmap 고정 (이전엔 selector 로 4종 전환했으나
// destroy → 재생성 시 canvas 가 절반만 그려지는 문제로 단일 layout 으로 회귀).
const MINDMAP_LAYOUT_OPTION: Record<string, unknown> = {
  type: "mindmap",
  direction: "H",
  getId: (d: { id: string }) => d.id,
  getHeight: () => ORG_CARD_H,
  getWidth: () => ORG_CARD_W,
  getVGap: () => 16,
  getHGap: () => 60,
};

// ---------------------------------------------------------------------------
// 다이얼로그
// ---------------------------------------------------------------------------

type Assignment = {
  assignment_id: string;
  project_id: string;
  project_name: string;
  start_date: string;
  end_date: string;
};

export function OrgChartDialog({
  open,
  onClose,
  inline = false,
}: {
  open: boolean;
  onClose: () => void;
  /** 페이지로 임베드할 때 true — fixed 오버레이 / 자체 헤더 / 닫기 버튼을 생략하고
   *  부모 컨테이너 안쪽을 가득 채운다. 범례는 그래프 좌상단 floating chip 으로 노출. */
  inline?: boolean;
}) {
  const router = useRouter();
  const dialog = useDialog();
  const { data: devs = [], isLoading } = useQuery<OrgNode[]>({
    queryKey: ["org-chart"],
    queryFn: async () => (await api.get("/developers/org-chart")).data,
    enabled: open,
    staleTime: 60_000,
  });

  // 사이드 패널의 민감 정보 (보안등급/주소/비상연락처) 게이트 — HR/ADMIN 만.
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const canSeeSensitive = me?.role === "ADMIN" || me?.role === "HR";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  // 드래그 시작 시 후손(BFS) 캐시 — drag move 마다 재계산하지 않음.
  const dragDescendantsRef = useRef<string[]>([]);

  const selected = useMemo(
    () => devs.find((d) => d.id === selectedId) ?? null,
    [devs, selectedId],
  );

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ["org-chart-assignments", selectedId],
    queryFn: async () =>
      (await api.get(`/developers/${selectedId}/assignments`)).data,
    enabled: !!selectedId,
    staleTime: 60_000,
  });

  // 다이얼로그가 닫히면 선택 해제 + 그래프도 폐기.
  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    }
  }, [open]);

  // ESC 로 닫기.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // G6 그래프 생성/재구성 — devs 가 바뀌면 destroy 후 재생성.
  useEffect(() => {
    if (!open || !containerRef.current || devs.length === 0) return;

    const validIds = new Set(devs.map((d) => d.id));
    const data: GraphData = {
      nodes: devs.map((d) => ({
        id: d.id,
        // OrgCardNode 가 attributes.data 로 받아 그림.
        data: d as unknown as Record<string, unknown>,
      })),
      edges: devs
        .filter((d) => d.manager_id && validIds.has(d.manager_id))
        .map((d) => ({
          id: `e-${d.manager_id}-${d.id}`,
          source: d.manager_id!,
          target: d.id,
        })),
    };

    if (graphRef.current) {
      graphRef.current.destroy();
      graphRef.current = null;
    }

    // manager_id 기준 children map — drag 시 후손 BFS 의 인접 리스트로 사용.
    const childrenMap = new Map<string, string[]>();
    for (const d of devs) {
      if (d.manager_id && validIds.has(d.manager_id)) {
        const arr = childrenMap.get(d.manager_id) ?? [];
        arr.push(d.id);
        childrenMap.set(d.manager_id, arr);
      }
    }
    function descendantsOf(rootId: string): string[] {
      const out: string[] = [];
      const stack = [rootId];
      while (stack.length) {
        const cur = stack.pop()!;
        const kids = childrenMap.get(cur) ?? [];
        for (const k of kids) {
          out.push(k);
          stack.push(k);
        }
      }
      return out;
    }

    const graph = new Graph({
      container: containerRef.current,
      data,
      autoFit: "view",
      padding: 32,
      node: {
        type: "org-card",
        style: (d: any) => ({
          size: [ORG_CARD_W, ORG_CARD_H],
          // OrgCardNode 가 attributes.data.* 를 읽음.
          data: d.data,
        }),
      },
      edge: {
        type: "cubic-horizontal",
        style: {
          stroke: "#cbd5e1",
          lineWidth: 1.5,
          endArrow: false,
        },
      },
      layout: MINDMAP_LAYOUT_OPTION as never,
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
    });

    graph.on("node:click", (e: any) => {
      const id: string | undefined =
        e?.target?.id ?? e?.itemId ?? e?.target?.attributes?.id;
      if (id) setSelectedId(id);
    });
    graph.on("canvas:click", () => setSelectedId(null));

    // 사용자가 휠/제스처로 zoom 하면 zoomPct 표시도 동기화.
    graph.on("viewport:zoom", () => {
      try {
        const z = graph.getZoom();
        setZoomPct(Math.round(z * 100));
      } catch {
        /* graph already destroyed */
      }
    });

    // 노드를 드래그하면 그 자식·자손도 같은 변위만큼 같이 이동 (sub-tree drag).
    // dragstart 에서 후손 ID 를 캐시 → drag 마다 dx/dy 만 적용 (재계산 없음).
    graph.on("node:dragstart", (e: any) => {
      const id: string | undefined = e?.target?.id ?? e?.itemId;
      dragDescendantsRef.current = id ? descendantsOf(id) : [];
    });
    graph.on("node:drag", (e: any) => {
      // e.dx / e.dy 는 스크린 픽셀 단위. G6 의 drag-element 는 내부에서
      // /= zoom 으로 world 좌표로 변환한 뒤 부모를 옮기므로, 우리도 같은
      // 보정을 해야 부모와 자식이 정확히 같은 거리만큼 이동한다.
      // (zoom ≠ 1 에서 raw 픽셀을 적용하면 자식이 부모보다 빠르거나 느려
      //  드래그할수록 간격이 벌어지거나 좁혀짐.)
      const rawDx: number = e?.dx ?? 0;
      const rawDy: number = e?.dy ?? 0;
      if (!rawDx && !rawDy) return;
      const ids = dragDescendantsRef.current;
      if (ids.length === 0) return;
      const zoom = graph.getZoom() || 1;
      const dx = rawDx / zoom;
      const dy = rawDy / zoom;
      const offsets: Record<string, [number, number]> = {};
      for (const id of ids) offsets[id] = [dx, dy];
      graph.translateElementBy(offsets, false);
    });
    graph.on("node:dragend", () => {
      dragDescendantsRef.current = [];
    });

    graph.render().then(() => {
      try {
        setZoomPct(Math.round(graph.getZoom() * 100));
      } catch {
        /* ignore */
      }
    });
    graphRef.current = graph;

    return () => {
      graph.destroy();
      graphRef.current = null;
    };
  }, [open, devs]);

  // Zoom 컨트롤 — 그래프 ref 가 살아있을 때만 동작.
  const zoomBy = useCallback((factor: number) => {
    const g = graphRef.current;
    if (!g) return;
    const cur = g.getZoom();
    g.zoomTo(cur * factor, true).then(() => {
      setZoomPct(Math.round(g.getZoom() * 100));
    });
  }, []);

  const fitView = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    g.fitView().then(() => {
      setZoomPct(Math.round(g.getZoom() * 100));
    });
  }, []);

  const zoomTo100 = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    g.zoomTo(1, true).then(() => {
      setZoomPct(100);
    });
  }, []);

  async function handleProjectClick(p: Assignment) {
    const ok = await dialog.confirm(
      <span>
        <b>{p.project_name}</b> 프로젝트로 이동하시겠습니까?
      </span>,
      { title: "프로젝트 이동", confirmText: "이동", cancelText: "취소" },
    );
    if (!ok) return;
    onClose();
    router.push(`/projects/${p.project_id}`);
  }

  if (!open) return null;

  const wrapperClass = inline
    ? "flex-1 min-h-0 flex flex-col"
    : "fixed inset-0 z-50 flex flex-col bg-background";

  return (
    <div className={wrapperClass}>
      {/* 다이얼로그 헤더 — inline 모드에선 페이지의 DashboardHeader 가 대신 함. */}
      {!inline && (
        <div className="flex items-center justify-between border-b border-border bg-card px-4 h-12 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">결재선 (조직도)</h2>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {/* 색 범례 */}
            <div className="hidden md:flex items-center gap-2">
              {(["ADMIN", "HR", "SALES", "SUPPORT", "ETC"] as SecurityRole[]).map((r) => (
                <span key={r} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block w-3 h-3 rounded"
                    style={{ background: ROLE_LEGEND[r] }}
                  />
                  {ROLE_LABEL_KO[r]}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 h-8 rounded-md border border-border bg-background px-3 hover:bg-muted"
            >
              <X className="h-4 w-4" /> 닫기
            </button>
          </div>
        </div>
      )}

      {/* 본체 */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 relative bg-[#fafafa] overflow-hidden">
          {isLoading ? (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              불러오는 중…
            </div>
          ) : devs.length === 0 ? (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              표시할 임직원이 없습니다.
            </div>
          ) : (
            <>
              <div ref={containerRef} className="absolute inset-0" />
              {/* Floating 범례 — inline 모드에선 다이얼로그 헤더가 없으므로
                  그래프 좌상단에 chip 으로 노출. */}
              {inline && (
                <div className="absolute top-4 left-4 z-20 flex items-center gap-2 rounded-lg border border-border bg-card/95 backdrop-blur px-3 py-1.5 text-[11px] shadow-sm">
                  {(["ADMIN", "HR", "SALES", "SUPPORT", "ETC"] as SecurityRole[]).map((r) => (
                    <span key={r} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block w-3 h-3 rounded"
                        style={{ background: ROLE_LEGEND[r] }}
                      />
                      {ROLE_LABEL_KO[r]}
                    </span>
                  ))}
                </div>
              )}
              {/* Floating zoom 컨트롤 — 그래프 우하단. relative 부모에 absolute. */}
              <div className="absolute bottom-4 right-4 z-20 inline-flex flex-col rounded-lg border border-border bg-card shadow-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => zoomBy(1.18)}
                  aria-label="확대"
                  title="확대"
                  className="h-9 w-9 inline-flex items-center justify-center hover:bg-muted border-b border-border"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={zoomTo100}
                  aria-label="100% 로 복귀"
                  title="100%"
                  className="h-7 w-9 inline-flex items-center justify-center text-[10px] font-medium tabular-nums hover:bg-muted border-b border-border"
                >
                  {zoomPct}%
                </button>
                <button
                  type="button"
                  onClick={() => zoomBy(0.85)}
                  aria-label="축소"
                  title="축소"
                  className="h-9 w-9 inline-flex items-center justify-center hover:bg-muted border-b border-border"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={fitView}
                  aria-label="화면에 맞춤"
                  title="화면에 맞춤"
                  className="h-9 w-9 inline-flex items-center justify-center hover:bg-muted"
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
              </div>
            </>
          )}
        </div>

        {/* 우측 정보 패널 — 노드 선택 시 표시.
            relative z-10 으로 G6 의 canvas/html 레이어보다 위에 stacking. */}
        {selected && (
          <aside className="relative z-10 w-[22rem] shrink-0 border-l border-border bg-card overflow-auto p-4">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <div className="text-lg font-semibold truncate">
                {selected.name}
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="닫기"
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <table className="w-full text-sm border-collapse">
              <tbody>
                <InfoRow label="사번" value={selected.employee_no ?? "-"} mono />
                <InfoRow label="직위" value={selected.rank_name ?? "-"} />
                <InfoRow label="직책" value={selected.position_name ?? "-"} />
                <InfoRow label="입사일" value={selected.hire_date ?? "-"} mono />
                <InfoRow label="근무기간" value={tenure(selected.hire_date)} />
                {/* 입사 전 경력이 등록된 경우에만 '총 경력' 표시 — 0 / null
                    이면 근무기간과 동일해 중복이라 숨김. */}
                {selected.career_months_at_hire != null &&
                  selected.career_months_at_hire > 0 && (
                    <InfoRow
                      label="총 경력"
                      value={totalCareer(
                        selected.hire_date,
                        selected.career_months_at_hire,
                      )}
                    />
                  )}
                <InfoRow
                  label="전화번호"
                  value={selected.phone ?? "-"}
                  href={selected.phone ? `tel:${selected.phone}` : undefined}
                  mono
                />
                <InfoRow
                  label="이메일"
                  value={selected.email ?? "-"}
                  href={selected.email ? `mailto:${selected.email}` : undefined}
                />
                {/* 민감 정보 — HR/ADMIN 만 노출. */}
                {canSeeSensitive && (
                  <>
                    <InfoRow label="주소" value={selected.address ?? "-"} />
                    <InfoRow
                      label="비상연락처"
                      value={
                        selected.emergency_contact_name ||
                        selected.emergency_contact_phone
                          ? [
                              selected.emergency_contact_name,
                              selected.emergency_contact_phone,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "-"
                      }
                      href={
                        selected.emergency_contact_phone
                          ? `tel:${selected.emergency_contact_phone}`
                          : undefined
                      }
                    />
                    <InfoRow label="보안등급" value={selected.security_role} />
                  </>
                )}
                <InfoRow label="직속" value={`${selected.report_count}명`} />
              </tbody>
            </table>

            {/* 참여 프로젝트 — 클릭 시 confirm 후 해당 프로젝트로 이동. */}
            <div className="mt-4">
              <div className="text-sm text-muted-foreground mb-1.5">
                참여 프로젝트
                {assignments.length > 0 && ` (${assignments.length})`}
              </div>
              {assignments.length === 0 ? (
                <div className="text-sm text-muted-foreground">없음</div>
              ) : (
                <ul className="space-y-1">
                  {assignments.map((p) => (
                    <li key={p.assignment_id}>
                      {/* HR/ADMIN 만 클릭 시 프로젝트로 이동.
                          그 외 역할은 정보만 노출 (button → div, hover/cursor 없음). */}
                      {canSeeSensitive ? (
                        <button
                          type="button"
                          onClick={() => handleProjectClick(p)}
                          className="w-full text-left rounded-md border border-border bg-background hover:bg-muted px-2 py-1.5 text-sm"
                        >
                          <div className="font-medium truncate">
                            {p.project_name}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {p.start_date} ~ {p.end_date}
                          </div>
                        </button>
                      ) : (
                        <div className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                          <div className="font-medium truncate">
                            {p.project_name}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {p.start_date} ~ {p.end_date}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  href,
  mono,
}: {
  label: string;
  value: string;
  href?: string;
  /** 숫자·연락처용 등폭 — tabular-nums + mono. */
  mono?: boolean;
}) {
  return (
    <tr className="border-b border-border/40 last:border-0 align-top">
      <th className="text-left text-sm text-muted-foreground font-normal pr-3 py-1.5 whitespace-nowrap">
        {label}
      </th>
      <td
        className={
          "text-right text-sm py-1.5 break-all " +
          (mono ? "tabular-nums" : "")
        }
      >
        {href && value !== "-" ? (
          <a href={href} className="text-primary hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </td>
    </tr>
  );
}

