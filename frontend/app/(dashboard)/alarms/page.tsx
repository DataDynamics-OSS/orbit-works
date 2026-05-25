"use client";

/**
 * Alarms — sidebar > ADMINISTRATION > Alarms (ADMIN 전용).
 *
 * 관리자가 정기/단발 Slack 리마인더를 등록. 각 알람은 백엔드 APScheduler 에
 * 자동 등록되어 지정 시각에 채널(#alert 등) 또는 임직원 DM 으로 발송.
 * 공휴일/주말이면 직전 영업일 같은 시각으로 이동(MONTHLY/YEARLY 한정).
 *
 * UI 요소:
 * - 좌측: 알람 목록 카드 (활성 토글 · 다음 실행 · 상태 요약)
 * - 추가 버튼 → 우측 편집 패널
 * - 편집 패널: 제목·메시지·스케줄·수신처·유효기간 + 테스트 발송 + 이력 드로어
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { sortDevelopersKo } from "@/lib/sort-developers";

type ScheduleKind = "ONE_TIME" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

type Developer = {
  id: string;
  name: string;
  tag?: string | null;
  status?: string | null;
  employment_type?: string | null;
  company_email?: string | null;
};

type Alarm = {
  id: string;
  title: string;
  message: string;
  schedule_kind: ScheduleKind;
  one_time_at?: string | null;
  hour?: number | null;
  minute?: number | null;
  weekdays?: number[] | null;
  day_of_month?: number | null;
  month_of_year?: number | null;
  slack_channel?: string | null;
  recipient_developer_ids?: string[] | null;
  active_from?: string | null;
  active_to?: string | null;
  enabled: boolean;
  last_sent_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  sent_count: number;
  next_run_at?: string | null;
  created_at: string;
  updated_at: string;
};

type AlarmSend = {
  id: string;
  alarm_id: string;
  scheduled_at: string;
  sent_at?: string | null;
  status: string;
  error_message?: string | null;
  recipients_summary?: string | null;
  manual: boolean;
  created_at: string;
};

const WEEKDAY_LABEL = ["월", "화", "수", "목", "금", "토", "일"];

const EMPTY_FORM: Partial<Alarm> = {
  title: "",
  message: "",
  schedule_kind: "MONTHLY",
  hour: 9,
  minute: 0,
  day_of_month: 1,
  enabled: true,
  recipient_developer_ids: [],
};

export default function AlarmsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Alarm>>(EMPTY_FORM);
  const [isNew, setIsNew] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { data: alarms = [], isLoading } = useQuery<Alarm[]>({
    queryKey: ["alarms"],
    queryFn: async () => (await api.get("/alarms")).data,
    refetchInterval: 30_000,
  });

  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers", "directory", "all"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { include_hidden: true },
        })
      ).data,
    staleTime: 60_000,
  });
  const sortedDevs = useMemo(() => sortDevelopersKo(developers), [developers]);

  const selected = useMemo(
    () => (selectedId ? alarms.find((a) => a.id === selectedId) : null),
    [alarms, selectedId],
  );

  useEffect(() => {
    if (isNew) return;
    if (selected) setForm(selected);
    else setForm(EMPTY_FORM);
  }, [selected, isNew]);

  const saveM = useMutation({
    mutationFn: async (payload: Partial<Alarm>) => {
      const body = sanitize(payload);
      if (isNew) {
        return (await api.post("/alarms", body)).data as Alarm;
      }
      if (!selectedId) throw new Error("no selection");
      return (await api.patch(`/alarms/${selectedId}`, body)).data as Alarm;
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["alarms"] });
      setIsNew(false);
      setSelectedId(saved.id);
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/alarms/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alarms"] });
      setSelectedId(null);
      setForm(EMPTY_FORM);
    },
  });

  const testM = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/alarms/${id}/test`)).data as AlarmSend,
    onSuccess: async (send) => {
      qc.invalidateQueries({ queryKey: ["alarms"] });
      await dialog.alert(
        send.status === "SUCCESS"
          ? `테스트 발송 성공 — ${send.recipients_summary ?? ""}`
          : `테스트 발송 실패 — ${send.error_message ?? "unknown"}`,
        { title: "테스트 발송" },
      );
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "테스트 실패", {
        title: "오류",
      }),
  });

  return (
    <>
      <DashboardHeader title="알람" />
      <div className="flex flex-1 overflow-hidden">
        {/* 좌측 목록 */}
        <div className="w-[360px] border-r border-border overflow-auto flex flex-col">
          <div className="p-3 flex items-center gap-2 border-b border-border">
            <button
              type="button"
              onClick={() => {
                setIsNew(true);
                setSelectedId(null);
                setForm(EMPTY_FORM);
              }}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />새 알람
            </button>
            <span className="text-xs text-muted-foreground ml-auto">
              {alarms.length} 건
            </span>
          </div>
          <div className="flex flex-col p-2 gap-1.5">
            {isLoading ? (
              <div className="text-sm text-muted-foreground p-3">
                불러오는 중…
              </div>
            ) : alarms.length === 0 ? (
              <div className="text-xs text-muted-foreground p-3">
                등록된 알람이 없습니다.
              </div>
            ) : (
              alarms.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setIsNew(false);
                    setSelectedId(a.id);
                  }}
                  className={
                    "text-left rounded-md border p-2.5 transition-colors " +
                    (selectedId === a.id && !isNew
                      ? "border-primary bg-muted/40"
                      : "border-border hover:bg-muted/40")
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={
                        "inline-block h-1.5 w-1.5 rounded-full " +
                        (a.enabled ? "bg-emerald-500" : "bg-muted-foreground")
                      }
                    />
                    <span className="text-sm font-semibold truncate flex-1">
                      {a.title}
                    </span>
                    <StatusIcon status={a.last_status} />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {summarizeSchedule(a)}
                  </div>
                  {a.next_run_at && (
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      다음: {formatKst(a.next_run_at)}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* 우측 편집 패널 */}
        <div className="flex-1 overflow-auto p-4">
          {!isNew && !selected ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              좌측에서 알람을 선택하거나 "새 알람" 버튼을 눌러 추가하세요.
            </div>
          ) : (
            <AlarmEditor
              form={form}
              setForm={setForm}
              developers={sortedDevs}
              isNew={isNew}
              saving={saveM.isPending}
              onSave={() => saveM.mutate(form)}
              onDelete={async () => {
                if (!selectedId) return;
                const ok = await dialog.confirm(
                  `"${form.title}" 알람을 삭제할까요?`,
                  { title: "삭제 확인", confirmText: "삭제" },
                );
                if (ok) deleteM.mutate(selectedId);
              }}
              onTest={() => selectedId && testM.mutate(selectedId)}
              onShowHistory={() => setHistoryOpen(true)}
              selected={selected ?? null}
              testing={testM.isPending}
            />
          )}
        </div>
      </div>

      {historyOpen && selectedId && (
        <HistoryDrawer
          alarmId={selectedId}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function AlarmEditor({
  form,
  setForm,
  developers,
  isNew,
  saving,
  selected,
  testing,
  onSave,
  onDelete,
  onTest,
  onShowHistory,
}: {
  form: Partial<Alarm>;
  setForm: (f: Partial<Alarm>) => void;
  developers: Developer[];
  isNew: boolean;
  saving: boolean;
  selected: Alarm | null;
  testing: boolean;
  onSave: () => void;
  onDelete: () => void;
  onTest: () => void;
  onShowHistory: () => void;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const kind = (form.schedule_kind ?? "MONTHLY") as ScheduleKind;

  const setK = <K extends keyof Alarm>(key: K, value: Alarm[K]) =>
    setForm({ ...form, [key]: value });

  const toggleWeekday = (w: number) => {
    const current = new Set(form.weekdays ?? []);
    if (current.has(w)) current.delete(w);
    else current.add(w);
    setK("weekdays", Array.from(current).sort());
  };

  const toggleDeveloper = (id: string) => {
    const current = new Set(form.recipient_developer_ids ?? []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    setK("recipient_developer_ids", Array.from(current));
  };

  return (
    <div className="max-w-[62rem] space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">
          {isNew ? "새 알람" : form.title || "(제목 없음)"}
        </h2>
        <label className="ml-auto inline-flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={!!form.enabled}
            onChange={(e) => setK("enabled", e.target.checked)}
          />
          활성
        </label>
      </div>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <Field label="제목 *">
          <input
            value={form.title ?? ""}
            onChange={(e) => setK("title", e.target.value)}
            className={input}
            placeholder="급여 지급 준비"
          />
        </Field>
        <Field label="메시지 *">
          <textarea
            value={form.message ?? ""}
            onChange={(e) => setK("message", e.target.value)}
            className={input + " min-h-24"}
            rows={4}
            placeholder="발송할 알림 내용 (Slack/Mattermost)"
          />
        </Field>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">스케줄</h3>
        {/* 유형·시·분·일자(월) 를 한 줄에 flex 배치. ONE_TIME 은 시·분 대신
            datetime-local 입력이 그 자리를 차지하고, WEEKLY 요일 선택은
            두 번째 row. */}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="유형" className="w-44">
            <select
              value={kind}
              onChange={(e) =>
                setK("schedule_kind", e.target.value as ScheduleKind)
              }
              className={input}
            >
              <option value="ONE_TIME">단발 (1회)</option>
              <option value="DAILY">매일</option>
              <option value="WEEKLY">매주 (요일)</option>
              <option value="MONTHLY">매월 (날짜)</option>
              <option value="YEARLY">매년 (월·일)</option>
            </select>
          </Field>

          {kind === "ONE_TIME" ? (
            <Field label="일시" className="flex-1 min-w-[16rem]">
              <input
                type="datetime-local"
                value={toLocalInput(form.one_time_at)}
                onChange={(e) =>
                  setK("one_time_at", fromLocalInput(e.target.value))
                }
                className={input}
              />
            </Field>
          ) : (
            <>
              <Field label="시" className="w-24">
                <select
                  value={form.hour ?? 9}
                  onChange={(e) => setK("hour", Number(e.target.value))}
                  className={input}
                >
                  {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="분" className="w-24">
                <select
                  value={clampMinute(form.minute ?? 0)}
                  onChange={(e) => setK("minute", Number(e.target.value))}
                  className={input}
                >
                  {/* 5분 단위만 노출 — 리마인더 정밀도는 이 정도면 충분. */}
                  {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {kind === "MONTHLY" && (
            <Field label="일자" className="w-24">
              <select
                value={form.day_of_month ?? 1}
                onChange={(e) => setK("day_of_month", Number(e.target.value))}
                className={input}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}일
                  </option>
                ))}
              </select>
            </Field>
          )}

          {kind === "YEARLY" && (
            <>
              <Field label="월" className="w-24">
                <select
                  value={form.month_of_year ?? 1}
                  onChange={(e) =>
                    setK("month_of_year", Number(e.target.value))
                  }
                  className={input}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {m}월
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="일" className="w-24">
                <select
                  value={form.day_of_month ?? 1}
                  onChange={(e) =>
                    setK("day_of_month", Number(e.target.value))
                  }
                  className={input}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}일
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>

        {kind === "WEEKLY" && (
          <Field label="요일 (복수 선택)">
            <div className="flex gap-1.5 flex-wrap">
              {WEEKDAY_LABEL.map((label, i) => {
                const active = (form.weekdays ?? []).includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleWeekday(i)}
                    className={
                      "h-8 w-10 rounded-md border text-xs " +
                      (active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background")
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        {kind !== "ONE_TIME" && kind !== "DAILY" && kind !== "WEEKLY" && (
          <HelperText>
            공휴일/주말이면 직전 영업일 같은 시각으로 자동 이동합니다.
            (holidays 테이블 기준)
          </HelperText>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">수신처</h3>
        <Field label="Slack 채널 (선택)">
          <input
            value={form.slack_channel ?? ""}
            onChange={(e) => setK("slack_channel", e.target.value)}
            className={input}
            placeholder="#alert 또는 채널 ID (C01...)"
          />
        </Field>
        <Field label="담당자 DM (선택, 복수)">
          <div className="max-h-48 overflow-auto rounded-md border border-border p-2 flex flex-wrap gap-1.5">
            {developers.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                불러오는 중…
              </span>
            ) : (
              developers.map((d) => {
                const checked = (form.recipient_developer_ids ?? []).includes(
                  d.id,
                );
                const inactive = d.status && d.status !== "ACTIVE";
                return (
                  <label
                    key={d.id}
                    className={
                      "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs cursor-pointer " +
                      (checked
                        ? "border-primary bg-primary/10"
                        : "border-border")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDeveloper(d.id)}
                    />
                    {d.name}
                    {d.tag && (
                      <span className="text-muted-foreground"> · {d.tag}</span>
                    )}
                    {inactive && (
                      <span className="text-muted-foreground">(퇴사)</span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <HelperText>
            담당자의 `company_email` 로 Slack user 를 찾아 DM 을 보냅니다.
            이메일이 비어 있거나 Slack 에 없는 임직원은 자동으로 건너뜁니다.
          </HelperText>
        </Field>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">유효 기간 (선택)</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="시작일">
            <input
              type="date"
              value={form.active_from ?? ""}
              onChange={(e) => setK("active_from", e.target.value || null)}
              className={input}
            />
          </Field>
          <Field label="종료일">
            <input
              type="date"
              value={form.active_to ?? ""}
              onChange={(e) => setK("active_to", e.target.value || null)}
              className={input}
            />
          </Field>
        </div>
        <HelperText>
          종료일이 지나면 자동으로 비활성화됩니다 (이력은 유지).
        </HelperText>
      </section>

      {!isNew && selected && (
        <section className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h3 className="text-sm font-semibold">상태</h3>
          <div className="text-xs grid grid-cols-2 gap-1.5">
            <span className="text-muted-foreground">다음 실행</span>
            <span>
              {selected.next_run_at
                ? formatKst(selected.next_run_at)
                : "— (비활성 또는 완료)"}
            </span>
            <span className="text-muted-foreground">마지막 발송</span>
            <span>
              {selected.last_sent_at
                ? `${formatKst(selected.last_sent_at)} — ${selected.last_status ?? ""}`
                : "기록 없음"}
            </span>
            <span className="text-muted-foreground">누적 발송</span>
            <span>{selected.sent_count} 회</span>
            {selected.last_error && (
              <>
                <span className="text-muted-foreground">마지막 에러</span>
                <span className="text-destructive truncate">
                  {selected.last_error}
                </span>
              </>
            )}
          </div>
        </section>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? "저장 중..." : "저장"}
        </button>
        {!isNew && (
          <>
            <button
              type="button"
              onClick={onTest}
              disabled={testing}
              className="h-9 inline-flex items-center gap-1 rounded-md border border-border px-3 text-sm hover:bg-muted/40 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {testing ? "발송 중..." : "지금 테스트 발송"}
            </button>
            <button
              type="button"
              onClick={onShowHistory}
              className="h-9 inline-flex items-center gap-1 rounded-md border border-border px-3 text-sm hover:bg-muted/40"
            >
              <Clock className="h-4 w-4" />
              이력
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="h-9 ml-auto inline-flex items-center gap-1 rounded-md border border-border px-3 text-sm text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              삭제
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History drawer
// ---------------------------------------------------------------------------

function HistoryDrawer({
  alarmId,
  onClose,
}: {
  alarmId: string;
  onClose: () => void;
}) {
  const { data: sends = [], isLoading } = useQuery<AlarmSend[]>({
    queryKey: ["alarms", alarmId, "sends"],
    queryFn: async () => (await api.get(`/alarms/${alarmId}/sends`)).data,
  });

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="발송 이력 (최근 7일)"
      width="max-w-3xl"
    >
      {isLoading ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : sends.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          이력이 없습니다.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="p-2">예정 시각</th>
              <th className="p-2">발송 시각</th>
              <th className="p-2">상태</th>
              <th className="p-2">수신처</th>
              <th className="p-2">비고</th>
            </tr>
          </thead>
          <tbody>
            {sends.map((s) => (
              <tr key={s.id} className="border-b border-border/50">
                <td className="p-2">{formatKst(s.scheduled_at)}</td>
                <td className="p-2">
                  {s.sent_at ? formatKst(s.sent_at) : "—"}
                </td>
                <td className="p-2">
                  <StatusBadge status={s.status} />
                  {s.manual && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      (수동)
                    </span>
                  )}
                </td>
                <td className="p-2 truncate max-w-[200px]">
                  {s.recipients_summary ?? "—"}
                </td>
                <td className="p-2 text-destructive truncate max-w-[200px]">
                  {s.error_message ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Small UI pieces + helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  colSpan,
  className,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  className?: string;
  children: React.ReactNode;
}) {
  const cls =
    className ??
    (colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "");
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** 분 드롭다운은 5분 단위만 노출하므로, 비정상 값(legacy 또는 DB 직접 수정)
 * 은 가장 가까운 5의 배수로 clamp — UI 경고 없이 자연스러운 표기. */
function clampMinute(m: number): number {
  const normalized = Math.round(m / 5) * 5;
  return Math.max(0, Math.min(55, normalized));
}

function HelperText({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] text-muted-foreground">{children}</span>
  );
}

function StatusIcon({ status }: { status?: string | null }) {
  if (!status) return null;
  if (status === "SUCCESS")
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (status === "FAILED")
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  return null;
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "SUCCESS"
      ? "bg-emerald-100 text-emerald-800"
      : status === "FAILED"
        ? "bg-red-100 text-red-800"
        : "bg-muted text-muted-foreground";
  return (
    <span className={"px-1.5 py-0.5 rounded text-[10px] " + color}>
      {status}
    </span>
  );
}

function summarizeSchedule(a: Alarm): string {
  const hm =
    a.hour != null && a.minute != null
      ? `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`
      : "";
  switch (a.schedule_kind) {
    case "ONE_TIME":
      return `단발: ${a.one_time_at ? formatKst(a.one_time_at) : "(미설정)"}`;
    case "DAILY":
      return `매일 ${hm}`;
    case "WEEKLY": {
      const days = (a.weekdays ?? [])
        .sort()
        .map((w) => WEEKDAY_LABEL[w])
        .join("·");
      return `매주 ${days || "(미선택)"} ${hm}`;
    }
    case "MONTHLY":
      return `매월 ${a.day_of_month ?? "?"}일 ${hm}`;
    case "YEARLY":
      return `매년 ${a.month_of_year ?? "?"}월 ${a.day_of_month ?? "?"}일 ${hm}`;
    default:
      return a.schedule_kind;
  }
}

function formatKst(iso: string): string {
  const d = new Date(iso);
  // 사용자는 항상 KST 기준으로 생각 — 명시적으로 Asia/Seoul 로 포맷.
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  // datetime-local 은 timezone 없이 YYYY-MM-DDTHH:MM 포맷.
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  // 로컬 타임을 그대로 ISO 로 (백엔드가 Asia/Seoul 로 해석).
  return new Date(value).toISOString();
}

function sanitize(form: Partial<Alarm>): Partial<Alarm> {
  // 스케줄에 무관한 필드를 명시적으로 null 로 보내 PATCH 가 덮어쓰도록.
  const kind = form.schedule_kind;
  const out: Partial<Alarm> = { ...form };
  if (kind !== "ONE_TIME") out.one_time_at = null;
  if (kind === "ONE_TIME") {
    out.hour = null;
    out.minute = null;
    out.weekdays = null;
    out.day_of_month = null;
    out.month_of_year = null;
  }
  if (kind !== "WEEKLY") out.weekdays = null;
  if (kind !== "MONTHLY" && kind !== "YEARLY") out.day_of_month = null;
  if (kind !== "YEARLY") out.month_of_year = null;
  // 빈 문자열은 null.
  if (!out.slack_channel) out.slack_channel = null;
  if (!out.active_from) out.active_from = null;
  if (!out.active_to) out.active_to = null;
  return out;
}
