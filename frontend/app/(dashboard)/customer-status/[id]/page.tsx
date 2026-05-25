"use client";

/**
 * 라이센스 현황 — 상세 페이지.
 *
 * KB 의 표시/편집 토글 + TOC + TipTap 패턴을 그대로 차용. 메타 필드만 도메인에
 * 맞게 customer/project/system/license/contact/tech-support 로 교체.
 *
 * 첨부는 KB 보다 한 단계 더 — multi-upload + 미리보기(이미지/PDF) + 파일명
 * 변경 + 삭제 + 다운로드. 미리보기는 PreviewDialog 컴포넌트가 mime_type 별로
 * 처리 (이미지 = <img>, PDF = <iframe>, 그 외 = 다운로드 안내).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Download,
  Edit2,
  Eye,
  FileText,
  ListOrdered,
  Paperclip,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { TipTapEditor, TipTapViewer } from "@/components/board/TipTapEditor";
import { CatalogTriple } from "@/components/catalog/CatalogTriple";
import { KbToc, applyHeadingIds, extractKbHeadings } from "@/components/kb/KbToc";

type Attachment = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  uploaded_by: string | null;
  created_at: string;
};

type Detail = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  project_id: string | null;
  project_name: string | null;
  system_name: string;
  environment: "PROD" | "STAGING" | "DEV";
  runtime_type: "VM" | "BAREMETAL" | "KUBERNETES" | "DOCKER";
  vendor_id: string | null;
  vendor_name: string | null;
  product_id: string | null;
  product_name: string | null;
  version_id: string | null;
  version_name: string | null;
  version_detail: string | null;
  license_id: string | null;
  license_label: string | null;
  license_quantity: number | null;
  license_start_date: string | null;
  license_end_date: string | null;
  customer_contact_id: string | null;
  customer_contact_name: string | null;
  tech_support_user_id: string | null;
  tech_support_user_name: string | null;
  body: string | null;
  plain_text: string | null;
  created_by_user_id: string | null;
  created_by_name: string | null;
  attachments: Attachment[];
  created_at: string;
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
type Contact = { id: string; name: string; title: string | null; customer_id: string | null };
type Developer = {
  id: string;
  user_id: string | null;
  name: string;
  employment_type: string;
};

export default function CustomerStatusDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = String(params.id);

  const [editMode, setEditMode] = useState(false);
  // KB 와 동일한 TOC 영속 키 분리 (페이지간 간섭 회피).
  const [tocOpen, setTocOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("csTocOpen") !== "0";
    } catch {
      return true;
    }
  });
  const [tocWidth, setTocWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 240;
    try {
      const v = Number(localStorage.getItem("csTocWidth"));
      return Number.isFinite(v) && v >= 160 && v <= 720 ? v : 240;
    } catch {
      return 240;
    }
  });

  const { data: detail } = useQuery<Detail>({
    queryKey: ["customer-status", id],
    queryFn: async () => (await api.get(`/customer-status/${id}`)).data,
  });
  const { data: me } = useQuery<{ id: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const { data: featurePerms = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["feature-permissions"],
    queryFn: async () => (await api.get("/feature-permissions")).data,
    staleTime: 5 * 60_000,
  });
  const canEdit = useMemo(() => {
    if (!me) return false;
    if (me.role === "ADMIN" || me.role === "SUPER_ADMIN") return true;
    if (detail && detail.created_by_user_id === me.id) return true;
    return (featurePerms["customer-status.write"] ?? []).includes(me.role);
  }, [me, detail, featurePerms]);
  // 삭제 — write 와 분리. customer-status.delete 또는 작성자 본인 또는 ADMIN.
  const canDelete = useMemo(() => {
    if (!me) return false;
    if (me.role === "ADMIN" || me.role === "SUPER_ADMIN") return true;
    if (detail && detail.created_by_user_id === me.id) return true;
    return (featurePerms["customer-status.delete"] ?? []).includes(me.role);
  }, [me, detail, featurePerms]);

  if (!detail) {
    return (
      <>
        <DashboardHeader title="라이센스 현황" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="라이센스 현황"
        actions={
          <button
            type="button"
            onClick={() => router.push("/customer-status")}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 목록
          </button>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-y-auto">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            작성 {detail.created_by_name ?? "—"} · 수정 {detail.updated_at.slice(0, 10)}
          </span>
          {canEdit && !editMode && (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-muted ml-auto"
            >
              <Edit2 className="h-3.5 w-3.5" /> 편집
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const next = !tocOpen;
              setTocOpen(next);
              try {
                localStorage.setItem("csTocOpen", next ? "1" : "0");
              } catch {
                /* ignore */
              }
            }}
            className={
              "h-8 inline-flex items-center gap-1 rounded-md border px-2.5 text-xs " +
              (canEdit && !editMode ? "" : "ml-auto ") +
              (tocOpen
                ? "border-primary text-primary bg-primary/5 hover:bg-primary/10"
                : "border-border hover:bg-muted")
            }
            title="목차 패널 토글"
          >
            <ListOrdered className="h-3 w-3" /> 목차
          </button>
        </div>

        {editMode && canEdit ? (
          <EditMode
            detail={detail}
            tocOpen={tocOpen}
            tocWidth={tocWidth}
            onTocClose={() => {
              setTocOpen(false);
              try { localStorage.setItem("csTocOpen", "0"); } catch { /* ignore */ }
            }}
            onTocWidthChange={(w) => {
              setTocWidth(w);
              try { localStorage.setItem("csTocWidth", String(w)); } catch { /* ignore */ }
            }}
            onCancel={() => setEditMode(false)}
            onSaved={() => {
              setEditMode(false);
              qc.invalidateQueries({ queryKey: ["customer-status", id] });
              qc.invalidateQueries({ queryKey: ["customer-status"] });
            }}
            onDeleted={() => router.push("/customer-status")}
            canDelete={canDelete}
          />
        ) : (
          <ViewMode
            detail={detail}
            tocOpen={tocOpen}
            tocWidth={tocWidth}
            canEdit={canEdit}
            onTocClose={() => {
              setTocOpen(false);
              try { localStorage.setItem("csTocOpen", "0"); } catch { /* ignore */ }
            }}
            onTocWidthChange={(w) => {
              setTocWidth(w);
              try { localStorage.setItem("csTocWidth", String(w)); } catch { /* ignore */ }
            }}
            onAttachmentsChanged={() =>
              qc.invalidateQueries({ queryKey: ["customer-status", id] })
            }
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 표시 모드
// ---------------------------------------------------------------------------

function ViewMode({
  detail,
  tocOpen,
  tocWidth,
  canEdit,
  onTocClose,
  onTocWidthChange,
  onAttachmentsChanged,
}: {
  detail: Detail;
  tocOpen: boolean;
  tocWidth: number;
  canEdit: boolean;
  onTocClose: () => void;
  onTocWidthChange: (w: number) => void;
  onAttachmentsChanged: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(() => extractKbHeadings(detail.body), [detail.body]);
  useEffect(() => {
    applyHeadingIds(bodyRef.current);
  }, [detail.body]);

  return (
    <div className="flex flex-1 min-h-0 gap-0">
      <article className="flex-1 min-w-0 rounded-md border border-border bg-card p-4 flex flex-col gap-3 overflow-auto">
        <header className="flex flex-col gap-2 pb-3 border-b border-border">
          <h1 className="text-lg font-bold">
            {detail.customer_name ?? "—"} · {detail.system_name}
          </h1>
          <MetaTable detail={detail} />
        </header>

        <div ref={bodyRef}>
          {detail.body
            ? <TipTapViewer html={detail.body} />
            : <div className="text-xs text-muted-foreground italic">본문이 비어 있습니다.</div>}
        </div>

        <AttachmentsBlock
          entryId={detail.id}
          attachments={detail.attachments}
          canEdit={canEdit}
          onChanged={onAttachmentsChanged}
        />
      </article>

      {tocOpen && (
        <>
          <TocSeparator width={tocWidth} onChange={onTocWidthChange} />
          <KbToc headings={headings} width={tocWidth} onClose={onTocClose} />
        </>
      )}
    </div>
  );
}

const ENV_LABEL: Record<"PROD" | "STAGING" | "DEV", string> = {
  PROD: "운영",
  STAGING: "스테이징",
  DEV: "개발",
};
const RUNTIME_LABEL: Record<"VM" | "BAREMETAL" | "KUBERNETES" | "DOCKER", string> = {
  VM: "VM",
  BAREMETAL: "Baremetal",
  KUBERNETES: "Kubernetes",
  DOCKER: "Docker",
};

function MetaTable({ detail }: { detail: Detail }) {
  // 좌측 라벨 / 우측 값. 빈 값도 "—" 로 표시해 항목 누락을 한눈에 파악.
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "고객사", value: detail.customer_name },
    { label: "프로젝트", value: detail.project_name },
    { label: "시스템", value: detail.system_name },
    { label: "시스템 유형", value: ENV_LABEL[detail.environment] },
    { label: "런타임 유형", value: RUNTIME_LABEL[detail.runtime_type] },
    { label: "벤더", value: detail.vendor_name },
    { label: "제품", value: detail.product_name },
    { label: "버전", value: detail.version_name },
    { label: "상세 버전", value: detail.version_detail },
    { label: "라이센스", value: detail.license_label },
    {
      label: "수량",
      value: detail.license_quantity != null ? String(detail.license_quantity) : null,
    },
    {
      label: "라이센스 기간",
      value:
        detail.license_start_date && detail.license_end_date
          ? `${detail.license_start_date} ~ ${detail.license_end_date}`
          : null,
    },
    { label: "고객 담당자", value: detail.customer_contact_name },
    { label: "기술지원 담당자", value: detail.tech_support_user_name },
  ];
  return (
    <table className="w-full text-sm border border-border">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-b border-border last:border-b-0">
            <th
              scope="row"
              className="w-32 bg-muted/40 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground align-middle"
            >
              {r.label}
            </th>
            <td className="px-3 py-1.5 align-middle">
              {r.value ?? <span className="text-muted-foreground">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TocSeparator({
  width,
  onChange,
}: {
  width: number;
  onChange: (w: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="목차 패널 폭 조절"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let latest = startWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const onMove = (ev: MouseEvent) => {
          const delta = startX - ev.clientX;
          latest = Math.max(160, Math.min(720, startWidth + delta));
          onChange(latest);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }}
      onDoubleClick={() => onChange(240)}
      className="shrink-0 w-1 cursor-col-resize bg-border hover:bg-primary/40 transition-colors"
      title="드래그하여 폭 조절 · 더블클릭으로 기본값(240px) 복원"
    />
  );
}

// ---------------------------------------------------------------------------
// 편집 모드
// ---------------------------------------------------------------------------

function EditMode({
  detail,
  tocOpen,
  tocWidth,
  onTocClose,
  onTocWidthChange,
  onCancel,
  onSaved,
  onDeleted,
  canDelete,
}: {
  detail: Detail;
  tocOpen: boolean;
  tocWidth: number;
  onTocClose: () => void;
  onTocWidthChange: (w: number) => void;
  onCancel: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  canDelete: boolean;
}) {
  const dialog = useDialog();

  const [customerId, setCustomerId] = useState(detail.customer_id);
  const [projectId, setProjectId] = useState<string>(detail.project_id ?? "");
  const [systemName, setSystemName] = useState(detail.system_name);
  const [environment, setEnvironment] = useState<"PROD" | "STAGING" | "DEV">(detail.environment);
  const [runtimeType, setRuntimeType] = useState<"VM" | "BAREMETAL" | "KUBERNETES" | "DOCKER">(
    detail.runtime_type,
  );

  const [vendorName, setVendorName] = useState(detail.vendor_name ?? "");
  const [productName, setProductName] = useState(detail.product_name ?? "");
  const [versionName, setVersionName] = useState(detail.version_name ?? "");
  const [versionDetail, setVersionDetail] = useState(detail.version_detail ?? "");

  const [licenseId, setLicenseId] = useState<string | null>(detail.license_id ?? null);
  const [licenseQty, setLicenseQty] = useState<string>(
    detail.license_quantity != null ? String(detail.license_quantity) : "",
  );
  const [licenseStart, setLicenseStart] = useState(detail.license_start_date ?? "");
  const [licenseEnd, setLicenseEnd] = useState(detail.license_end_date ?? "");

  const [contactId, setContactId] = useState<string | null>(detail.customer_contact_id ?? null);
  const [techUserId, setTechUserId] = useState<string | null>(detail.tech_support_user_id ?? null);

  const [body, setBody] = useState(detail.body ?? "");

  const bodyRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(() => extractKbHeadings(body), [body]);
  useEffect(() => {
    applyHeadingIds(bodyRef.current);
  }, [body]);

  // 카탈로그 lookup — KB 와 동일.
  const { data: vendors = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["catalog", "vendors", "active"],
    queryFn: async () => (await api.get("/catalog/vendors")).data,
    staleTime: 60_000,
  });
  const vendorId = useMemo(
    () => vendors.find((v) => v.name === vendorName)?.id ?? null,
    [vendors, vendorName],
  );
  const { data: products = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["catalog", "products", vendorId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/products", { params: { vendor_id: vendorId } })).data,
    enabled: !!vendorId,
    staleTime: 60_000,
  });
  const productId = useMemo(
    () => products.find((p) => p.name === productName)?.id ?? null,
    [products, productName],
  );
  const { data: versions = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["catalog", "versions", productId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/versions", { params: { product_id: productId } })).data,
    enabled: !!productId,
    staleTime: 60_000,
  });
  const versionId = useMemo(
    () => versions.find((v) => v.name === versionName)?.id ?? null,
    [versions, versionName],
  );

  // 고객사 / 프로젝트 cascading.
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "list-for-status"],
    queryFn: async () =>
      (await api.get("/customers", { params: { limit: 500 } })).data?.items
        ?? (await api.get("/customers", { params: { limit: 500 } })).data,
    staleTime: 60_000,
  });
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects", "by-customer", customerId],
    queryFn: async () =>
      // /projects 는 router-wide menu_permissions("projects") 게이트로 SUPPORT 차단됨.
      // customers 메뉴 권한자가 모두 호출 가능한 picker sub-endpoint 사용.
      (await api.get(`/customers/${customerId}/projects-picker`)).data,
    enabled: !!customerId,
    staleTime: 60_000,
  });

  // 라이센스 — 전체 받아 customer 별 필터링 (licenses API 가 customer 필터 미지원).
  const { data: allLicenses = [] } = useQuery<License[]>({
    queryKey: ["licenses", "all"],
    queryFn: async () => (await api.get("/licenses")).data,
    staleTime: 60_000,
  });
  const customerLicenses = useMemo(
    () => allLicenses.filter((l) => l.customer_id === customerId),
    [allLicenses, customerId],
  );
  // license 선택 변경 시 기간을 자동으로 채워주는 UX (사용자가 override 가능).
  useEffect(() => {
    if (!licenseId) return;
    const lic = customerLicenses.find((l) => l.id === licenseId);
    if (!lic) return;
    if (!licenseStart) setLicenseStart(lic.start_date);
    if (!licenseEnd) setLicenseEnd(lic.end_date);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseId]);

  // 고객사 담당자 — 해당 customer 의 contacts.
  const { data: contacts = [] } = useQuery<Contact[]>({
    queryKey: ["customer-contacts", "by-customer", customerId],
    queryFn: async () =>
      (await api.get("/customer-contacts", { params: { customer_id: customerId } })).data,
    enabled: !!customerId,
    staleTime: 60_000,
  });

  // 임직원 — 기술지원 담당자. 정규직(FULL_TIME) + 재직자(ACTIVE) 만 picker 에 노출.
  // server-side filter — endpoint 가 employment_type / status_filter query 지원.
  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers", "for-picker", "fulltime-active"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: { employment_type: "FULL_TIME", status_filter: "ACTIVE" },
        })
      ).data,
    staleTime: 60_000,
  });

  const saveM = useMutation({
    mutationFn: async () => {
      const tmp = document.createElement("div");
      tmp.innerHTML = body || "";
      const plain = (tmp.textContent || "").trim();
      const payload = {
        customer_id: customerId,
        project_id: projectId || null,
        system_name: systemName.trim(),
        environment,
        runtime_type: runtimeType,
        vendor_id: vendorId,
        product_id: productId,
        version_id: versionId,
        version_detail: versionDetail.trim() || null,
        license_id: licenseId,
        license_quantity: licenseQty.trim() === "" ? null : Number(licenseQty),
        license_start_date: licenseStart || null,
        license_end_date: licenseEnd || null,
        customer_contact_id: contactId,
        tech_support_user_id: techUserId,
        body,
        plain_text: plain,
      };
      await api.patch(`/customer-status/${detail.id}`, payload);
    },
    onSuccess: () => onSaved(),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteEntryM = useMutation({
    mutationFn: async () => api.delete(`/customer-status/${detail.id}`),
    onSuccess: () => onDeleted(),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <Field label="고객사 *">
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setProjectId("");
              setContactId(null);
              setLicenseId(null);
            }}
            className={input}
          >
            <option value="">선택…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="시스템 *">
          <input
            value={systemName}
            onChange={(e) => setSystemName(e.target.value)}
            placeholder="예: DataLake"
            className={input}
          />
        </Field>
        <Field label="프로젝트 (선택)">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={input}
            disabled={!customerId}
          >
            <option value="">{customerId ? "— 없음 —" : "고객사 먼저"}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>

        {/* 4-col — CatalogTriple(3) + 상세 버전(1, 자유 텍스트 패치 표기). */}
        <div className="col-span-3 grid grid-cols-4 gap-3">
          <CatalogTriple
            vendor={vendorName}
            product={productName}
            version={versionName}
            onVendor={(v) => {
              setVendorName(v);
              setProductName("");
              setVersionName("");
            }}
            onProduct={(p) => {
              setProductName(p);
              setVersionName("");
            }}
            onVersion={setVersionName}
          />
          <Field label="상세 버전">
            <input
              value={versionDetail}
              onChange={(e) => setVersionDetail(e.target.value)}
              placeholder="예) 7.1.9.1080-4"
              className={input}
            />
          </Field>
        </div>

        <Field label="라이센스">
          <select
            value={licenseId ?? ""}
            onChange={(e) => setLicenseId(e.target.value || null)}
            className={input}
            disabled={!customerId}
          >
            <option value="">— 없음 —</option>
            {customerLicenses.map((l) => (
              <option key={l.id} value={l.id}>
                {l.product_name} ({l.start_date}~{l.end_date})
              </option>
            ))}
          </select>
        </Field>
        <Field label="수량">
          <input
            type="number"
            min={0}
            value={licenseQty}
            onChange={(e) => setLicenseQty(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="라이센스 기간">
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={licenseStart}
              onChange={(e) => setLicenseStart(e.target.value)}
              className={input}
            />
            <span className="text-xs text-muted-foreground">~</span>
            <input
              type="date"
              value={licenseEnd}
              onChange={(e) => setLicenseEnd(e.target.value)}
              className={input}
            />
          </div>
        </Field>

        {/* 마지막 row 만 4-col sub-grid — 시스템 유형 / 런타임 유형이 같은 줄에 인접. */}
        <div className="col-span-3 grid grid-cols-4 gap-3">
          <Field label="고객사 담당자">
            <select
              value={contactId ?? ""}
              onChange={(e) => setContactId(e.target.value || null)}
              className={input}
              disabled={!customerId}
            >
              <option value="">— 없음 —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.title ? ` (${c.title})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="기술지원 담당자">
            <select
              value={techUserId ?? ""}
              onChange={(e) => setTechUserId(e.target.value || null)}
              className={input}
            >
              <option value="">— 없음 —</option>
              {/* server 가 이미 FULL_TIME + ACTIVE 로 필터. user 매핑된 항목만.
                  이름 가나다(한국어 locale) 순. */}
              {developers
                .filter((d) => d.user_id)
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, "ko"))
                .map((d) => (
                  <option key={d.id} value={d.user_id!}>{d.name}</option>
                ))}
            </select>
          </Field>
          <Field label="시스템 유형 *">
            <select
              value={environment}
              onChange={(e) =>
                setEnvironment(e.target.value as "PROD" | "STAGING" | "DEV")
              }
              className={input}
            >
              <option value="PROD">운영</option>
              <option value="STAGING">스테이징</option>
              <option value="DEV">개발</option>
            </select>
          </Field>
          <Field label="런타임 유형 *">
            <select
              value={runtimeType}
              onChange={(e) =>
                setRuntimeType(
                  e.target.value as "VM" | "BAREMETAL" | "KUBERNETES" | "DOCKER",
                )
              }
              className={input}
            >
              <option value="VM">VM</option>
              <option value="BAREMETAL">Baremetal</option>
              <option value="KUBERNETES">Kubernetes</option>
              <option value="DOCKER">Docker</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">본문</span>
        <div className="flex min-h-[320px]">
          <div ref={bodyRef} className="flex-1 min-w-0">
            <TipTapEditor value={body} onChange={setBody} />
          </div>
          {tocOpen && (
            <>
              <TocSeparator width={tocWidth} onChange={onTocWidthChange} />
              <KbToc headings={headings} width={tocWidth} onClose={onTocClose} />
            </>
          )}
        </div>
      </div>

      <AttachmentsBlock
        entryId={detail.id}
        attachments={detail.attachments}
        canEdit
        onChanged={() => { /* parent invalidates on save */ }}
      />

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        {canDelete && (
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm(
                "이 카드와 모든 첨부를 삭제할까요?",
                { title: "삭제 확인", confirmText: "삭제", destructive: true },
              );
              if (ok) deleteEntryM.mutate();
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
          >
            <Trash2 className="h-3.5 w-3.5" /> 카드 삭제
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm"
          >
            <X className="h-3.5 w-3.5" /> 취소
          </button>
          <button
            type="button"
            disabled={saveM.isPending || !customerId || !systemName.trim()}
            onClick={() => saveM.mutate()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> {saveM.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const cls = colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 첨부 블록 — 미리보기 + 파일명 변경 + 삭제 + 다운로드 + 다중 업로드
// ---------------------------------------------------------------------------

function AttachmentsBlock({
  entryId,
  attachments,
  canEdit,
  onChanged,
}: {
  entryId: string;
  attachments: Attachment[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      await api.post(`/customer-status/${entryId}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: onChanged,
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "업로드 실패", { title: "오류" }),
  });

  const renameM = useMutation({
    mutationFn: async ({ id, file_name }: { id: string; file_name: string }) =>
      api.patch(`/customer-status/${entryId}/attachments/${id}`, { file_name }),
    onSuccess: () => {
      setRenameId(null);
      setRenameValue("");
      onChanged();
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "이름 변경 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/customer-status/${entryId}/attachments/${id}`),
    onSuccess: onChanged,
  });

  const previewAtt = useMemo(
    () => attachments.find((a) => a.id === previewId) ?? null,
    [attachments, previewId],
  );

  return (
    <section className="flex flex-col gap-2 pt-3 border-t border-border">
      <h2 className="text-xs font-semibold inline-flex items-center gap-1">
        <Paperclip className="h-3.5 w-3.5" /> 첨부 ({attachments.length})
      </h2>
      {attachments.length > 0 && (
        <ul className="flex flex-col gap-1">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              {renameId === a.id ? (
                <>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renameValue.trim())
                        renameM.mutate({ id: a.id, file_name: renameValue.trim() });
                      if (e.key === "Escape") {
                        setRenameId(null);
                        setRenameValue("");
                      }
                    }}
                    className="flex-1 h-7 rounded-md border border-input bg-background px-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={!renameValue.trim() || renameM.isPending}
                    onClick={() =>
                      renameM.mutate({ id: a.id, file_name: renameValue.trim() })
                    }
                    className="h-7 inline-flex items-center gap-1 rounded-md bg-primary px-2 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenameId(null);
                      setRenameValue("");
                    }}
                    className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 truncate">{a.file_name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtSize(a.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewId(a.id)}
                    className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
                    title="미리보기"
                  >
                    <Eye className="h-3 w-3" />
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        setRenameId(a.id);
                        setRenameValue(a.file_name);
                      }}
                      className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
                      title="이름 변경"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => downloadAttachment(entryId, a)}
                    className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
                    title="다운로드"
                  >
                    <Download className="h-3 w-3" />
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await dialog.confirm(
                          `'${a.file_name}' 첨부를 삭제할까요?`,
                          { title: "삭제 확인", confirmText: "삭제", destructive: true },
                        );
                        if (ok) deleteM.mutate(a.id);
                      }}
                      className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-2 text-xs text-destructive hover:bg-red-100"
                      title="삭제"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <FileDropZone onFiles={(arr) => arr.length > 0 && uploadM.mutate(arr)} />
      )}
      {previewAtt && (
        <PreviewDialog
          entryId={entryId}
          att={previewAtt}
          onClose={() => setPreviewId(null)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 미리보기 다이얼로그 — image/* → <img>, application/pdf → <iframe>, else → 안내
// ---------------------------------------------------------------------------

function PreviewDialog({
  entryId,
  att,
  onClose,
}: {
  entryId: string;
  att: Attachment;
  onClose: () => void;
}) {
  // 미리보기는 blob 으로 받아 object URL 생성 — Bearer 인증을 axios 가 처리하도록.
  // <img src="/api/...">  는 401 (쿠키 X). object URL 패턴이 prod·local 일관.
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let revoke: string | null = null;
    (async () => {
      try {
        const res = await api.get(
          `/customer-status/${entryId}/attachments/${att.id}/preview`,
          { responseType: "blob" },
        );
        const blobUrl = URL.createObjectURL(res.data);
        revoke = blobUrl;
        if (alive) setUrl(blobUrl);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? "불러오기 실패");
      }
    })();
    return () => {
      alive = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [entryId, att.id]);

  const mime = (att.mime_type ?? "").toLowerCase();
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf" || att.file_name.toLowerCase().endsWith(".pdf");

  return (
    <Dialog
      open
      onClose={onClose}
      title={att.file_name}
      width="max-w-4xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => downloadAttachment(entryId, att)}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <Download className="h-3.5 w-3.5" /> 다운로드
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            닫기
          </button>
        </>
      }
    >
      <div className="min-h-[60vh] flex items-center justify-center bg-muted/30 rounded">
        {err && (
          <div className="text-sm text-destructive">미리보기 실패: {err}</div>
        )}
        {!err && !url && (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        )}
        {url && isImage && (
          // 이미지 — 박스 안에 contain.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={att.file_name} className="max-h-[70vh] max-w-full object-contain" />
        )}
        {url && isPdf && (
          <iframe
            src={url}
            title={att.file_name}
            className="w-full h-[70vh] border-0 bg-white"
          />
        )}
        {url && !isImage && !isPdf && (
          <div className="text-sm text-muted-foreground p-6 text-center">
            이 파일 형식은 미리보기를 지원하지 않습니다.<br />
            다운로드 후 확인해 주세요.
          </div>
        )}
      </div>
    </Dialog>
  );
}

async function downloadAttachment(entryId: string, a: Attachment) {
  const res = await api.get(
    `/customer-status/${entryId}/attachments/${a.id}/download`,
    { responseType: "blob" },
  );
  const url = URL.createObjectURL(res.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = a.file_name;
  link.click();
  URL.revokeObjectURL(url);
}

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
