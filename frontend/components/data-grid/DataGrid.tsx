"use client";

import { ReactNode, forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridReadyEvent,
  RowClickedEvent,
  RowDoubleClickedEvent,
  SelectionChangedEvent,
  SizeColumnsToContentStrategy,
  SizeColumnsToFitGridStrategy,
  SizeColumnsToFitProvidedWidthStrategy,
} from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";

/**
 * Server-side pagination 모드. 지정 시 AG Grid 내장 pagination 은 비활성화되고
 * 그리드 하단에 커스텀 페이저가 렌더됨. 부모가 page/pageSize state 를 소유하고
 * API 호출을 직접 트리거. rowData 는 "현재 페이지" 의 row 만 들어와야 함.
 *
 * 부모 측 권장 패턴:
 *
 * ```tsx
 * const [page, setPage] = useState(1);
 * const [pageSize, setPageSize] = useState(50);
 *
 * // 필터 변경 시 1페이지로 자동 리셋 — useRef 로 직전 키 비교.
 * const filterKey = `${q}|${status}`;
 * const lastKeyRef = useRef(filterKey);
 * if (lastKeyRef.current !== filterKey) {
 *   lastKeyRef.current = filterKey;
 *   if (page !== 1) setPage(1);
 * }
 *
 * const { data } = useQuery({
 *   queryKey: ["foo", q, status, page, pageSize],
 *   queryFn: () => api.get("/foo", { params: { q, status, page, page_size: pageSize } }),
 *   placeholderData: (prev) => prev, // 페이지 전환 깜빡임 방지.
 * });
 *
 * <DataGrid
 *   rowData={data?.items ?? []}
 *   columnDefs={cols}
 *   serverPagination={{
 *     page,
 *     pageSize,
 *     totalCount: data?.total ?? 0,
 *     onPageChange: setPage,
 *     onPageSizeChange: (n) => { setPageSize(n); setPage(1); },
 *     pageSizeOptions: [20, 50, 100, 200, 500],
 *   }}
 * />
 * ```
 *
 * 백엔드 응답은 `{ items, total, page, page_size }` 형태여야 totalCount 가 정확.
 */
export type ServerPagination = {
  page: number;            // 1-based
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
};

export type DataGridHandle<T> = {
  getSelectedRows: () => T[];
  deselectAll: () => void;
};

type Props<T> = {
  rowData: T[];
  columnDefs: ColDef<T>[];
  getRowId?: (row: T) => string;
  onRowClicked?: (row: T) => void;
  onRowDoubleClicked?: (row: T) => void;
  onAdd?: () => void;
  /** onAdd 버튼의 라벨. 기본 '추가'. */
  addLabel?: string;
  onDelete?: (selected: T[]) => void;
  onSearch?: (q: string) => void;
  searchPlaceholder?: string;
  /** 우측 버튼 그룹의 *맨 앞* (onAdd 보다 왼쪽) 슬롯. 필터 토글 등. */
  toolbarLeading?: ReactNode;
  extraActions?: ReactNode;
  autoSizeStrategy?:
    | SizeColumnsToFitGridStrategy
    | SizeColumnsToFitProvidedWidthStrategy
    | SizeColumnsToContentStrategy;
  /** If omitted, the grid stretches to fill its flex parent (recommended). */
  height?: number | string;
  /**
   * true 이면 AG Grid `domLayout="autoHeight"` — 그리드가 행 수만큼 늘어나 내부
   * 세로 스크롤 없이 모든 행을 표시한다. 이때 컨테이너의 flex-1/고정 height 는
   * 적용하지 않으므로, 뷰포트를 넘치는 경우 페이지(상위) 스크롤로 처리해야 한다.
   * height 와 동시 사용 금지 (autoHeight 우선).
   */
  autoHeight?: boolean;
  pageSize?: number;
  pageSizeOptions?: number[];
  enableCheckbox?: boolean;
  deleteDisabledWhenEmpty?: boolean;
  pagination?: boolean;
  /** 툴바의 검색 입력창을 숨김. onAdd/onDelete/extraActions 도 없으면 툴바 전체가 사라진다. */
  hideSearch?: boolean;
  /** 조밀 모드 — 셀 폰트를 한 단계 축소 (text-sm → text-xs). */
  compact?: boolean;
  /** true 이면 모든 컬럼의 헤더 필터 버튼을 숨김. 정렬은 유지. */
  disableFilters?: boolean;
  /** 체크박스 선택 변경 시 호출 — extraActions 버튼에 (개수) 표시 등에 사용. */
  onSelectionChange?: (count: number) => void;
  /** 셀 인라인 편집 커밋 시 호출. ColDef.editable 이 true 인 셀에만 발생. */
  onCellValueChanged?: (e: any) => void;
  /** 서버 페이지네이션 모드 — 지정 시 AG Grid 내장 pagination 비활성 + 커스텀 footer. */
  serverPagination?: ServerPagination;
  /**
   * Full-width row 지원 (community). 특정 행을 모든 컬럼을 가로지르는 단일 셀로
   * 렌더 — 예: 고객사별 그룹 밴드. fullWidthCellRenderer 와 함께 사용.
   */
  isFullWidthRow?: (params: any) => boolean;
  fullWidthCellRenderer?: any;
  /** 행 높이를 동적으로 결정. 그룹 밴드 등 일부 행만 높이를 달리할 때. */
  getRowHeight?: (params: any) => number | undefined;
};

function DataGridInner<T>(
  {
    rowData,
    columnDefs,
    getRowId,
    onRowClicked,
    onRowDoubleClicked,
    onAdd,
    addLabel = "추가",
    onDelete,
    onSearch,
    searchPlaceholder = "검색",
    toolbarLeading,
    extraActions,
    autoSizeStrategy,
    height,
    autoHeight = false,
    pageSize = 50,
    pageSizeOptions = [20, 50, 100, 200],
    enableCheckbox = true,
    deleteDisabledWhenEmpty = true,
    pagination = true,
    hideSearch = false,
    compact = false,
    disableFilters = false,
    onSelectionChange,
    onCellValueChanged,
    serverPagination,
    isFullWidthRow,
    fullWidthCellRenderer,
    getRowHeight,
  }: Props<T>,
  ref: React.Ref<DataGridHandle<T>>,
) {
  const gridRef = useRef<AgGridReact<T>>(null);
  const [q, setQ] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);
  // 사용자가 그리드 footer 의 page size 셀렉터로 변경한 값 추적. 부모의
  // 재렌더(예: rowData 갱신) 마다 prop pageSize 가 그대로 다시 내려와 AG Grid
  // 의 내부 상태를 덮는 문제 회피.
  const [currentPageSize, setCurrentPageSize] = useState(pageSize);

  const showCheckbox = enableCheckbox && !!onDelete;

  // v32.2+ 의 rowSelection 객체 형태로 체크박스/헤더 체크박스 제어. 컬럼 def
  // 별 checkboxSelection/headerCheckboxSelection 은 deprecated 라 grid option
  // 에서 일괄 지정. selectionColumnDef 가 자동으로 첫 번째 컬럼 위치에 가상
  // 선택 컬럼을 만든다.
  const rowSelectionOptions = useMemo(() =>
    showCheckbox
      ? ({
          mode: "multiRow",
          checkboxes: true,
          headerCheckbox: true,
          enableClickSelection: false,
        } as const)
      : ({ mode: "singleRow", checkboxes: false, enableClickSelection: true } as const),
    [showCheckbox],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, filter: !disableFilters, resizable: true, flex: 1, minWidth: 100 }),
    [disableFilters],
  );

  useImperativeHandle(ref, () => ({
    getSelectedRows: () => (gridRef.current?.api.getSelectedRows() as T[]) ?? [],
    deselectAll: () => gridRef.current?.api.deselectAll(),
  }));

  function applyQuickFilter(value: string) {
    if (onSearch) {
      onSearch(value);
      return;
    }
    gridRef.current?.api.setGridOption("quickFilterText", value);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      applyQuickFilter(q);
    } else if (e.key === "Escape") {
      setQ("");
      applyQuickFilter("");
    }
  }

  function handleDelete() {
    if (!onDelete) return;
    const rows = gridRef.current?.api.getSelectedRows() as T[];
    if (!rows || rows.length === 0) return;
    onDelete(rows);
  }

  function onSelectionChanged(e: SelectionChangedEvent<T>) {
    const n = e.api.getSelectedRows().length;
    setSelectedCount(n);
    onSelectionChange?.(n);
  }

  function onGridReady(_e: GridReadyEvent<T>) {
    // noop for now; place for default grid state in future
  }

  function onRowClickedInternal(e: RowClickedEvent<T>) {
    if (onRowClicked && e.data) onRowClicked(e.data);
  }

  function onRowDoubleClickedInternal(e: RowDoubleClickedEvent<T>) {
    if (onRowDoubleClicked && e.data) onRowDoubleClicked(e.data);
  }

  const showToolbar =
    !hideSearch || !!onAdd || !!onDelete || !!extraActions || !!toolbarLeading;

  return (
    <div className={autoHeight ? "flex flex-col gap-2" : "flex flex-1 min-h-0 flex-col gap-2"}>
      {showToolbar && (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card p-2">
        {!hideSearch && (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder={searchPlaceholder + " (Enter)"}
              className="h-8 w-72 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {q ? (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  applyQuickFilter("");
                }}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted inline-flex items-center gap-1"
              >
                <X className="h-3 w-3" /> 지우기
              </button>
            ) : null}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {toolbarLeading}
          {onAdd ? (
            <button
              type="button"
              onClick={onAdd}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-3.5 w-3.5" />
              {addLabel}
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteDisabledWhenEmpty && selectedCount === 0}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs font-medium text-destructive hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              삭제{selectedCount > 0 ? ` (${selectedCount})` : ""}
            </button>
          ) : null}
          {extraActions}
        </div>
      </div>
      )}
      <div
        className={"ag-theme-quartz" + (autoHeight ? "" : " flex-1 min-h-0")}
        style={
          {
            "--ag-font-family":
              "var(--font-roboto-condensed), 'Roboto Condensed', 'Pretendard Variable', Pretendard, system-ui, sans-serif",
            // compact = 12px / 일반 = 13px (0.8125rem). 0.875rem(=14px) 에서 1px 축소.
            "--ag-font-size": compact ? "0.75rem" : "0.8125rem",
            ...(!autoHeight && height ? { height } : {}),
          } as React.CSSProperties
        }
      >
        <AgGridReact<T>
          ref={gridRef}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          domLayout={autoHeight ? "autoHeight" : undefined}
          getRowId={getRowId ? (p) => getRowId(p.data as T) : undefined}
          // 서버 페이지네이션이 켜져 있으면 AG Grid 내장 pagination 은 끔.
          pagination={serverPagination ? false : pagination}
          paginationPageSize={pagination && !serverPagination ? currentPageSize : undefined}
          paginationPageSizeSelector={pagination && !serverPagination ? pageSizeOptions : undefined}
          onPaginationChanged={(e) => {
            const sz = e.api?.paginationGetPageSize?.();
            if (typeof sz === "number" && sz !== currentPageSize) {
              setCurrentPageSize(sz);
            }
          }}
          rowSelection={rowSelectionOptions}
          // v32.2+ 가 selection 컬럼을 자동 생성. 폭만 통일 (이전 페이지별 25/48
          // 혼재 → 48 로 통일). pinned/sortable/filter 는 selection 컬럼 default.
          selectionColumnDef={{ width: 48, minWidth: 48, pinned: "left" }}
          onRowClicked={onRowClickedInternal}
          onRowDoubleClicked={onRowDoubleClickedInternal}
          onSelectionChanged={onSelectionChanged}
          onGridReady={onGridReady}
          onCellValueChanged={onCellValueChanged}
          autoSizeStrategy={autoSizeStrategy}
          isFullWidthRow={isFullWidthRow}
          fullWidthCellRenderer={fullWidthCellRenderer}
          getRowHeight={getRowHeight}
          animateRows
        />
      </div>
      {serverPagination && <ServerPager spec={serverPagination} compact={compact} />}
    </div>
  );
}

function ServerPager({
  spec,
  compact,
}: {
  spec: ServerPagination;
  compact?: boolean;
}) {
  const { page, pageSize, totalCount, onPageChange, onPageSizeChange } = spec;
  const options = spec.pageSizeOptions ?? [20, 50, 100, 200, 500];
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const startRow = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, totalCount);
  const fontCls = compact ? "text-[11px]" : "text-xs";
  const canPrev = page > 1;
  const canNext = page < totalPages;
  const btn =
    "h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed";
  return (
    <div
      className={
        "flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border " +
        fontCls
      }
    >
      <div className="tabular-nums text-muted-foreground">
        {totalCount.toLocaleString()} 건 중{" "}
        <span className="text-foreground">
          {startRow.toLocaleString()} - {endRow.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">페이지당</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="h-7 rounded-md border border-border bg-background px-2 tabular-nums"
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1 ml-2">
          <button
            type="button"
            onClick={() => onPageChange(1)}
            disabled={!canPrev}
            className={btn}
            aria-label="첫 페이지"
          >
            <ChevronFirst className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={!canPrev}
            className={btn}
            aria-label="이전"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="px-2 tabular-nums">
            {page.toLocaleString()} / {totalPages.toLocaleString()}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={!canNext}
            className={btn}
            aria-label="다음"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onPageChange(totalPages)}
            disabled={!canNext}
            className={btn}
            aria-label="마지막 페이지"
          >
            <ChevronLast className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// forwardRef + generics needs cast
export const DataGrid = forwardRef(DataGridInner) as <T>(
  props: Props<T> & { ref?: React.Ref<DataGridHandle<T>> },
) => ReturnType<typeof DataGridInner>;
