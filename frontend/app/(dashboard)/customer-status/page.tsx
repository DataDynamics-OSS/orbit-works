"use client";

/**
 * 라이센스 현황 — 목록 페이지.
 *
 * (customer × project × system) 단위 카드. 라이센스 / 담당자 / 첨부 등은
 * 상세 페이지에서 편집. 신규 다이얼로그는 식별 3축(고객사·프로젝트·시스템) 만
 * 받고 POST → 상세로 이동.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { FileText } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DataGrid, type DataGridHandle } from "@/components/data-grid/DataGrid";

type CustomerStatusRow = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  project_id: string;
  project_name: string | null;
  system_name: string;
  environment: "PROD" | "STAGING" | "DEV";
  runtime_type: "VM" | "BAREMETAL" | "KUBERNETES" | "DOCKER";
  vendor_name: string | null;
  product_name: string | null;
  version_name: string | null;
  version_detail: string | null;
  license_label: string | null;
  license_quantity: number | null;
  license_start_date: string | null;
  license_end_date: string | null;
  customer_contact_name: string | null;
  tech_support_user_name: string | null;
  created_by_name: string | null;
  attachment_count: number;
  updated_at: string;
};

type Customer = { id: string; name: string };
type Project = { id: string; name: string; customer_id: string };
type License = {
  id: string;
  customer_id: string;
  product_name: string;
  start_date: string;
  end_date: string;
};

export default function CustomerStatusPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  // 선택된 row 로 PDF 인쇄 — DataGrid 의 ref/onSelectionChange 활용.
  const gridRef = useRef<DataGridHandle<CustomerStatusRow>>(null);
  const [selectedCount, setSelectedCount] = useState(0);

  const { data: rows = [] } = useQuery<CustomerStatusRow[]>({
    queryKey: ["customer-status", q],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (q.trim()) params.q = q.trim();
      return (await api.get("/customer-status", { params })).data;
    },
  });

  const createM = useMutation({
    mutationFn: async (payload: {
      customer_id: string;
      project_id: string | null;
      system_name: string;
      environment: "PROD" | "STAGING" | "DEV";
      license_id: string | null;
      license_start_date: string | null;
      license_end_date: string | null;
    }) => (await api.post("/customer-status", payload)).data as CustomerStatusRow,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["customer-status"] });
      setCreateOpen(false);
      router.push(`/customer-status/${created.id}`);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "생성 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/customer-status/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customer-status"] }),
  });

  const columnDefs = useMemo<ColDef<CustomerStatusRow>[]>(
    () => ([
      {
        field: "customer_name", headerName: "고객사", width: 160, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "system_name", headerName: "시스템", flex: 1, minWidth: 140,
        headerClass: "ag-header-center",
        cellStyle: { fontWeight: 500, textAlign: "center" },
      },
      {
        field: "environment", headerName: "유형", width: 80, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) =>
          ({ PROD: "운영", STAGING: "스테이징", DEV: "개발" } as const)[
            p.value as "PROD" | "STAGING" | "DEV"
          ] ?? "",
      },
      {
        field: "runtime_type", headerName: "런타임", width: 110, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) =>
          ({
            VM: "VM",
            BAREMETAL: "Baremetal",
            KUBERNETES: "Kubernetes",
            DOCKER: "Docker",
          } as const)[
            p.value as "VM" | "BAREMETAL" | "KUBERNETES" | "DOCKER"
          ] ?? "",
      },
      {
        field: "vendor_name", headerName: "벤더", width: 110, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "product_name", headerName: "제품", width: 110, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "version_name", headerName: "버전", width: 70, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "license_quantity", headerName: "수량", width: 70, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => (p.value != null ? String(p.value) : ""),
      },
      {
        field: "license_end_date", headerName: "종료일", width: 90, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : ""),
      },
      {
        field: "customer_contact_name", headerName: "고객 담당자", width: 100, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "tech_support_user_name", headerName: "지원 담당자", width: 100, flex: 0,
        headerClass: "ag-header-center", cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value || "—",
      },
    ] as ColDef<CustomerStatusRow>[]),
    [],
  );

  function openPdfPreview() {
    const sel = gridRef.current?.getSelectedRows() ?? [];
    if (sel.length === 0) return;
    const w = window.open("", "_blank", "width=1180,height=820");
    if (!w) {
      dialog.alert("팝업 차단을 해제해 주세요.", { title: "팝업 차단" });
      return;
    }
    const html = buildPdfHtml(sel);
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  return (
    <>
      <DashboardHeader title="라이센스 현황" />
      <div className="flex flex-1 min-h-0 flex-col gap-2 p-4">
        <DataGrid<CustomerStatusRow>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          onSearch={setQ}
          searchPlaceholder="시스템·본문 검색"
          onAdd={() => setCreateOpen(true)}
          addLabel="추가"
          onDelete={(items) => {
            if (items.length === 0) return;
            dialog
              .confirm(`${items.length}건을 삭제하시겠습니까?`, {
                title: "삭제 확인",
                confirmText: "삭제",
                destructive: true,
              })
              .then((ok) => ok && deleteM.mutate(items.map((it) => it.id)));
          }}
          onSelectionChange={setSelectedCount}
          extraActions={
            <button
              type="button"
              onClick={openPdfPreview}
              disabled={selectedCount === 0}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              title="선택된 항목을 새 창에서 표 형식으로 미리보고 인쇄/PDF 저장"
            >
              <FileText className="h-3.5 w-3.5" />
              PDF{selectedCount > 0 ? ` (${selectedCount})` : ""}
            </button>
          }
          onRowClicked={(row) => router.push(`/customer-status/${row.id}`)}
          disableFilters
        />
      </div>

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          submitting={createM.isPending}
          onSubmit={(p) => createM.mutate(p)}
        />
      )}
    </>
  );
}

// HTML 이스케이프 — title/attr 양쪽에 안전. 사용자 입력 데이터가 그대로
// document.write 로 들어가므로 XSS 차단 목적.
function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPdfHtml(rows: CustomerStatusRow[]): string {
  const today = new Date();
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // 버전 / 상세 버전 — 별도 셀로 표시 (요청 명세 그대로).
  const trs = rows
    .map((r) => {
      const cells = [
        r.customer_name,
        r.system_name,
        r.vendor_name,
        r.product_name,
        r.version_name,
        r.version_detail,
        r.license_quantity != null ? String(r.license_quantity) : "",
        r.customer_contact_name,
        r.tech_support_user_name,
      ];
      return (
        "<tr>" +
        cells.map((v) => `<td>${escapeHtml(v ?? "—") || "—"}</td>`).join("") +
        "</tr>"
      );
    })
    .join("");
  // 수량 합계 — null 인 row 는 제외하고 합산. 천단위 콤마.
  const qtyTotal = rows.reduce(
    (acc, r) => acc + (r.license_quantity ?? 0),
    0,
  );
  const qtyTotalLabel = qtyTotal.toLocaleString("ko-KR");

  // 인쇄 시 페이지 폭 활용 + table 가독성 우선. 인쇄 버튼은 화면에만,
  // @media print 로 자동 숨김.
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>라이센스 현황 — ${ymd(today)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 24px;
      font-family: 'Pretendard', system-ui, -apple-system, sans-serif;
      color: #0f172a;
      font-size: 12px;
    }
    header {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-bottom: 12px; padding-bottom: 8px;
      border-bottom: 2px solid #0f172a;
    }
    header h1 { font-size: 18px; margin: 0; }
    header .meta { font-size: 11px; color: #64748b; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center;
      vertical-align: middle;
    }
    th {
      background: #f1f5f9; font-weight: 600; font-size: 11px;
      color: #334155;
    }
    tbody tr:nth-child(even) td { background: #f8fafc; }
    .toolbar {
      margin-bottom: 12px; display: flex; gap: 8px;
    }
    .toolbar button {
      padding: 6px 14px; border: 1px solid #cbd5e1; background: #fff;
      border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .toolbar button.primary { background: #0f172a; color: #fff; border-color: #0f172a; }
    @media print {
      .toolbar { display: none; }
      body { margin: 12mm; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="primary" onclick="window.print()">인쇄 / PDF 저장</button>
    <button onclick="window.close()">닫기</button>
  </div>
  <header>
    <h1>라이센스 현황</h1>
    <div class="meta">${ymd(today)} · 총 ${rows.length}건</div>
  </header>
  <table>
    <thead>
      <tr>
        <th>고객사</th>
        <th>시스템</th>
        <th>벤더</th>
        <th>제품</th>
        <th>버전</th>
        <th>상세 버전</th>
        <th>수량</th>
        <th>고객 담당자</th>
        <th>지원 담당자</th>
      </tr>
    </thead>
    <tbody>${trs}</tbody>
    <tfoot>
      <tr>
        <td colspan="6" style="text-align:right; font-weight:600; background:#f1f5f9;">합계</td>
        <td style="font-weight:700; background:#f1f5f9;">${qtyTotalLabel}</td>
        <td colspan="2" style="background:#f1f5f9;"></td>
      </tr>
    </tfoot>
  </table>
</body>
</html>`;
}


function CreateDialog({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (p: {
    customer_id: string;
    project_id: string | null;
    system_name: string;
    environment: "PROD" | "STAGING" | "DEV";
    license_id: string | null;
    license_start_date: string | null;
    license_end_date: string | null;
  }) => void;
  submitting: boolean;
}) {
  const [customerId, setCustomerId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [systemName, setSystemName] = useState("");
  const [environment, setEnvironment] = useState<"PROD" | "STAGING" | "DEV">("PROD");
  const [licenseId, setLicenseId] = useState("");
  const [licenseStart, setLicenseStart] = useState("");
  const [licenseEnd, setLicenseEnd] = useState("");

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "list-for-status"],
    queryFn: async () => (await api.get("/customers", { params: { limit: 500 } })).data?.items ?? (await api.get("/customers", { params: { limit: 500 } })).data,
    staleTime: 60_000,
  });

  // customer 선택 시 그 customer 의 프로젝트만.
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects", "by-customer", customerId],
    queryFn: async () =>
      // /projects 는 router-wide menu_permissions("projects" = SALES/HR) 게이트라
      // SUPPORT 가 못 들어가 picker 가 비어 보인다. customers 메뉴 권한자(SALES/SUPPORT)
      // 가 모두 호출 가능한 picker 전용 sub-endpoint 사용.
      (await api.get(`/customers/${customerId}/projects-picker`)).data,
    enabled: !!customerId,
    staleTime: 60_000,
  });

  // 라이센스 — 전체 받아 customer 별 클라이언트 필터링 (licenses API 가 customer 필터 미지원).
  const { data: allLicenses = [] } = useQuery<License[]>({
    queryKey: ["licenses", "all"],
    queryFn: async () => (await api.get("/licenses")).data,
    staleTime: 60_000,
  });
  const customerLicenses = useMemo(
    () => allLicenses.filter((l) => l.customer_id === customerId),
    [allLicenses, customerId],
  );

  // 라이센스 선택 시 시작일/종료일 자동 채움 — 사용자가 다이얼로그 안에서도
  // override 할 수 있도록 별도 state 로 보유. 라이센스 변경 시 매번 새 값으로 덮어씀.
  useEffect(() => {
    if (!licenseId) {
      setLicenseStart("");
      setLicenseEnd("");
      return;
    }
    const lic = customerLicenses.find((l) => l.id === licenseId);
    if (lic) {
      setLicenseStart(lic.start_date);
      setLicenseEnd(lic.end_date);
    }
  }, [licenseId, customerLicenses]);

  const select = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <Dialog
      open
      onClose={onClose}
      title="새 라이센스 현황 카드"
      width="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            disabled={!customerId || !systemName.trim() || submitting}
            onClick={() =>
              onSubmit({
                customer_id: customerId,
                project_id: projectId || null,
                system_name: systemName.trim(),
                environment,
                license_id: licenseId || null,
                license_start_date: licenseStart || null,
                license_end_date: licenseEnd || null,
              })
            }
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {submitting ? "생성 중..." : "생성 후 상세로"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">고객사 *</span>
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setProjectId("");
            }}
            className={select}
            autoFocus
          >
            <option value="">선택…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">시스템 *</span>
          <input
            value={systemName}
            onChange={(e) => setSystemName(e.target.value)}
            placeholder="예: DataLake / API Gateway / Search"
            className={select}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">시스템 유형 *</span>
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as "PROD" | "STAGING" | "DEV")}
            className={select}
          >
            <option value="PROD">운영</option>
            <option value="STAGING">스테이징</option>
            <option value="DEV">개발</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">프로젝트 (선택)</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={select}
            disabled={!customerId}
          >
            <option value="">{customerId ? "— 없음 —" : "먼저 고객사를 선택"}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">라이센스 (선택)</span>
          <select
            value={licenseId}
            onChange={(e) => setLicenseId(e.target.value)}
            className={select}
            disabled={!customerId}
          >
            <option value="">{customerId ? "— 없음 —" : "고객사 먼저"}</option>
            {customerLicenses.map((l) => (
              <option key={l.id} value={l.id}>
                {l.product_name} ({l.start_date}~{l.end_date})
              </option>
            ))}
          </select>
        </label>
        {licenseId && (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">시작일</span>
              <input
                type="date"
                value={licenseStart}
                onChange={(e) => setLicenseStart(e.target.value)}
                className={select}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">종료일</span>
              <input
                type="date"
                value={licenseEnd}
                onChange={(e) => setLicenseEnd(e.target.value)}
                className={select}
              />
            </label>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          나머지 정보(벤더·수량·담당자·본문·첨부) 는 다음 상세 페이지에서 편집합니다.
        </p>
      </div>
    </Dialog>
  );
}
