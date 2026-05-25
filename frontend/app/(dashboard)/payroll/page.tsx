"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";

type Status = "DRAFT" | "FINAL" | "PAID";

type PayrollRun = {
  id: string;
  year: number;
  month: number;
  status: Status;
  pay_date: string | null;
  is_year_end_adjustment: boolean;
  memo: string | null;
  item_count: number;
  total_gross_taxable: string;
  total_gross_nontax: string;
  total_deduction: string;
  total_net_pay: string;
  created_at?: string;
};

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: "작성 중",
  FINAL: "최종 확정",
  PAID: "지급 완료",
};

const STATUS_COLOR: Record<Status, string> = {
  DRAFT: "bg-amber-50 border-amber-300 text-amber-800",
  FINAL: "bg-sky-50 border-sky-300 text-sky-700",
  PAID: "bg-emerald-50 border-emerald-300 text-emerald-700",
};

function fmtKrw(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ko-KR") + "원";
}

export default function PayrollListPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [addOpen, setAddOpen] = useState(false);

  const { data: runs = [] } = useQuery<PayrollRun[]>({
    queryKey: ["payroll-runs", year],
    queryFn: async () =>
      (await api.get("/payroll/runs", { params: { year } })).data,
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/payroll/runs/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["payroll-runs"] }),
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "삭제 실패",
      );
    },
  });

  const grouped = useMemo(() => {
    return [...runs].sort((a, b) =>
      a.year === b.year ? b.month - a.month : b.year - a.year,
    );
  }, [runs]);

  return (
    <>
      <DashboardHeader
        title="급여 회차"
        actions={
          <div className="flex gap-2 items-center">
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y - 1)}
              aria-label="이전 연도"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y + 1)}
              aria-label="다음 연도"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-3.5 w-3.5" />
              새 회차
            </button>
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {grouped.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            해당 연도에 등록된 급여 회차가 없습니다.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {grouped.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-border bg-card p-4 shadow-sm flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <Link
                    href={`/payroll/${r.id}`}
                    className="text-lg font-semibold hover:underline"
                  >
                    {r.year}년 {String(r.month).padStart(2, "0")}월
                    {r.is_year_end_adjustment ? " (연말정산)" : ""}
                  </Link>
                  <span
                    className={
                      "inline-flex items-center h-6 rounded-md border px-2 text-[11px] font-medium " +
                      STATUS_COLOR[r.status]
                    }
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  지급일: {r.pay_date ?? "-"} · 인원 {r.item_count}명
                </div>
                <dl className="grid grid-cols-2 gap-1 text-xs tabular-nums">
                  <dt className="text-muted-foreground">총 과세</dt>
                  <dd className="text-right">{fmtKrw(r.total_gross_taxable)}</dd>
                  <dt className="text-muted-foreground">총 비과세</dt>
                  <dd className="text-right">{fmtKrw(r.total_gross_nontax)}</dd>
                  <dt className="text-muted-foreground">총 공제</dt>
                  <dd className="text-right">{fmtKrw(r.total_deduction)}</dd>
                  <dt className="font-medium">실수령 합계</dt>
                  <dd className="text-right font-semibold">
                    {fmtKrw(r.total_net_pay)}
                  </dd>
                </dl>
                <div className="flex gap-2 mt-1">
                  <Link
                    href={`/payroll/${r.id}`}
                    className="flex-1 h-7 rounded-md border border-border bg-background px-3 text-xs inline-flex items-center justify-center gap-1 hover:bg-muted"
                  >
                    상세 보기
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                  {r.status === "DRAFT" && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          await dialog.confirm(
                            `${r.year}년 ${r.month}월 회차를 삭제하시겠습니까? (DRAFT 만 가능)`,
                            { destructive: true },
                          )
                        ) {
                          deleteM.mutate(r.id);
                        }
                      }}
                      className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
                    >
                      <Trash2 className="h-3 w-3" />
                      삭제
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AddRunDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        defaultYear={year}
        onCreated={(id) => {
          setAddOpen(false);
          router.push(`/payroll/${id}`);
        }}
      />
    </>
  );
}

function AddRunDialog({
  open,
  onClose,
  defaultYear,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultYear: number;
  onCreated: (id: string) => void;
}) {
  const dialog = useDialog();
  const today = new Date();
  const [year, setY] = useState(defaultYear);
  const [month, setM] = useState(today.getMonth() + 1);
  const [payDate, setPayDate] = useState<string>(() => {
    const d = new Date(today.getFullYear(), today.getMonth(), 25);
    return d.toISOString().slice(0, 10);
  });
  const [isYE, setIsYE] = useState(false);
  const [memo, setMemo] = useState("");

  const createM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/payroll/runs", {
          year,
          month,
          pay_date: payDate || null,
          is_year_end_adjustment: isYE,
          memo: memo || null,
        })
      ).data as { id: string },
    onSuccess: (d) => onCreated(d.id),
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "회차 생성 실패",
      );
    },
  });

  const input =
    "w-full h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="새 급여 회차"
      width="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            disabled={createM.isPending}
            onClick={() => createM.mutate()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {createM.isPending ? "생성 중..." : "생성"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">연도</span>
          <input
            type="number"
            value={year}
            onChange={(e) => setY(Number(e.target.value))}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">월</span>
          <input
            type="number"
            min={1}
            max={12}
            value={month}
            onChange={(e) => setM(Number(e.target.value))}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-xs text-muted-foreground">지급일</span>
          <DateInput
            value={payDate}
            onChange={(v) => setPayDate(v)}
          />
        </label>
        <label className="flex items-center gap-2 col-span-2 text-sm">
          <input
            type="checkbox"
            checked={isYE}
            onChange={(e) => setIsYE(e.target.checked)}
          />
          연말정산 회차 (환급/추가징수 컬럼 노출)
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-xs text-muted-foreground">메모</span>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className={input}
          />
        </label>
        <p className="col-span-2 text-xs text-muted-foreground">
          회차를 생성하면 활성 직원 전체가 자동으로 추가되며, 정규직/자사화는
          월급 기반 기본급 + 식대 20만원이 프리필됩니다. 프리랜서는 3.3% 원천징수
          모드로 들어갑니다.
        </p>
      </div>
    </Dialog>
  );
}
