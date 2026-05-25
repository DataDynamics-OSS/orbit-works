"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  MapPin,
  MessageSquare,
  Paperclip,
  Plus,
  Replace,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { CustomerActivityDrawer } from "@/components/customers/CustomerActivityDrawer";

type Contact = { id: string; name: string; phone?: string; email?: string };

type Customer = {
  id: string;
  name: string;
  business_no?: string;
  representative?: string;
  address?: string;
  memo?: string;
  is_overseas?: boolean;
  owner_id?: string | null;
  owner_name?: string | null;
  owner_status?: string | null;
  has_related?: boolean;
  contacts: Contact[];
  business_license_name?: string;
  business_license_size?: number;
  bank_account_name?: string;
  bank_account_size?: number;
};

type CustomerForm = {
  name: string;
  business_no?: string;
  representative?: string;
  address?: string;
  memo?: string;
  is_overseas?: boolean;
  owner_id?: string | null;
  contact_name?: string;
  contact_phone?: string;
  contact_email?: string;
};

type DeveloperBrief = {
  id: string;
  name: string;
  status?: string | null;
};

type AttachmentSlug = "business-license" | "bank-account";
const ATTACHMENT_LABEL: Record<AttachmentSlug, string> = {
  "business-license": "사업자등록증",
  "bank-account": "통장 사본",
};

const BLANK: CustomerForm = { name: "" };

export default function CustomersPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<CustomerForm>(BLANK);
  const [addLicense, setAddLicense] = useState<File | null>(null);
  const [addBank, setAddBank] = useState<File | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Customer>>({});
  const [editContact, setEditContact] = useState<{
    name: string;
    phone: string;
    email: string;
  }>({ name: "", phone: "", email: "" });
  const [editError, setEditError] = useState<string | null>(null);

  // "내 담당만" 토글 — 토큰 매핑된 직원이 owner_id 인 회사만 필터.
  const [mineOnly, setMineOnly] = useState(false);
  // 활동 드로어 — 회사 1곳의 인터랙션 로그 슬라이드오버.
  // URL `?activity=<customerId>` 와 양방향 동기화 → 링크 공유·뒤로가기 지원.
  const activityCustomerId = searchParams.get("activity");
  const setActivityCustomerId = (cid: string | null) => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    if (cid) sp.set("activity", cid);
    else sp.delete("activity");
    const qs = sp.toString();
    router.replace(qs ? `/customers?${qs}` : "/customers", { scroll: false });
  };

  const { data: me } = useQuery<{
    mapped_developer_id: string | null;
    permissions?: string[];
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60 * 1000,
  });
  const myDeveloperId = me?.mapped_developer_id ?? null;
  const canManage = !!me?.permissions?.includes("customers.manage");

  const { data = [] } = useQuery<Customer[]>({
    queryKey: ["customers", { mine: mineOnly }],
    queryFn: async () =>
      (
        await api.get("/customers", {
          params: mineOnly ? { mine: true } : undefined,
        })
      ).data,
  });

  // 담당자 select 옵션. ACTIVE 직원 + 기존 owner 가 INACTIVE 라도 표시 유지를 위해
  // 별도 처리는 select 렌더 시점에서.
  const { data: developers = [] } = useQuery<DeveloperBrief[]>({
    queryKey: ["developers-active"],
    queryFn: async () => (await api.get("/developers")).data,
    staleTime: 60_000,
  });

  // Fresh customer object for the currently-open edit dialog (keeps attachments
  // / contacts in sync without closing the modal).
  const editTarget = useMemo(
    () => (editTargetId ? data.find((c) => c.id === editTargetId) ?? null : null),
    [editTargetId, data],
  );

  const createM = useMutation({
    mutationFn: async () => {
      // 담당자 입력 검증: 전화/이메일 중 하나라도 채워져 있으면 이름 필수.
      if (
        !addForm.contact_name?.trim() &&
        (addForm.contact_phone?.trim() || addForm.contact_email?.trim())
      ) {
        throw new Error(
          "담당자 전화번호 또는 이메일을 저장하려면 담당자명을 함께 입력해주세요.",
        );
      }

      const payload: Record<string, unknown> = {
        name: addForm.name,
        business_no: addForm.business_no || undefined,
        representative: addForm.representative || undefined,
        address: addForm.address || undefined,
        memo: addForm.memo || undefined,
        is_overseas: !!addForm.is_overseas,
        owner_id: addForm.owner_id || null,
      };
      if (addForm.contact_name) {
        payload.initial_contact = {
          name: addForm.contact_name,
          phone: addForm.contact_phone || undefined,
          email: addForm.contact_email || undefined,
        };
      }
      const created = (await api.post("/customers", payload)).data as Customer;
      await uploadIf(created.id, "business-license", addLicense);
      await uploadIf(created.id, "bank-account", addBank);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      setAddForm(BLANK);
      setAddLicense(null);
      setAddBank(null);
      setAddError(null);
      setAddOpen(false);
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      let msg: string;
      if (Array.isArray(d)) {
        msg = d
          .map((item: any) => {
            const field = Array.isArray(item.loc) ? item.loc.slice(1).join(".") : "";
            return field ? `${field}: ${item.msg}` : item.msg;
          })
          .join(" / ");
      } else if (typeof d === "string") {
        msg = d;
      } else {
        msg = e?.message ?? "등록 실패";
      }
      setAddError(msg);
    },
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return null;

      // 담당자 입력 검증: 전화/이메일 중 하나라도 채워져 있으면 이름 필수.
      const contactName = editContact.name.trim();
      const contactPhone = editContact.phone.trim();
      const contactEmail = editContact.email.trim();
      if (!contactName && (contactPhone || contactEmail)) {
        throw new Error(
          "담당자 전화번호 또는 이메일을 저장하려면 담당자명을 함께 입력해주세요.",
        );
      }

      const payload = {
        name: editForm.name,
        business_no: editForm.business_no || null,
        representative: editForm.representative || null,
        address: editForm.address || null,
        memo: editForm.memo || null,
        is_overseas: !!editForm.is_overseas,
        owner_id: editForm.owner_id || null,
      };
      await api.patch(`/customers/${editTargetId}`, payload);

      // Contact save — keeps only one contact per customer
      const existing = editTarget?.contacts[0] ?? null;
      const c = {
        name: contactName,
        phone: contactPhone || undefined,
        email: contactEmail || undefined,
      };
      if (existing && !c.name) {
        await api.delete(`/customers/contacts/${existing.id}`);
      } else if (existing && c.name) {
        await api.patch(`/customers/contacts/${existing.id}`, c);
      } else if (!existing && c.name) {
        await api.post(`/customers/${editTargetId}/contacts`, c);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      setEditOpen(false);
      setEditTargetId(null);
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      let msg: string;
      if (Array.isArray(d)) {
        // Pydantic validation error: [{loc, msg, type, ...}, ...]
        msg = d
          .map((item: any) => {
            const field = Array.isArray(item.loc) ? item.loc.slice(1).join(".") : "";
            return field ? `${field}: ${item.msg}` : item.msg;
          })
          .join(" / ");
      } else if (typeof d === "string") {
        msg = d;
      } else {
        msg = e?.message ?? "수정 실패";
      }
      setEditError(msg);
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/customers/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });

  const columnDefs = useMemo<ColDef<Customer>[]>(
    () => [
      { field: "name", headerName: "고객사명", flex: 0 },
      {
        colId: "owner",
        headerName: "담당자",
        flex: 0,
        valueGetter: (p) => p.data?.owner_name ?? "",
        cellRenderer: (p: any) => {
          const c: Customer | undefined = p.data;
          if (!c?.owner_name)
            return <span className="text-muted-foreground">-</span>;
          const inactive =
            c.owner_status && c.owner_status !== "ACTIVE";
          return (
            <span className={inactive ? "text-muted-foreground" : ""}>
              {c.owner_name}
              {inactive ? " (퇴사)" : ""}
            </span>
          );
        },
      },
      {
        field: "business_no",
        headerName: "사업자번호",
        flex: 0,
        valueFormatter: (p) => p.value || "-",
      },
      {
        field: "representative",
        headerName: "대표이사",
        flex: 0,
        valueFormatter: (p) => p.value || "-",
      },
      {
        colId: "business_license",
        headerName: "사업자등록증",
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) =>
          p.data?.business_license_name ? (
            <DownloadIconButton
              onClick={() =>
                downloadAttachment(p.data, "business-license", "사업자등록증")
              }
              title="사업자등록증 다운로드"
            />
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        colId: "bank_account",
        headerName: "통장사본",
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) =>
          p.data?.bank_account_name ? (
            <DownloadIconButton
              onClick={() => downloadAttachment(p.data, "bank-account", "통장사본")}
              title="통장 사본 다운로드"
            />
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        colId: "detail",
        headerName: "상세",
        flex: 0,
        sortable: false,
        filter: false,
        hide: !canManage,
        cellRenderer: (p: any) => {
          const c: Customer | undefined = p.data;
          if (!c) return null;
          // 영업기회·프로젝트·청구·라이센스·인터랙션 어디에도 row 가 없으면
          // 360° 가 사실상 빈 화면이라 아이콘을 숨김(— 회색 dash 로 대체).
          if (!c.has_related)
            return (
              <Tooltip label="연관 데이터 없음" side="top">
                <span className="text-muted-foreground/60 select-none">—</span>
              </Tooltip>
            );
          return (
            <Tooltip label="회사 360° 보기" side="top">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/customers/${c.id}`);
                }}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-primary hover:bg-muted"
                aria-label="상세"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            </Tooltip>
          );
        },
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        colId: "activity",
        headerName: "활동",
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) =>
          p.data ? (
            <Tooltip label="활동 로그 보기" side="top">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActivityCustomerId(p.data.id);
                }}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-primary hover:bg-muted"
                aria-label="활동"
              >
                <MessageSquare className="h-4 w-4" />
              </button>
            </Tooltip>
          ) : null,
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        field: "address",
        headerName: "주소",
        flex: 1,
        valueFormatter: (p) => p.value || "-",
      },
    ],
    [canManage, router],
  );

  async function handleDelete(rows: Customer[]) {
    // 영향 범위를 미리 모아 사용자에게 보여준다.
    // - blocking (invoices/licenses/procurement) 합계 > 0 → 삭제 불가 alert.
    // - 그 외(SET NULL/CASCADE) 카운트는 confirm 메시지에 함께 표시.
    type Preview = {
      blocking: {
        invoice_count: number;
        license_count: number;
        procurement_count: number;
      };
      contact_count: number;
      interaction_count: number;
      opportunity_count: number;
      project_count: number;
      license_contact_count: number;
    };
    const previews = await Promise.all(
      rows.map(async (r) => ({
        row: r,
        preview: (
          await api.get<Preview>(`/customers/${r.id}/deletion-preview`)
        ).data,
      })),
    );

    const blockedRows = previews.filter(
      (p) =>
        p.preview.blocking.invoice_count +
          p.preview.blocking.license_count +
          p.preview.blocking.procurement_count >
        0,
    );
    if (blockedRows.length > 0) {
      const detail = blockedRows
        .map((b) => {
          const bs: string[] = [];
          if (b.preview.blocking.invoice_count > 0)
            bs.push(`매출 인보이스 ${b.preview.blocking.invoice_count}`);
          if (b.preview.blocking.license_count > 0)
            bs.push(`라이센스 ${b.preview.blocking.license_count}`);
          if (b.preview.blocking.procurement_count > 0)
            bs.push(`외주조달 ${b.preview.blocking.procurement_count}`);
          return `• ${b.row.name} — ${bs.join(", ")}`;
        })
        .join("\n");
      await dialog.alert(
        "다음 회사는 연결된 청구·라이센스·조달 데이터가 있어 삭제할 수 없습니다. 먼저 해당 데이터를 정리하세요.\n\n" +
          detail,
        { title: "삭제 불가" },
      );
      return;
    }

    // 영향 요약 — 합산해서 보여주기.
    const sum = previews.reduce(
      (acc, p) => ({
        contact: acc.contact + p.preview.contact_count,
        interaction: acc.interaction + p.preview.interaction_count,
        opp: acc.opp + p.preview.opportunity_count,
        proj: acc.proj + p.preview.project_count,
        licContact: acc.licContact + p.preview.license_contact_count,
      }),
      { contact: 0, interaction: 0, opp: 0, proj: 0, licContact: 0 },
    );
    const consequences: string[] = [];
    if (sum.contact > 0)
      consequences.push(`담당자 ${sum.contact}명 → 회사 미지정`);
    if (sum.opp > 0) consequences.push(`영업기회 ${sum.opp}건 → 회사 미지정`);
    if (sum.proj > 0)
      consequences.push(`프로젝트 ${sum.proj}건 → 회사 미지정`);
    if (sum.interaction > 0)
      consequences.push(`인터랙션 ${sum.interaction}건 → 함께 삭제`);
    if (sum.licContact > 0)
      consequences.push(`라이센스 담당자 ${sum.licContact}건 → 함께 삭제`);

    const tail =
      consequences.length > 0
        ? "\n\n영향 범위:\n" + consequences.map((c) => `• ${c}`).join("\n")
        : "";
    const ok = await dialog.confirm(
      `${rows.length}개 고객사를 삭제하시겠습니까?` + tail,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(rows.map((r) => r.id));
  }

  function openEdit(row: Customer) {
    setEditTargetId(row.id);
    setEditForm({
      name: row.name,
      business_no: row.business_no ?? "",
      representative: row.representative ?? "",
      address: row.address ?? "",
      memo: row.memo ?? "",
      is_overseas: !!row.is_overseas,
      owner_id: row.owner_id ?? null,
    });
    const c = row.contacts[0];
    setEditContact({
      name: c?.name ?? "",
      phone: c?.phone ?? "",
      email: c?.email ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  return (
    <>
      <DashboardHeader title="고객사 관리" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<Customer>
          rowData={data}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="고객사명, 담당자 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "name",
              "owner",
              "business_no",
              "representative",
              "contacts_names",
              "contacts_phones",
              "business_license",
              "bank_account",
              "activity",
            ],
          }}
          extraActions={
            <label
              className={
                "h-9 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 text-sm select-none " +
                (myDeveloperId
                  ? "cursor-pointer hover:bg-muted"
                  : "opacity-50 cursor-not-allowed")
              }
              title={
                myDeveloperId
                  ? "내가 담당자로 지정된 회사만 표시"
                  : "로그인 계정에 직원 매핑이 없습니다"
              }
            >
              <input
                type="checkbox"
                disabled={!myDeveloperId}
                checked={mineOnly && !!myDeveloperId}
                onChange={(e) => setMineOnly(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              내 담당만
            </label>
          }
          // 추가·삭제는 customers.manage 권한자만. ETC 는 read-only.
          onAdd={
            canManage
              ? () => {
                  setAddForm(BLANK);
                  setAddLicense(null);
                  setAddBank(null);
                  setAddError(null);
                  setAddOpen(true);
                }
              : undefined
          }
          onDelete={canManage ? handleDelete : undefined}
          onRowDoubleClicked={openEdit}
        />
      </div>

      {/* Add modal */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="신규 고객사 등록"
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            {!addForm.name?.trim() ? (
              <Tooltip label="고객사명을 입력하세요" side="top">
                <button
                  type="button"
                  disabled={!addForm.name?.trim() || createM.isPending}
                  onClick={() => createM.mutate()}
                  className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {createM.isPending ? "등록 중..." : "등록"}
                </button>
              </Tooltip>
            ) : (
              <button
                type="button"
                disabled={!addForm.name?.trim() || createM.isPending}
                onClick={() => createM.mutate()}
                className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {createM.isPending ? "등록 중..." : "등록"}
              </button>
            )}
          </>
        }
      >
        {addError && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
            {addError}
          </div>
        )}
        <CustomerFormBody
          form={addForm}
          setForm={(updater) =>
            setAddForm((prev) => (typeof updater === "function" ? updater(prev) : updater))
          }
          developers={developers}
        />

        <div className="mt-2 border-t border-border pt-3 space-y-3">
          <Attachment label="사업자등록증">
            <FilePicker file={addLicense} onChange={setAddLicense} />
          </Attachment>
          <Attachment label="통장 사본">
            <FilePicker file={addBank} onChange={setAddBank} />
          </Attachment>
        </div>
      </Dialog>

      {/* Edit modal */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="고객사 수정"
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            {!editForm.name?.trim() ? (
              <Tooltip label="고객사명을 입력하세요" side="top">
                <button
                  type="button"
                  disabled={!editForm.name?.trim() || updateM.isPending}
                  onClick={() => updateM.mutate()}
                  className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {updateM.isPending ? "저장 중..." : "저장"}
                </button>
              </Tooltip>
            ) : (
              <button
                type="button"
                disabled={!editForm.name?.trim() || updateM.isPending}
                onClick={() => updateM.mutate()}
                className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {updateM.isPending ? "저장 중..." : "저장"}
              </button>
            )}
          </>
        }
      >
        {editTarget && (
          <>
            {editError && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
                {editError}
              </div>
            )}
            <CustomerFormBody
              form={{
                name: editForm.name ?? "",
                business_no: editForm.business_no ?? undefined,
                representative: editForm.representative ?? undefined,
                address: editForm.address ?? undefined,
                memo: editForm.memo ?? undefined,
                is_overseas: !!editForm.is_overseas,
                owner_id: editForm.owner_id ?? null,
              }}
              setForm={(updater) =>
                setEditForm((prev) => {
                  const curr: CustomerForm = {
                    name: prev.name ?? "",
                    business_no: prev.business_no ?? undefined,
                    representative: prev.representative ?? undefined,
                    address: prev.address ?? undefined,
                    memo: prev.memo ?? undefined,
                    is_overseas: !!prev.is_overseas,
                    owner_id: prev.owner_id ?? null,
                  };
                  const next = typeof updater === "function" ? updater(curr) : updater;
                  return { ...prev, ...next };
                })
              }
              developers={developers}
              hideContact
            />

            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-semibold mb-2">
                담당자 <span className="text-muted-foreground">(비워두면 삭제)</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  placeholder="담당자명"
                  value={editContact.name}
                  onChange={(e) =>
                    setEditContact((p) => ({ ...p, name: e.target.value }))
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <input
                  placeholder="전화번호"
                  value={editContact.phone}
                  onChange={(e) =>
                    setEditContact((p) => ({ ...p, phone: e.target.value }))
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <input
                  placeholder="이메일"
                  type="email"
                  value={editContact.email}
                  onChange={(e) =>
                    setEditContact((p) => ({ ...p, email: e.target.value }))
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mt-3 border-t border-border pt-3 space-y-3">
              <Attachment label="사업자등록증">
                <ExistingAttachment customer={editTarget} slug="business-license" />
              </Attachment>
              <Attachment label="통장 사본">
                <ExistingAttachment customer={editTarget} slug="bank-account" />
              </Attachment>
            </div>
          </>
        )}
      </Dialog>

      {activityCustomerId && (
        <CustomerActivityDrawer
          customerId={activityCustomerId}
          customerName={
            data.find((c) => c.id === activityCustomerId)?.name ?? null
          }
          ownerName={
            data.find((c) => c.id === activityCustomerId)?.owner_name ?? null
          }
          myDeveloperId={myDeveloperId}
          canManage={canManage}
          onClose={() => setActivityCustomerId(null)}
        />
      )}
    </>
  );
}

async function uploadIf(customerId: string, slug: AttachmentSlug, file: File | null) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  await api.post(`/customers/${customerId}/${slug}`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

async function downloadAttachment(
  customer: Customer,
  slug: AttachmentSlug,
  baseLabel: "사업자등록증" | "통장사본",
) {
  const storedName =
    slug === "business-license" ? customer.business_license_name : customer.bank_account_name;
  if (!storedName) return;
  const ext = storedName.includes(".") ? storedName.slice(storedName.lastIndexOf(".")) : "";
  const filename = `${customer.name}_${baseLabel}${ext}`;
  const res = await api.get(`/customers/${customer.id}/${slug}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function DownloadIconButton({
  onClick,
  title,
}: {
  onClick: () => void;
  title: string;
}) {
  return (
    <Tooltip label={title} side="top">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-primary hover:bg-muted"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </button>
    </Tooltip>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${colSpan === 2 ? "col-span-2" : ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Attachment({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 text-xs font-semibold text-muted-foreground shrink-0">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function CustomerFormBody({
  form,
  setForm,
  developers,
  hideContact,
}: {
  form: CustomerForm;
  setForm: (f: CustomerForm | ((prev: CustomerForm) => CustomerForm)) => void;
  developers: DeveloperBrief[];
  hideContact?: boolean;
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  // Kakao Map 활성화 여부 — 주소 input 옆 아이콘 노출 게이팅.
  const { data: kakaoCfg } = useQuery<{ enabled: boolean }>({
    queryKey: ["kakao-map-config"],
    queryFn: async () => (await api.get("/integrations/kakao-map")).data,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const kakaoEnabled = !!kakaoCfg?.enabled;
  // 현재 owner_id 가 ACTIVE 직원 목록에 없을 수도 있다 (퇴사·삭제). 옵션 보존을
  // 위해 누락된 경우 "(퇴사)" 라벨로 last option 추가.
  const ownerOptions = developers
    .filter((d) => !d.status || d.status === "ACTIVE")
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const ownerStillExists =
    !form.owner_id || ownerOptions.some((d) => d.id === form.owner_id);
  const inactiveOwner =
    !ownerStillExists && form.owner_id
      ? developers.find((d) => d.id === form.owner_id)
      : null;
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="고객사명 *" colSpan={2}>
        <input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label="사업자번호">
        <input
          value={form.business_no ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, business_no: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label="대표이사">
        <input
          value={form.representative ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, representative: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label="담당자 (Owner)" colSpan={2}>
        <select
          value={form.owner_id ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, owner_id: e.target.value || null }))
          }
          className={input}
        >
          <option value="">미지정</option>
          {ownerOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          {inactiveOwner && (
            <option value={inactiveOwner.id}>
              {inactiveOwner.name} (퇴사)
            </option>
          )}
        </select>
      </Field>
      <Field label="주소" colSpan={2}>
        <div className="flex items-center gap-1">
          <input
            value={form.address ?? ""}
            onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
            className={input}
          />
          {kakaoEnabled && form.address && form.address.trim() && (
            <Tooltip label="카카오맵에서 보기" side="top">
              <a
                href={`https://map.kakao.com/?q=${encodeURIComponent(form.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="카카오맵에서 보기"
                className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border border-input bg-background text-primary hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
              </a>
            </Tooltip>
          )}
        </div>
      </Field>
      <Field label="메모" colSpan={2}>
        <textarea
          value={form.memo ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
          rows={2}
          className={input}
        />
      </Field>

      {!hideContact && (
        <div className="col-span-2 mt-2 border-t border-border pt-3">
          <div className="text-xs font-semibold mb-2">담당자 (선택)</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="담당자명">
              <input
                value={form.contact_name ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, contact_name: e.target.value }))}
                className={input}
              />
            </Field>
            <Field label="담당자 전화번호">
              <input
                value={form.contact_phone ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, contact_phone: e.target.value }))}
                className={input}
              />
            </Field>
            <Field label="담당자 이메일" colSpan={2}>
              <input
                type="email"
                value={form.contact_email ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, contact_email: e.target.value }))}
                className={input}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function FilePicker({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
      >
        <Paperclip className="h-3.5 w-3.5" />
        파일 선택
      </button>
      <span className="text-xs text-muted-foreground truncate">
        {file ? file.name : "선택된 파일 없음"}
      </span>
      {file && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="지우기"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <input
        ref={ref}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          onChange(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ExistingAttachment({
  customer,
  slug,
}: {
  customer: Customer;
  slug: AttachmentSlug;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const ref = useRef<HTMLInputElement>(null);
  const name =
    slug === "business-license" ? customer.business_license_name : customer.bank_account_name;

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(`/customers/${customer.id}/${slug}`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/customers/${customer.id}/${slug}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {name ? (
        <a
          href={`/api/v1/customers/${customer.id}/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline truncate"
        >
          {name}
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">첨부된 파일 없음</span>
      )}
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
      >
        {name ? (
          <>
            <Replace className="h-3.5 w-3.5" />
            교체
          </>
        ) : (
          <>
            <Upload className="h-3.5 w-3.5" />
            업로드
          </>
        )}
      </button>
      {name && (
        <button
          type="button"
          onClick={async () => {
            if (await dialog.confirm("삭제하시겠습니까?", { destructive: true })) {
              deleteM.mutate();
            }
          }}
          className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
          삭제
        </button>
      )}
      <input
        ref={ref}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadM.mutate(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
