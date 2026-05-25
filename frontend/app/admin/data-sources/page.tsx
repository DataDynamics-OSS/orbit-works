"use client";

/**
 * SUPER_ADMIN — ECOS / FRED API key 관리. 시스템 전체에서 1세트만 사용 (한국은행
 * 경제통계, 미국 FRED 모두 외부 공통 데이터 source).
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { fetchSection, saveSection } from "@/components/settings/settings-api";
import { useDialog } from "@/components/ui/DialogProvider";

type EcosFull = { enabled: boolean; api_key: string };
type FredFull = { enabled: boolean; api_key: string };
type ExchangeForm = { base: string; target: string; refresh_cron_hour: number };

export default function DataSourcesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: ec } = useQuery<EcosFull>({
    queryKey: ["settings", "ecos"],
    queryFn: () => fetchSection("ecos"),
  });
  const { data: fr } = useQuery<FredFull>({
    queryKey: ["settings", "fred"],
    queryFn: () => fetchSection("fred"),
  });
  const { data: ex } = useQuery<any>({
    queryKey: ["settings", "exchange"],
    queryFn: () => fetchSection("exchange"),
  });

  const [ecForm, setEcForm] = useState<EcosFull | null>(null);
  const [frForm, setFrForm] = useState<FredFull | null>(null);
  const [exForm, setExForm] = useState<ExchangeForm | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (ec) setEcForm(ec); }, [ec]);
  useEffect(() => { if (fr) setFrForm(fr); }, [fr]);
  useEffect(() => {
    if (ex)
      setExForm({
        base: ex.base ?? "USD",
        target: ex.target ?? "KRW",
        refresh_cron_hour: ex.refresh_cron_hour ?? 9,
      });
  }, [ex]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (ecForm) await saveSection("ecos", ecForm);
      if (frForm) await saveSection("fred", frForm);
      if (exForm && ex) await saveSection("exchange", { ...ex, ...exForm });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const ready = ecForm && frForm && exForm;
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">외부 데이터 연동</h1>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-700">저장됨</span>}
          <button
            type="button"
            disabled={!ready || saveM.isPending}
            onClick={() => saveM.mutate()}
            className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            저장
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4 max-w-3xl">
        {!ready ? (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        ) : (
          <>
            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold">환율 (frankfurter.app)</h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block mb-1 text-xs font-medium text-muted-foreground">
                    Base 통화
                  </label>
                  <input
                    className={input + " font-mono"}
                    value={exForm!.base}
                    onChange={(e) =>
                      setExForm({ ...exForm!, base: e.target.value.toUpperCase() })
                    }
                  />
                </div>
                <div>
                  <label className="block mb-1 text-xs font-medium text-muted-foreground">
                    Target 통화
                  </label>
                  <input
                    className={input + " font-mono"}
                    value={exForm!.target}
                    onChange={(e) =>
                      setExForm({ ...exForm!, target: e.target.value.toUpperCase() })
                    }
                  />
                </div>
                <div>
                  <label className="block mb-1 text-xs font-medium text-muted-foreground">
                    수집 시각 (시)
                  </label>
                  <input
                    type="number" min={0} max={23}
                    className={input}
                    value={exForm!.refresh_cron_hour}
                    onChange={(e) =>
                      setExForm({
                        ...exForm!,
                        refresh_cron_hour: Number(e.target.value),
                      })
                    }
                  />
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">ECOS (한국은행 경제통계시스템)</h3>
                <label className="inline-flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={ecForm!.enabled}
                    onChange={(e) => setEcForm({ ...ecForm!, enabled: e.target.checked })}
                  />
                  활성
                </label>
              </div>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  ECOS API Key
                </label>
                <input
                  type="text"
                  value={ecForm!.api_key}
                  onChange={(e) => setEcForm({ ...ecForm!, api_key: e.target.value })}
                  placeholder="ECOS Open API 인증키"
                  className={input + " font-mono"}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  키 발급: https://ecos.bok.or.kr → 서비스 이용 → Open API → 인증키 신청.
                  활용: 국내 금리 + KOSPI/KOSDAQ 일별 주가지수.
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">FRED (세인트루이스 연준)</h3>
                <label className="inline-flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={frForm!.enabled}
                    onChange={(e) => setFrForm({ ...frForm!, enabled: e.target.checked })}
                  />
                  활성
                </label>
              </div>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  FRED API Key
                </label>
                <input
                  type="text"
                  value={frForm!.api_key}
                  onChange={(e) => setFrForm({ ...frForm!, api_key: e.target.value })}
                  placeholder="FRED API Key (32자)"
                  className={input + " font-mono"}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  키 발급: https://fred.stlouisfed.org → My Account → API Keys → Request API Key (무료).
                  활용: 미국 주가지수 S&P 500 / NASDAQ / Dow Jones 일별 종가.
                </p>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
