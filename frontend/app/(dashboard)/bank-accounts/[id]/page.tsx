"use client";

/**
 * 은행 거래내역 페이지 — sidebar > 자원 > 통장 목록 row 클릭 진입.
 *
 * 권한: bank_accounts.manage (HR + ADMIN). 데스크톱 전용 (모바일 라우트 X).
 *
 * 기능:
 * - 헤더 카드: 은행/계좌/예금주 + 최신 잔액 + 마지막 거래 시각
 * - "거래내역 업로드" 버튼 → 다이얼로그
 *   · 파일 선택 (.csv, 10MB 제한)
 *   · "미리보기" → /preview API → 첫 10행 파싱 결과 테이블
 *   · "업로드" → /upload API → idempotent upsert (중복 자동 스킵)
 * - DataGrid: 거래일시 / 출금 / 입금 / 잔액 / 내용 / 상대 / 메모 / 구분
 *
 * 삭제 X — 데이터 무결성. 잘못된 row 는 DBA 가 직접 정리.
 */

import { useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ColDef,
  ICellRendererParams,
  ValueFormatterParams,
} from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, Save, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Tx = {
  id: string;
  tx_at: string;
  withdrawal: string;
  deposit: string;
  balance_after: string;
  description: string | null;
  counterparty_account: string | null;
  counterparty_bank: string | null;
  counterparty_holder: string | null;
  memo: string | null;
  tx_type: string | null;
  check_amount: string;
  cms_code: string | null;
};

type ListResponse = {
  account_id: string;
  bank_name: string;
  account_no: string | null;
  account_holder: string | null;
  latest_balance: string | null;
  last_tx_at: string | null;
  transactions: Tx[];
};

type PreviewResult = {
  parsed: number;
  sample: Array<Record<string, unknown>>;
  error: string | null;
};

type UploadResult = {
  parsed: number;
  inserted: number;
  skipped_duplicate: number;
  error: string | null;
};

const MAX_BYTES = 10 * 1024 * 1024;

function fmtKRW(s: string | null | undefined): string {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return n === 0 ? "—" : n.toLocaleString("ko-KR");
}

function fmtAmountCell(p: ValueFormatterParams): string {
  return fmtKRW(p.value);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function kstYearMonth(): { year: number; month: number } {
  const parts = new Date()
    .toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
    })
    .replaceAll(" ", "")
    .replace(/\.$/, "")
    .split(".");
  return { year: Number(parts[0]), month: Number(parts[1]) };
}

export default function BankTransactionsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const accountId = params?.id;
  const dialog = useDialog();

  const [{ year, month }, setYM] = useState(kstYearMonth);
  const today = useMemo(() => kstYearMonth(), []);
  const isFuture =
    year > today.year || (year === today.year && month >= today.month);

  function shiftMonth(delta: number) {
    setYM(({ year: y, month: m }) => {
      const total = y * 12 + (m - 1) + delta;
      return { year: Math.floor(total / 12), month: (total % 12) + 1 };
    });
  }

  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: ["bank-tx", accountId, year, month],
    queryFn: async () =>
      (
        await api.get(`/bank-accounts/${accountId}/transactions`, {
          params: { year, month },
        })
      ).data,
    enabled: !!accountId,
  });

  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailTx, setDetailTx] = useState<Tx | null>(null);

  // 월별 지표 — 로드된 transactions 에서 즉시 계산.
  const monthStats = useMemo(() => {
    const txs = data?.transactions ?? [];
    let withdrawalCount = 0;
    let depositCount = 0;
    let withdrawalSum = 0;
    let depositSum = 0;
    for (const t of txs) {
      const w = Number(t.withdrawal);
      const d = Number(t.deposit);
      if (w > 0) {
        withdrawalCount += 1;
        withdrawalSum += w;
      }
      if (d > 0) {
        depositCount += 1;
        depositSum += d;
      }
    }
    return {
      total: txs.length,
      withdrawalCount,
      depositCount,
      withdrawalSum,
      depositSum,
    };
  }, [data?.transactions]);

  const columnDefs = useMemo<ColDef<Tx>[]>(
    () => [
      {
        field: "tx_at",
        headerName: "거래일시",
        valueFormatter: (p) => fmtDateTime(p.value),
        width: 170,
        sort: "desc",
      },
      {
        field: "withdrawal",
        headerName: "출금",
        valueFormatter: fmtAmountCell,
        cellClass: "text-right tabular-nums text-red-600",
        type: "numericColumn",
        width: 130,
      },
      {
        field: "deposit",
        headerName: "입금",
        valueFormatter: fmtAmountCell,
        cellClass: "text-right tabular-nums text-emerald-600",
        type: "numericColumn",
        width: 130,
      },
      {
        field: "balance_after",
        headerName: "잔액",
        valueFormatter: fmtAmountCell,
        cellClass: "text-right tabular-nums font-medium",
        type: "numericColumn",
        width: 150,
      },
      {
        field: "description",
        headerName: "거래내용",
        flex: 1,
        minWidth: 180,
      },
      {
        headerName: "상대",
        cellRenderer: (p: ICellRendererParams<Tx>) => {
          const r = p.data;
          if (!r) return null;
          const lines: string[] = [];
          if (r.counterparty_holder) lines.push(r.counterparty_holder);
          if (r.counterparty_bank || r.counterparty_account) {
            lines.push(
              [r.counterparty_bank, r.counterparty_account]
                .filter(Boolean)
                .join(" "),
            );
          }
          return lines.length > 0 ? (
            <div className="leading-tight py-1">
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={i === 0 ? "text-sm" : "text-[11px] text-muted-foreground"}
                >
                  {l}
                </div>
              ))}
            </div>
          ) : (
            "—"
          );
        },
        flex: 1,
        minWidth: 180,
      },
      {
        field: "memo",
        headerName: "메모",
        flex: 1,
        minWidth: 120,
      },
      {
        field: "tx_type",
        headerName: "구분",
        width: 90,
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader
        title="거래내역"
        actions={
          <button
            type="button"
            onClick={() => router.push("/bank-accounts")}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            은행계좌
          </button>
        }
      />

      <div className="flex flex-col gap-3 p-4 min-h-0 flex-1">
        {/* 계좌 메타 카드 */}
        <div className="rounded-lg border border-border bg-card p-4 flex flex-wrap items-center gap-x-8 gap-y-2 shrink-0">
          <div>
            <div className="text-[11px] text-muted-foreground">은행</div>
            <div className="text-sm font-semibold">
              {data?.bank_name ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">계좌번호</div>
            <div className="text-sm font-mono">{data?.account_no ?? "—"}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">예금주</div>
            <div className="text-sm">{data?.account_holder ?? "—"}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">최신 잔액</div>
            <div className="text-xl font-bold tabular-nums">
              {fmtKRW(data?.latest_balance)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">
              마지막 거래
            </div>
            <div className="text-sm tabular-nums">
              {fmtDateTime(data?.last_tx_at)}
            </div>
          </div>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setUploadOpen(true)}
              className="h-9 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Upload className="w-4 h-4" />
              거래내역 업로드
            </button>
          </div>
        </div>

        {/* 월 네비 */}
        <div className="flex items-center justify-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
            aria-label="이전 달"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="text-sm font-semibold tabular-nums min-w-[120px] text-center">
            {year}년 {month}월
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {data?.transactions.length ?? 0}건
            </span>
          </div>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            disabled={isFuture}
            className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="다음 달"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* 월별 지표 5개 카드 */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 shrink-0">
          <StatCard
            label="총 거래건수"
            value={monthStats.total.toLocaleString("ko-KR")}
            suffix="건"
          />
          <StatCard
            label="총 출금건수"
            value={monthStats.withdrawalCount.toLocaleString("ko-KR")}
            suffix="건"
            tone="red"
          />
          <StatCard
            label="총 입금건수"
            value={monthStats.depositCount.toLocaleString("ko-KR")}
            suffix="건"
            tone="emerald"
          />
          <StatCard
            label="총 출금금액"
            value={
              monthStats.withdrawalSum > 0
                ? monthStats.withdrawalSum.toLocaleString("ko-KR")
                : "—"
            }
            tone="red"
          />
          <StatCard
            label="총 입금금액"
            value={
              monthStats.depositSum > 0
                ? monthStats.depositSum.toLocaleString("ko-KR")
                : "—"
            }
            tone="emerald"
          />
        </div>

        {/* 거래 목록 — 페이지 bottom 까지 늘어남 */}
        <div className="flex-1 min-h-0 flex flex-col">
          {isLoading ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              불러오는 중…
            </div>
          ) : (
            <DataGrid<Tx>
              rowData={data?.transactions ?? []}
              columnDefs={columnDefs}
              getRowId={(r) => r.id}
              searchPlaceholder="거래내용·상대·메모 검색"
              enableCheckbox={false}
              pageSize={500}
              pageSizeOptions={[20, 50, 100, 200, 500, 1000]}
              onRowDoubleClicked={(row) => setDetailTx(row)}
            />
          )}
        </div>
      </div>

      {uploadOpen && (
        <UploadDialog
          accountId={accountId!}
          onClose={() => setUploadOpen(false)}
          onComplete={() => {
            setUploadOpen(false);
          }}
        />
      )}

      {detailTx && (
        <TxDetailDialog
          accountId={accountId!}
          tx={detailTx}
          onClose={() => setDetailTx(null)}
        />
      )}
    </>
  );
}

function UploadDialog({
  accountId,
  onClose,
  onComplete,
}: {
  accountId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadM = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("파일이 선택되지 않았습니다.");
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post<UploadResult>(
        `/bank-accounts/${accountId}/transactions/upload`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      return data;
    },
    onSuccess: async (r) => {
      if (r.error) {
        await dialog.alert(r.error, { title: "업로드 실패" });
        return;
      }
      await dialog.alert(
        `총 ${r.parsed}건 파싱 / 추가 ${r.inserted} / 중복 ${r.skipped_duplicate}`,
        { title: "업로드 완료" },
      );
      qc.invalidateQueries({ queryKey: ["bank-tx", accountId] });
      onComplete();
    },
    onError: (e: any) => {
      setError(
        e?.response?.data?.detail ??
          (e instanceof Error ? e.message : "업로드 실패"),
      );
    },
  });

  function onPick(f: File | null) {
    setError(null);
    setPreview(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(
        `파일이 너무 큽니다 (${(f.size / 1024 / 1024).toFixed(1)}MB / 한도 10MB).`,
      );
      setFile(null);
      return;
    }
    setFile(f);
  }

  async function doPreview() {
    if (!file) return;
    setPreviewing(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post<PreviewResult>(
        `/bank-accounts/${accountId}/transactions/preview`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setPreview(data);
      if (data.error) setError(data.error);
    } catch (e: any) {
      setError(
        e?.response?.data?.detail ??
          (e instanceof Error ? e.message : "미리보기 실패"),
      );
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="거래내역 CSV 업로드"
      width="max-w-3xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={!file || previewing}
            onClick={doPreview}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
          >
            {previewing ? "분석 중…" : "미리보기"}
          </button>
          <button
            type="button"
            disabled={!file || uploadM.isPending}
            onClick={() => uploadM.mutate()}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {uploadM.isPending ? "업로드 중…" : "업로드"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground leading-relaxed">
          거래내역은 <strong>기업은행</strong>에 로그인하여 거래내역을 조회한 후
          <strong> '텍스트파일저장'</strong>으로 저장하십시오.
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-4 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-primary file:text-primary-foreground hover:file:bg-brand-dark"
        />
        {file && (
          <div className="text-xs text-muted-foreground">
            선택: <strong>{file.name}</strong> (
            {(file.size / 1024).toFixed(1)} KB)
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive whitespace-pre-wrap">
            {error}
          </div>
        )}
        {preview && !preview.error && (
          <div className="rounded-md border border-border">
            <div className="px-3 py-2 text-xs bg-muted/40 border-b border-border">
              총 <strong>{preview.parsed}</strong>건 파싱됨 — 첫{" "}
              {preview.sample.length}건 미리보기:
            </div>
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">거래일시</th>
                    <th className="px-2 py-1.5 text-right">출금</th>
                    <th className="px-2 py-1.5 text-right">입금</th>
                    <th className="px-2 py-1.5 text-right">잔액</th>
                    <th className="px-2 py-1.5 text-left">내용</th>
                    <th className="px-2 py-1.5 text-left">상대</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1.5 tabular-nums">
                        {fmtDateTime(r.tx_at as string)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-red-600">
                        {fmtKRW(r.withdrawal as string)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">
                        {fmtKRW(r.deposit as string)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {fmtKRW(r.balance_after as string)}
                      </td>
                      <td className="px-2 py-1.5">
                        {(r.description as string) ?? "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        {(r.counterparty_holder as string) ??
                          (r.counterparty_account as string) ??
                          "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function StatCard({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: "red" | "emerald";
}) {
  const valueColor =
    tone === "red"
      ? "text-red-600"
      : tone === "emerald"
        ? "text-emerald-600"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={"text-xl font-bold tabular-nums mt-0.5 " + valueColor}>
        {value}
        {suffix && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}


function TxDetailDialog({
  accountId,
  tx,
  onClose,
}: {
  accountId: string;
  tx: Tx;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [memo, setMemo] = useState(tx.memo ?? "");
  const [error, setError] = useState<string | null>(null);

  const saveM = useMutation({
    mutationFn: async () => {
      const { data } = await api.patch<Tx>(
        `/bank-accounts/${accountId}/transactions/${tx.id}/memo`,
        { memo: memo.trim() || null },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank-tx", accountId] });
      onClose();
    },
    onError: (e: any) => {
      setError(
        e?.response?.data?.detail ??
          (e instanceof Error ? e.message : "저장 실패"),
      );
    },
  });

  const dirty = (tx.memo ?? "") !== memo;
  const w = Number(tx.withdrawal);
  const d = Number(tx.deposit);
  const isWithdrawal = w > 0;
  const isDeposit = d > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title="거래내역 상세"
      width="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={!dirty || saveM.isPending}
            onClick={() => saveM.mutate()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saveM.isPending ? "저장 중…" : "메모 저장"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {/* 강조 행: 거래일시 + 금액 */}
        <div className="rounded-lg border border-border bg-muted/30 p-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-[11px] text-muted-foreground">거래일시</div>
            <div className="text-base font-semibold tabular-nums">
              {fmtDateTime(tx.tx_at)}
            </div>
          </div>
          {isWithdrawal && (
            <div>
              <div className="text-[11px] text-muted-foreground">출금</div>
              <div className="text-base font-semibold tabular-nums text-red-600">
                {fmtKRW(tx.withdrawal)}
              </div>
            </div>
          )}
          {isDeposit && (
            <div>
              <div className="text-[11px] text-muted-foreground">입금</div>
              <div className="text-base font-semibold tabular-nums text-emerald-600">
                {fmtKRW(tx.deposit)}
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] text-muted-foreground">거래후 잔액</div>
            <div className="text-base font-semibold tabular-nums">
              {fmtKRW(tx.balance_after)}
            </div>
          </div>
        </div>

        {/* 상세 필드 — 읽기 전용 */}
        <div className="grid grid-cols-2 gap-3">
          <DetailRow label="거래내용" value={tx.description} />
          <DetailRow label="거래구분" value={tx.tx_type} />
          <DetailRow label="상대 예금주" value={tx.counterparty_holder} />
          <DetailRow label="상대 은행" value={tx.counterparty_bank} />
          <DetailRow
            label="상대 계좌번호"
            value={tx.counterparty_account}
            mono
          />
          <DetailRow label="CMS 코드" value={tx.cms_code} />
          {Number(tx.check_amount) > 0 && (
            <DetailRow label="수표어음 금액" value={fmtKRW(tx.check_amount)} />
          )}
        </div>

        {/* 메모 — 편집 가능 */}
        <div>
          <label
            htmlFor="memo"
            className="block text-xs font-semibold text-muted-foreground mb-1"
          >
            메모
          </label>
          <textarea
            id="memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="이 거래에 대한 자유 메모를 입력하세요."
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {error && <div className="text-xs text-destructive">{error}</div>}
      </div>
    </Dialog>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={"text-sm " + (mono ? "font-mono" : "")}>
        {value ?? "—"}
      </div>
    </div>
  );
}
