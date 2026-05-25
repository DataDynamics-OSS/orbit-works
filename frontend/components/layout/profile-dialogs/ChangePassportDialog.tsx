"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { DateInput } from "@/components/ui/DateInput";
import { useDialog } from "@/components/ui/DialogProvider";
import { SavedAtLabel } from "@/components/ui/SavedAtLabel";

type PassportType = "REGULAR" | "OFFICIAL" | "DIPLOMATIC";
type Gender = "M" | "F";

type Passport = {
  passport_number: string | null;
  gender: Gender | null;
  surname_en: string | null;
  given_name_en: string | null;
  nationality: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  issue_country: string | null;
  passport_type: PassportType | null;
};

const EMPTY: Passport = {
  passport_number: "",
  gender: null,
  surname_en: "",
  given_name_en: "",
  nationality: "",
  issue_date: null,
  expiry_date: null,
  issue_country: "",
  passport_type: null,
};

export function ChangePassportDialog({
  open,
  onClose,
  developerId,
}: {
  open: boolean;
  onClose: () => void;
  developerId: string;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [form, setForm] = useState<Passport>(EMPTY);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) setSavedAt(null);
  }, [open]);

  const { data, isLoading } = useQuery<Passport | null>({
    queryKey: ["my-passport", developerId],
    queryFn: async () => {
      try {
        return (await api.get(`/developers/${developerId}/passport`)).data;
      } catch (e) {
        // 404 = 미등록 — 빈 폼으로 시작.
        if ((e as AxiosError).response?.status === 404) return null;
        throw e;
      }
    },
    enabled: open,
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    if (data) setForm({ ...EMPTY, ...data });
    else setForm(EMPTY);
  }, [data, open]);

  const mut = useMutation({
    mutationFn: async () => {
      return (
        await api.put(`/developers/${developerId}/passport`, {
          passport_number: form.passport_number || null,
          gender: form.gender,
          surname_en: form.surname_en || null,
          given_name_en: form.given_name_en || null,
          nationality: form.nationality || null,
          issue_date: form.issue_date,
          expiry_date: form.expiry_date,
          issue_country: form.issue_country || null,
          passport_type: form.passport_type,
        })
      ).data;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-passport", developerId] });
      setSavedAt(new Date());
    },
    onError: async (e: unknown) => {
      const msg =
        (e as AxiosError<{ detail?: string }>)?.response?.data?.detail ||
        "여권 정보 저장 실패";
      await dialog.alert(msg);
    },
  });

  function set<K extends keyof Passport>(key: K, value: Passport[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="여권정보 변경"
      width="max-w-xl"
      footer={
        <>
          <SavedAtLabel at={savedAt} autoHideMs={4000} />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {savedAt ? "닫기" : "취소"}
          </button>
          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || isLoading}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mut.isPending ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="여권번호" className="col-span-2">
          <input
            type="text"
            value={form.passport_number || ""}
            onChange={(e) => set("passport_number", e.target.value)}
            placeholder="M12345678"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
        </Field>
        <Field label="성 (영문)">
          <input
            type="text"
            value={form.surname_en || ""}
            onChange={(e) => set("surname_en", e.target.value.toUpperCase())}
            placeholder="HONG"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
        </Field>
        <Field label="이름 (영문)">
          <input
            type="text"
            value={form.given_name_en || ""}
            onChange={(e) => set("given_name_en", e.target.value.toUpperCase())}
            placeholder="GILDONG"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
        </Field>
        <Field label="성별">
          <select
            value={form.gender || ""}
            onChange={(e) =>
              set("gender", (e.target.value || null) as Gender | null)
            }
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">선택</option>
            <option value="M">M (남)</option>
            <option value="F">F (여)</option>
          </select>
        </Field>
        <Field label="국적 (ISO 3자, 예: KOR)">
          <input
            type="text"
            value={form.nationality || ""}
            onChange={(e) =>
              set("nationality", e.target.value.toUpperCase().slice(0, 3))
            }
            placeholder="KOR"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
        </Field>
        <Field label="발급일">
          <DateInput
            value={form.issue_date || ""}
            onChange={(v) => set("issue_date", v || null)}
          />
        </Field>
        <Field label="만료일">
          <DateInput
            value={form.expiry_date || ""}
            onChange={(v) => set("expiry_date", v || null)}
          />
        </Field>
        <Field label="발급국가">
          <input
            type="text"
            value={form.issue_country || ""}
            onChange={(e) => set("issue_country", e.target.value)}
            placeholder="대한민국"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
        </Field>
        <Field label="여권 종류">
          <select
            value={form.passport_type || ""}
            onChange={(e) =>
              set(
                "passport_type",
                (e.target.value || null) as PassportType | null,
              )
            }
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">선택</option>
            <option value="REGULAR">일반</option>
            <option value="OFFICIAL">관용</option>
            <option value="DIPLOMATIC">외교관</option>
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}
