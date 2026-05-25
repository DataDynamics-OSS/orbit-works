"use client";

/**
 * Tier 1 — 피처별 알림 ON/OFF (tenant ADMIN).
 *
 * `notify.gates.<feature>` 토글. 마스터 스위치(`notify.enabled`) 와 provider/토큰
 * 설정은 "외부 연동" 탭에서. 여기서는 마스터 상태를 read-only 배너로만 보여주고
 * 각 피처별 게이트만 편집한다.
 *
 * 백엔드 dispatcher(`services/notify/__init__.py`) 가 `feature` 인자를 받아
 * `cfg.gates.<feature>` 를 검사 — 토글 한 줄로 해당 피처 발송 전체가 멈춘다.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";

type NotifyGates = {
  approval: boolean;
  leave: boolean;
  meeting: boolean;
  meeting_note: boolean;
  weekly_report: boolean;
  goal: boolean;
  evaluation: boolean;
  alarm: boolean;
  action_item: boolean;
  cloud_cost: boolean;
  developer_auth: boolean;
  expiry_alert: boolean;
  calendar_event: boolean;
  support_case: boolean;
  support_case_comment: boolean;
};

type NotifyFull = {
  enabled: boolean;
  provider: "slack" | "mattermost";
  slack: Record<string, unknown>;
  mattermost: Record<string, unknown>;
  notifications: Record<string, unknown>;
  gates: NotifyGates;
};

type FeatureKey = keyof NotifyGates;

type FeatureDef = {
  key: FeatureKey;
  label: string;
  description: string;
};

type FeatureGroup = {
  title: string;
  description: string;
  items: FeatureDef[];
};

const GROUPS: FeatureGroup[] = [
  {
    title: "결재 · 인사",
    description: "결재선·휴가·평가 관련 알림",
    items: [
      {
        key: "approval",
        label: "결재",
        description: "결재 신청·차례·승인·반려·취소·위임 시 결재자/신청자에게 DM",
      },
      {
        key: "leave",
        label: "휴가",
        description: "연차 신청·승인·반려·취소 시 신청자/결재자에게 DM",
      },
      {
        key: "evaluation",
        label: "평가",
        description: "평가 사이클 시작·자기평가 제출·매니저평가 제출·공개 + 마감 D-3 리마인더",
      },
      {
        key: "developer_auth",
        label: "신규 비밀번호",
        description: "신규 임직원 등록 시 ADMIN/HR 에게 초기 비밀번호 DM",
      },
    ],
  },
  {
    title: "협업",
    description: "회의·보고·목표·액션 관련 알림",
    items: [
      {
        key: "meeting",
        label: "회의실 예약",
        description: "회의실 예약 생성·변경·취소 시 주최자/참석자에게 DM",
      },
      {
        key: "meeting_note",
        label: "회의록",
        description: "회의록 신규 작성·수동 발송 시 참석자에게 DM",
      },
      {
        key: "weekly_report",
        label: "주간보고 코멘트",
        description: "내 주간보고에 타인이 코멘트 달았을 때 작성자에게 DM",
      },
      {
        key: "goal",
        label: "목표",
        description: "개인 목표 완료(매니저에게) + 마감 D-30 / OVERDUE 리마인더",
      },
      {
        key: "action_item",
        label: "액션 아이템",
        description: "할당된 액션의 D-3 / D-1 / D-Day 마감 리마인더 (매일 09:00)",
      },
    ],
  },
  {
    title: "일정 · 알람",
    description: "스케줄러·캘린더·만료 알림",
    items: [
      {
        key: "alarm",
        label: "사용자 정의 알람",
        description: "관리 > 알람에서 등록한 정기/단발 메시지 (cron 기반)",
      },
      {
        key: "calendar_event",
        label: "캘린더 비공개 일정",
        description: "EVENT_PRIVATE 타입 일정의 당일 09:00 알림",
      },
      {
        key: "expiry_alert",
        label: "만료 D-30 알림",
        description: "프로젝트·인력 투입·SW 라이센스 만료 임박 (매일 01:00)",
      },
    ],
  },
  {
    title: "운영",
    description: "인프라·비용 알림",
    items: [
      {
        key: "cloud_cost",
        label: "클라우드 비용",
        description: "AWS/Azure/GCP 일일 임계 / 월 예측 / 일일 변동률 / 신규 서비스 / 수집 실패",
      },
    ],
  },
  {
    title: "기술지원",
    description: "기술지원 케이스 관련 알림",
    items: [
      {
        key: "support_case",
        label: "신규 케이스",
        description: "케이스 등록 시 SUPPORT 역할 임직원에게 고객사·제목·벤더·제품·심각도·링크 DM",
      },
      {
        key: "support_case_comment",
        label: "코멘트 추가",
        description: "케이스 코멘트 추가 시 SUPPORT 역할 임직원(작성자 제외)에게 고객사·제목·프로젝트·기술지원 담당자·작성자·본문 미리보기·링크 DM",
      },
    ],
  },
];

const DEFAULT_GATES: NotifyGates = {
  approval: true,
  leave: true,
  meeting: true,
  meeting_note: true,
  weekly_report: true,
  goal: true,
  evaluation: true,
  alarm: true,
  action_item: true,
  cloud_cost: true,
  developer_auth: true,
  expiry_alert: true,
  calendar_event: true,
  support_case: true,
  support_case_comment: true,
};

export function NotificationsToggleTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data, isLoading } = useQuery<NotifyFull>({
    queryKey: ["settings", "notify"],
    queryFn: () => fetchSection<NotifyFull>("notify"),
  });

  const [gates, setGates] = useState<NotifyGates | null>(null);
  useEffect(() => {
    if (data) setGates({ ...DEFAULT_GATES, ...(data.gates || {}) });
  }, [data]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!data || !gates) return;
      return saveSection("notify", { ...data, gates });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "notify"] });
      dialog.alert("알림 설정을 저장했습니다.");
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.detail ?? e?.message ?? "저장 실패";
      dialog.alert(`저장 실패: ${msg}`);
    },
  });

  function setGate(key: FeatureKey, value: boolean) {
    setGates((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function setAllInGroup(items: FeatureDef[], value: boolean) {
    setGates((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      for (const it of items) next[it.key] = value;
      return next;
    });
  }

  if (isLoading || !data || !gates) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">
        불러오는 중…
      </div>
    );
  }

  const masterEnabled = data.enabled;

  return (
    <div className="flex flex-col gap-4">
      {/* 마스터 상태 안내 — 활성/비활성 색상으로 즉시 식별. provider 설정은 외부 연동 탭. */}
      <div
        className={
          "rounded-lg border p-4 shadow-sm " +
          (masterEnabled
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : "border-amber-200 bg-amber-50 text-amber-900")
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium">
              {masterEnabled
                ? "Slack / Mattermost 알림 활성"
                : "Slack / Mattermost 알림 비활성"}
            </div>
            <div className="mt-0.5 text-xs">
              {masterEnabled
                ? `provider=${data.provider} — 아래 피처별 토글이 실제로 적용됩니다.`
                : "마스터 스위치가 꺼져 있어 어떤 피처도 발송되지 않습니다. \"외부 연동\" 탭에서 활성 후 저장하세요."}
            </div>
          </div>
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={saveM.isPending}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            저장
          </button>
        </div>
      </div>

      {/* 그룹별 피처 토글 */}
      {GROUPS.map((group) => {
        const allOn = group.items.every((it) => gates[it.key]);
        const allOff = group.items.every((it) => !gates[it.key]);
        return (
          <section
            key={group.title}
            className="rounded-lg border border-border bg-card shadow-sm"
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">{group.title}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {group.description}
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => setAllInGroup(group.items, true)}
                  disabled={allOn}
                  className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-40"
                >
                  모두 ON
                </button>
                <button
                  type="button"
                  onClick={() => setAllInGroup(group.items, false)}
                  disabled={allOff}
                  className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-40"
                >
                  모두 OFF
                </button>
              </div>
            </header>
            <ul className="divide-y divide-border">
              {group.items.map((item) => {
                const on = gates[item.key];
                return (
                  <li
                    key={item.key}
                    className="flex items-start justify-between gap-4 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{item.label}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {item.description}
                      </div>
                    </div>
                    <label
                      className={
                        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors " +
                        (on ? "bg-primary" : "bg-muted")
                      }
                    >
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={on}
                        onChange={(e) => setGate(item.key, e.target.checked)}
                      />
                      <span
                        className={
                          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
                          (on ? "translate-x-5" : "translate-x-0.5")
                        }
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {!masterEnabled && (
        <p className="text-xs text-muted-foreground">
          ※ 마스터 스위치가 꺼진 상태에서도 여기 토글 값은 저장됩니다 — 마스터를
          켜면 즉시 반영됩니다.
        </p>
      )}
    </div>
  );
}
