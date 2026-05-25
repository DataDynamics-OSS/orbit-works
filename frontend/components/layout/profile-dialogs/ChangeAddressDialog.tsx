"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { SavedAtLabel } from "@/components/ui/SavedAtLabel";

type MyProfile = {
  developer_id: string;
  name: string;
  company_email: string | null;
  phone: string | null;
  hire_date: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

export function ChangeAddressDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [address, setAddress] = useState("");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const { data, isLoading } = useQuery<MyProfile>({
    queryKey: ["my-profile"],
    queryFn: async () => (await api.get("/developers/me/profile")).data,
    enabled: open,
  });

  useEffect(() => {
    if (data) setAddress(data.address || "");
  }, [data]);

  // 모달이 닫혔다가 다시 열리면 라벨 리셋.
  useEffect(() => {
    if (!open) setSavedAt(null);
  }, [open]);

  const mut = useMutation({
    mutationFn: async () => {
      return (
        await api.patch("/developers/me/profile", { address })
      ).data as MyProfile;
    },
    onSuccess: (next) => {
      qc.setQueryData(["my-profile"], next);
      setSavedAt(new Date());
    },
    onError: async (e: unknown) => {
      const msg =
        (e as AxiosError<{ detail?: string }>)?.response?.data?.detail ||
        "주소 저장 실패";
      await dialog.alert(msg);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="주소 변경"
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
      <label className="block">
        <div className="mb-1 text-xs text-muted-foreground">주소</div>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="예: 서울특별시 강남구 …"
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        />
      </label>
    </Dialog>
  );
}
