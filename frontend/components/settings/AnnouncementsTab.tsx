"use client";

/**
 * 사업공고 수집 설정 탭 (Admin).
 *
 * - announcements 섹션 — auto_fetch 시간·활성 + 소스별 API key.
 * - 소스 테이블 — enabled 토글, 현재 수집 상태, "지금 수집" 버튼.
 * - 최근 수집 로그 (fetch runs) 표시.
 *
 * API 키는 서버에서 `***<last4>` 로 마스킹돼 반환. 마스킹 문자열을 그대로
 * PUT 하면 서버는 "유지" 로 해석 — 기존 값 보존.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save } from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { fetchSection, saveSection } from "./settings-api";

type SourceSettings = { enabled: boolean; api_key: string };
type AnnouncementsSection = {
  enabled: boolean;
  auto_fetch: {
    enabled: boolean;
    hour: number;
    minute: number;
    catchup_days: number;
  };
  sources: Record<string, SourceSettings>;
};

type Source = {
  id: string;
  code: string;
  name: string;
  agency: string | null;
  adapter_kind: string;
  enabled: boolean;
  priority: number;
  last_ok_at: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  last_count: number | null;
  needs_api_key: boolean;
  has_api_key: boolean;
  implemented: boolean;
};

type FetchRun = {
  id: string;
  source_code: string;
  trigger_kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  fetched_count: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_message: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  OK: "text-emerald-600",
  FAILED: "text-rose-600",
  SKIPPED: "text-amber-600",
  RUNNING: "text-sky-600",
};

export function AnnouncementsTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: section } = useQuery<AnnouncementsSection>({
    queryKey: ["settings", "announcements"],
    queryFn: () => fetchSection<AnnouncementsSection>("announcements"),
  });

  const { data: sources } = useQuery<Source[]>({
    queryKey: ["announcement-sources"],
    queryFn: async () => (await api.get("/announcements/sources")).data,
  });

  const { data: runs } = useQuery<FetchRun[]>({
    queryKey: ["announcement-runs"],
    queryFn: async () =>
      (await api.get("/announcements/runs", { params: { limit: 50 } })).data,
  });

  const [form, setForm] = useState<AnnouncementsSection | null>(null);
  useEffect(() => {
    // section / sources 둘 다 로드된 시점에만 form 동기화. 둘 중 하나라도
    // 미정이면 skip — `sources` 기본값을 `[]` 로 두면 매 render 마다 새
    // 레퍼런스라 useEffect 가 무한 루프 (Maximum update depth exceeded).
    if (!section || !sources) return;
    const base: Record<string, SourceSettings> = { ...(section.sources || {}) };
    for (const s of sources) {
      if (!base[s.code]) base[s.code] = { enabled: true, api_key: "" };
    }
    setForm({ ...section, sources: base });
  }, [section, sources]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form) return;
      return saveSection<AnnouncementsSection>("announcements", form);
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["settings", "announcements"] });
      qc.invalidateQueries({ queryKey: ["announcement-sources"] });
      await dialog.alert("저장됨.");
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const toggleSourceM = useMutation({
    mutationFn: async (vars: { code: string; enabled: boolean }) =>
      (await api.patch(`/announcements/sources/${vars.code}`, vars)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["announcement-sources"] }),
  });

  const fetchOneM = useMutation({
    mutationFn: async (code: string) =>
      (await api.post("/announcements/fetch", { source: code, since_days: 3 })).data,
    onSuccess: async (data: { results: any[] }) => {
      qc.invalidateQueries({ queryKey: ["announcement-sources"] });
      qc.invalidateQueries({ queryKey: ["announcement-runs"] });
      const r = data.results[0];
      await dialog.alert(
        `수집 [${r.source_code}]: ${r.status}\n` +
          `신규 ${r.inserted} · 변경 ${r.updated} · 스킵 ${r.skipped}` +
          (r.error ? `\n에러: ${r.error}` : ""),
      );
    },
  });

  const fetchAllM = useMutation({
    mutationFn: async () =>
      (await api.post("/announcements/fetch", { since_days: 1 })).data,
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["announcement-sources"] });
      qc.invalidateQueries({ queryKey: ["announcement-runs"] });
    },
  });

  if (!form) return <div className="text-sm text-muted-foreground">로딩 중…</div>;

  return (
    <div className="space-y-6">
      {/* 자동 수집 cron */}
      <section className="rounded-md border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">자동 수집 스케줄</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            전체 활성화
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.auto_fetch.enabled}
              onChange={(e) =>
                setForm({
                  ...form,
                  auto_fetch: { ...form.auto_fetch, enabled: e.target.checked },
                })
              }
            />
            자동 수집
          </label>
          <label className="flex flex-col">
            <span className="text-[11px] text-muted-foreground">시</span>
            <input
              type="number"
              min={0}
              max={23}
              value={form.auto_fetch.hour}
              onChange={(e) =>
                setForm({
                  ...form,
                  auto_fetch: { ...form.auto_fetch, hour: Number(e.target.value) },
                })
              }
              className="h-9 rounded-md border border-input bg-background px-2"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-[11px] text-muted-foreground">분</span>
            <input
              type="number"
              min={0}
              max={59}
              value={form.auto_fetch.minute}
              onChange={(e) =>
                setForm({
                  ...form,
                  auto_fetch: { ...form.auto_fetch, minute: Number(e.target.value) },
                })
              }
              className="h-9 rounded-md border border-input bg-background px-2"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-[11px] text-muted-foreground">재수집 범위(일)</span>
            <input
              type="number"
              min={1}
              max={30}
              value={form.auto_fetch.catchup_days}
              onChange={(e) =>
                setForm({
                  ...form,
                  auto_fetch: {
                    ...form.auto_fetch,
                    catchup_days: Number(e.target.value),
                  },
                })
              }
              className="h-9 rounded-md border border-input bg-background px-2"
            />
          </label>
        </div>
        <div className="text-xs text-muted-foreground">
          매일 {String(form.auto_fetch.hour).padStart(2, "0")}:
          {String(form.auto_fetch.minute).padStart(2, "0")} KST 에 활성 소스 전체를
          순차 수집. 지난 {form.auto_fetch.catchup_days}일치 범위로 재조회해 지연
          공시를 따라잡는다.
        </div>
      </section>

      {/* 소스별 설정 */}
      <section className="rounded-md border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">수집 소스</h2>
          <button
            type="button"
            onClick={() => fetchAllM.mutate()}
            disabled={fetchAllM.isPending}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={"h-3 w-3 " + (fetchAllM.isPending ? "animate-spin" : "")} />
            전체 수집
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-muted-foreground border-b border-border">
              <th className="text-left py-1.5 pl-2">소스</th>
              <th className="text-left">API Key</th>
              <th className="text-center">활성</th>
              <th className="text-right">최근 수집</th>
              <th className="text-right">상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(sources ?? []).map((s) => {
              const cfg = form.sources[s.code] || { enabled: true, api_key: "" };
              return (
                <tr key={s.code} className="border-b border-border last:border-b-0">
                  <td className="py-2 pl-2">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {s.agency ?? ""} · {s.adapter_kind}
                      {!s.implemented && (
                        <span className="ml-1 text-rose-600">(어댑터 미구현)</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {s.needs_api_key ? (
                      <input
                        type="text"
                        value={cfg.api_key}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            sources: {
                              ...form.sources,
                              [s.code]: { ...cfg, api_key: e.target.value },
                            },
                          })
                        }
                        placeholder="API 키 입력"
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs font-mono"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">불필요</span>
                    )}
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) =>
                        toggleSourceM.mutate({
                          code: s.code,
                          enabled: e.target.checked,
                        })
                      }
                    />
                  </td>
                  <td className="text-right text-[11px] text-muted-foreground">
                    {s.last_fetched_at
                      ? new Date(s.last_fetched_at).toLocaleString("ko-KR")
                      : "—"}
                    {s.last_count != null && ` · ${s.last_count}건`}
                  </td>
                  <td className="text-right text-[11px]">
                    {s.last_error ? (
                      <Tooltip label={s.last_error} side="top">
                        <span className="text-rose-600">FAILED</span>
                      </Tooltip>
                    ) : s.last_ok_at ? (
                      <span className="text-emerald-600">OK</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="text-right pr-2">
                    <button
                      type="button"
                      onClick={() => fetchOneM.mutate(s.code)}
                      disabled={fetchOneM.isPending || !s.implemented}
                      className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
                    >
                      수집
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* 저장 */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={saveM.isPending}
          className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saveM.isPending ? "저장 중…" : "설정 저장"}
        </button>
      </div>

      {/* 최근 수집 이력 */}
      <section className="rounded-md border border-border bg-card p-4 space-y-2">
        <h2 className="text-sm font-semibold">최근 수집 로그</h2>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[11px] text-muted-foreground border-b border-border">
              <th className="text-left py-1.5 pl-2">시작</th>
              <th className="text-left">소스</th>
              <th className="text-left">트리거</th>
              <th className="text-left">상태</th>
              <th className="text-right">수집</th>
              <th className="text-right">신규</th>
              <th className="text-right">변경</th>
              <th className="text-right">스킵</th>
              <th className="text-left">에러</th>
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map((r) => (
              <tr key={r.id} className="border-b border-border last:border-b-0">
                <td className="pl-2 py-1 tabular-nums">
                  {new Date(r.started_at).toLocaleString("ko-KR")}
                </td>
                <td className="font-mono">{r.source_code}</td>
                <td>{r.trigger_kind}</td>
                <td>
                  <span className={STATUS_COLOR[r.status] ?? ""}>{r.status}</span>
                </td>
                <td className="text-right tabular-nums">{r.fetched_count}</td>
                <td className="text-right tabular-nums">{r.inserted_count}</td>
                <td className="text-right tabular-nums">{r.updated_count}</td>
                <td className="text-right tabular-nums">{r.skipped_count}</td>
                <td className="max-w-[280px] truncate text-rose-600">
                  {r.error_message ?? ""}
                  {r.error_message && <Tooltip label={r.error_message} side="top" inline />}
                </td>
              </tr>
            ))}
            {(runs ?? []).length === 0 && (
              <tr>
                <td className="py-4 text-center text-muted-foreground" colSpan={9}>
                  아직 수집 기록이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
