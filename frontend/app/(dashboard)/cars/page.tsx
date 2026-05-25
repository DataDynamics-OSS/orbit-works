"use client";

/**
 * 법인 차량 관리 — 카드 레이아웃 + 첨부(보험증서·등록증) 드래그&드롭.
 *
 * 백엔드 /api/v1/company-cars 의 CRUD + slot 기반 첨부 API 를 사용.
 * 카드에는 제조사·모델·연식·차량번호, 계약형태 뱃지, 보험 만료 D-day,
 * 관리자·월 납입금을 압축해서 노출. 카드 클릭 or "수정" 버튼으로 다이얼로그.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Car,
  Pencil,
  Plus,
  Replace,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Tooltip } from "@/components/ui/Tooltip";
import { sortDevelopersKo } from "@/lib/sort-developers";

type ContractType = "LEASE" | "RENT" | "OWNED";
type AttachmentSlot = "INSURANCE" | "REGISTRATION";

type Attachment = {
  id: string;
  car_id: string;
  slot: AttachmentSlot;
  file_name: string;
  mime_type?: string | null;
  size?: number | null;
};

type Car = {
  id: string;
  manufacturer: string;
  model: string;
  year: number | null;
  plate_no: string | null;
  vin: string | null;
  contract_type: ContractType;
  contract_start: string | null;
  contract_end: string | null;
  contract_company: string | null;
  insurer: string | null;
  insurer_phone: string | null;
  insurance_start: string | null;
  insurance_end: string | null;
  vehicle_price: string | null;
  monthly_payment: string | null;
  memo: string | null;
  manager_id: string | null;
  manager_name: string | null;
  attachments: Attachment[];
  created_at: string;
};

type Developer = { id: string; name: string; status: string };

type CarForm = {
  manufacturer: string;
  model: string;
  year: string;
  plate_no: string;
  vin: string;
  contract_type: ContractType;
  contract_start: string;
  contract_end: string;
  contract_company: string;
  insurer: string;
  insurer_phone: string;
  insurance_start: string;
  insurance_end: string;
  vehicle_price: string;
  monthly_payment: string;
  memo: string;
  manager_id: string;
};

const BLANK: CarForm = {
  manufacturer: "",
  model: "",
  year: "",
  plate_no: "",
  vin: "",
  contract_type: "OWNED",
  contract_start: "",
  contract_end: "",
  contract_company: "",
  insurer: "",
  insurer_phone: "",
  insurance_start: "",
  insurance_end: "",
  vehicle_price: "",
  monthly_payment: "",
  memo: "",
  manager_id: "",
};

const CONTRACT_LABEL: Record<ContractType, string> = {
  LEASE: "리스",
  RENT: "렌트",
  OWNED: "소유",
};

const CONTRACT_COLOR: Record<ContractType, string> = {
  LEASE: "bg-blue-100 text-blue-700 border-blue-200",
  RENT: "bg-orange-100 text-orange-700 border-orange-200",
  OWNED: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

const SLOT_LABEL: Record<AttachmentSlot, string> = {
  INSURANCE: "보험증서",
  REGISTRATION: "자동차 등록증",
};

function fmtKRW(v: string | number | null | undefined) {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString() + "원";
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

function insuranceBadge(iso: string | null) {
  const d = daysUntil(iso);
  if (d == null) return <span className="text-muted-foreground">보험 정보 없음</span>;
  if (d < 0)
    return (
      <span className="text-red-600 font-medium">
        보험 만료 {Math.abs(d)}일 경과 ({iso})
      </span>
    );
  if (d <= 30)
    return (
      <span className="text-amber-600 font-medium">
        보험 만료 D-{d} ({iso})
      </span>
    );
  return (
    <span className="text-muted-foreground">
      보험 만료 {iso}
    </span>
  );
}

export default function CarsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: cars = [] } = useQuery<Car[]>({
    queryKey: ["company-cars"],
    queryFn: async () => (await api.get("/company-cars")).data,
  });

  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers-active"],
    queryFn: async () => (await api.get("/developers")).data,
  });

  const activeDevs = useMemo(
    () => developers.filter((d) => d.status === "ACTIVE"),
    [developers],
  );

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CarForm>(BLANK);
  const [error, setError] = useState<string | null>(null);

  const editingCar = useMemo(
    () => (editingId ? cars.find((c) => c.id === editingId) ?? null : null),
    [editingId, cars],
  );

  function openCreate() {
    setEditingId(null);
    setForm(BLANK);
    setError(null);
    setOpen(true);
  }

  function openEdit(car: Car) {
    setEditingId(car.id);
    setForm({
      manufacturer: car.manufacturer,
      model: car.model,
      year: car.year != null ? String(car.year) : "",
      plate_no: car.plate_no ?? "",
      vin: car.vin ?? "",
      contract_type: car.contract_type,
      contract_start: car.contract_start ?? "",
      contract_end: car.contract_end ?? "",
      contract_company: car.contract_company ?? "",
      insurer: car.insurer ?? "",
      insurer_phone: car.insurer_phone ?? "",
      insurance_start: car.insurance_start ?? "",
      insurance_end: car.insurance_end ?? "",
      vehicle_price: car.vehicle_price ?? "",
      monthly_payment: car.monthly_payment ?? "",
      memo: car.memo ?? "",
      manager_id: car.manager_id ?? "",
    });
    setError(null);
    setOpen(true);
  }

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        manufacturer: form.manufacturer,
        model: form.model,
        year: form.year ? Number(form.year) : null,
        plate_no: form.plate_no || null,
        vin: form.vin || null,
        contract_type: form.contract_type,
        contract_start: form.contract_start || null,
        contract_end: form.contract_end || null,
        contract_company: form.contract_company || null,
        insurer: form.insurer || null,
        insurer_phone: form.insurer_phone || null,
        insurance_start: form.insurance_start || null,
        insurance_end: form.insurance_end || null,
        vehicle_price: form.vehicle_price || null,
        monthly_payment: form.monthly_payment || null,
        memo: form.memo || null,
        manager_id: form.manager_id || null,
      };
      if (editingId) {
        return (await api.patch(`/company-cars/${editingId}`, payload)).data as Car;
      }
      return (await api.post("/company-cars", payload)).data as Car;
    },
    onSuccess: (car) => {
      qc.invalidateQueries({ queryKey: ["company-cars"] });
      setError(null);
      if (editingId) {
        // 수정 모드: 저장 완료 후 다이얼로그 닫기.
        setOpen(false);
        setEditingId(null);
      } else {
        // 신규 등록: 편집 모드로 전환해서 첨부 업로드 가능하게 유지.
        setEditingId(car.id);
      }
    },
    onError: (e: any) => {
      setError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "저장 실패",
      );
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/company-cars/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-cars"] });
      setOpen(false);
      setEditingId(null);
    },
  });

  async function handleDelete() {
    if (!editingCar) return;
    const ok = await dialog.confirm(
      `${editingCar.manufacturer} ${editingCar.model} 차량을 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (ok) deleteM.mutate(editingCar.id);
  }

  return (
    <>
      <DashboardHeader title="법인 차량" />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            총 {cars.length}대
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-4 w-4" />
            차량 추가
          </button>
        </div>

        {cars.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
            등록된 차량이 없습니다. 우측 상단에서 "차량 추가" 로 시작하세요.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {cars.map((c) => (
              <CarCard key={c.id} car={c} onClick={() => openEdit(c)} />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setEditingId(null);
        }}
        title={editingId ? "차량 수정" : "차량 추가"}
        width="max-w-5xl"
        footer={
          <>
            {editingId && (
              <button
                type="button"
                onClick={handleDelete}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100 mr-auto"
              >
                <Trash2 className="h-4 w-4" />
                삭제
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setEditingId(null);
              }}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              닫기
            </button>
            <button
              type="button"
              disabled={!form.manufacturer || !form.model || saveM.isPending}
              onClick={() => saveM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {editingId ? (
                <>
                  <Save className="h-4 w-4" /> 저장
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> 등록
                </>
              )}
            </button>
          </>
        }
      >
        <CarFormBody
          form={form}
          setForm={setForm}
          developers={activeDevs}
        />
        {editingCar && (
          <div className="mt-4 border-t border-border pt-4 space-y-3">
            <div className="text-sm font-semibold">첨부 파일</div>
            {(["INSURANCE", "REGISTRATION"] as AttachmentSlot[]).map((slot) => (
              <AttachmentSlotEditor
                key={slot}
                carId={editingCar.id}
                slot={slot}
                existing={editingCar.attachments.find((a) => a.slot === slot) ?? null}
              />
            ))}
          </div>
        )}
        {!editingCar && (
          <div className="mt-3 text-xs text-muted-foreground">
            먼저 차량을 저장한 뒤 첨부(보험증서·등록증) 를 업로드할 수 있습니다.
          </div>
        )}
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function CarCard({ car, onClick }: { car: Car; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="button"
      className="rounded-lg border border-border bg-card p-4 shadow-sm hover:shadow-md transition cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">
            {car.manufacturer}
            {car.year ? ` · ${car.year}년식` : ""}
          </div>
          <div className="text-base font-semibold truncate">{car.model}</div>
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${CONTRACT_COLOR[car.contract_type]}`}
        >
          {CONTRACT_LABEL[car.contract_type]}
        </span>
      </div>

      <div className="text-sm font-mono text-primary mb-2">
        {car.plate_no || "차량번호 미등록"}
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">관리자</span>
          <span className="truncate">{car.manager_name || "-"}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">월 납입</span>
          <span className="tabular-nums">{fmtKRW(car.monthly_payment)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">차량가</span>
          <span className="tabular-nums">{fmtKRW(car.vehicle_price)}</span>
        </div>
        <div className="pt-1">{insuranceBadge(car.insurance_end)}</div>
      </div>

      {car.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {car.attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              📎 {SLOT_LABEL[a.slot]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form body
// ---------------------------------------------------------------------------

function CarFormBody({
  form,
  setForm,
  developers,
}: {
  form: CarForm;
  setForm: React.Dispatch<React.SetStateAction<CarForm>>;
  developers: Developer[];
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  function upd<K extends keyof CarForm>(k: K, v: CarForm[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="제조사 *">
        <input
          value={form.manufacturer}
          onChange={(e) => upd("manufacturer", e.target.value)}
          placeholder="현대·기아·BMW …"
          className={input}
        />
      </Field>
      <Field label="모델명 *">
        <input
          value={form.model}
          onChange={(e) => upd("model", e.target.value)}
          placeholder="그랜저·팰리세이드 …"
          className={input}
        />
      </Field>
      <Field label="연식 (YYYY)">
        <input
          type="number"
          inputMode="numeric"
          min={1970}
          max={2100}
          value={form.year}
          onChange={(e) => upd("year", e.target.value)}
          className={input}
        />
      </Field>
      <Field label="차량번호">
        <input
          value={form.plate_no}
          onChange={(e) => upd("plate_no", e.target.value)}
          placeholder="12가 3456"
          className={input + " font-mono"}
        />
      </Field>
      <Field label="차대번호 (VIN)" colSpan={2}>
        <input
          value={form.vin}
          onChange={(e) => upd("vin", e.target.value)}
          className={input + " font-mono"}
        />
      </Field>

      <Field label="계약형태">
        <select
          value={form.contract_type}
          onChange={(e) => upd("contract_type", e.target.value as ContractType)}
          className={input}
        >
          <option value="OWNED">소유</option>
          <option value="LEASE">리스</option>
          <option value="RENT">렌트</option>
        </select>
      </Field>
      <Field label="계약 회사">
        <input
          value={form.contract_company}
          onChange={(e) => upd("contract_company", e.target.value)}
          className={input}
        />
      </Field>
      <Field label="계약 시작일">
        <DateInput
          value={form.contract_start}
          onChange={(v) => upd("contract_start", v)}
        />
      </Field>
      <Field label="계약 종료일">
        <DateInput
          value={form.contract_end}
          onChange={(v) => upd("contract_end", v)}
        />
      </Field>

      <Field label="차량 가격 (KRW)">
        <input
          type="text"
          inputMode="numeric"
          value={formatAmt(form.vehicle_price)}
          onChange={(e) => upd("vehicle_price", stripDigits(e.target.value))}
          className={input + " text-right tabular-nums"}
        />
      </Field>
      <Field label="월 납입금 (KRW)">
        <input
          type="text"
          inputMode="numeric"
          value={formatAmt(form.monthly_payment)}
          onChange={(e) => upd("monthly_payment", stripDigits(e.target.value))}
          className={input + " text-right tabular-nums"}
        />
      </Field>

      <Field label="보험사">
        <input
          value={form.insurer}
          onChange={(e) => upd("insurer", e.target.value)}
          className={input}
        />
      </Field>
      <Field label="보험사 전화번호">
        <input
          value={form.insurer_phone}
          onChange={(e) => upd("insurer_phone", e.target.value)}
          placeholder="1588-xxxx"
          className={input}
        />
      </Field>
      <Field label="보험 시작일">
        <DateInput
          value={form.insurance_start}
          onChange={(v) => upd("insurance_start", v)}
        />
      </Field>
      <Field label="보험 종료일">
        <DateInput
          value={form.insurance_end}
          onChange={(v) => upd("insurance_end", v)}
        />
      </Field>
      <Field label="관리자" colSpan={2}>
        <select
          value={form.manager_id}
          onChange={(e) => upd("manager_id", e.target.value)}
          className={input}
        >
          <option value="">선택 없음</option>
          {sortDevelopersKo(developers).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="메모" colSpan={3}>
        <textarea
          value={form.memo}
          onChange={(e) => upd("memo", e.target.value)}
          rows={3}
          className={input}
        />
      </Field>
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
  const cls =
    colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={`flex flex-col gap-1 ${cls}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function formatAmt(s: string) {
  if (!s) return "";
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "";
}

function stripDigits(s: string) {
  return s.replace(/[^0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Attachment slot editor — 단건 업로드/교체/이름변경/삭제
// ---------------------------------------------------------------------------

function AttachmentSlotEditor({
  carId,
  slot,
  existing,
}: {
  carId: string;
  slot: AttachmentSlot;
  existing: Attachment | null;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(`/company-cars/${carId}/attachments/${slot}`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-cars"] }),
  });

  const renameM = useMutation({
    mutationFn: async (file_name: string) =>
      api.patch(`/company-cars/${carId}/attachments/${slot}`, { file_name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-cars"] }),
  });

  const deleteM = useMutation({
    mutationFn: async () =>
      api.delete(`/company-cars/${carId}/attachments/${slot}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-cars"] }),
  });

  async function handleDownload() {
    if (!existing) return;
    const res = await api.get(`/company-cars/${carId}/attachments/${slot}`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = existing.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{SLOT_LABEL[slot]}</span>
        {existing ? (
          <span className="text-[11px] text-muted-foreground">
            {(existing.size ?? 0).toLocaleString()} byte
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">미업로드</span>
        )}
      </div>

      {existing ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDownload}
            className="text-xs text-primary hover:underline truncate max-w-[200px]"
          >
            {existing.file_name}
          </button>
          <div className="flex items-center gap-1 ml-auto">
            <Tooltip label="이름 변경" side="top">
              <button
                type="button"
                onClick={async () => {
                  const next = await dialog.prompt("파일 표시명", {
                    defaultValue: existing.file_name,
                  });
                  if (next && next.trim() && next !== existing.file_name) {
                    renameM.mutate(next.trim());
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip label="교체" side="top">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
              >
                <Replace className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip label="삭제" side="top">
              <button
                type="button"
                onClick={async () => {
                  if (await dialog.confirm("첨부를 삭제하시겠습니까?", { destructive: true })) {
                    deleteM.mutate();
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-2 text-xs text-destructive hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadM.mutate(f);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <FileDropZone
          multiple={false}
          label="파일을 끌어놓거나 클릭해 업로드"
          onFiles={(files) => {
            if (files[0]) uploadM.mutate(files[0]);
          }}
        />
      )}

      {(uploadM.isPending || deleteM.isPending || renameM.isPending) && (
        <div className="text-[11px] text-muted-foreground">
          <Upload className="inline h-3 w-3 mr-1 animate-pulse" />
          처리 중...
        </div>
      )}
    </div>
  );
}
