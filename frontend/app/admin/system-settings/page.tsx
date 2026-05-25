"use client";

/**
 * SUPER_ADMIN — 시스템 전역 설정. 단일 deployment 의 1세트만 적용되는 항목들.
 *
 * - JWT 만료 시간
 * - 업로드 한도 (FastAPI 단일 프로세스)
 * - 로그 레벨 (단일 프로세스 root logger)
 * - PWA Web Push VAPID 키쌍 (deployment 단일 — 모든 tenant 공통)
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { fetchSection, saveSection } from "@/components/settings/settings-api";
import { useDialog } from "@/components/ui/DialogProvider";

type AuthFull = { jwt_expires_minutes: number };
type UploadFull = { max_size_mb: number };
type LoggingFull = { level: string };
type PushFull = {
  enabled: boolean;
  vapid_subject: string;
  vapid_public_key: string;
  vapid_private_key: string;
};

const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

export default function SystemSettingsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: au } = useQuery<AuthFull>({
    queryKey: ["settings", "auth"],
    queryFn: () => fetchSection("auth"),
  });
  const { data: up } = useQuery<UploadFull>({
    queryKey: ["settings", "upload"],
    queryFn: () => fetchSection("upload"),
  });
  const { data: lg } = useQuery<LoggingFull>({
    queryKey: ["settings", "logging"],
    queryFn: () => fetchSection("logging"),
  });
  const { data: ps } = useQuery<PushFull>({
    queryKey: ["settings", "push"],
    queryFn: () => fetchSection("push"),
  });

  const [auForm, setAuForm] = useState<AuthFull | null>(null);
  const [upForm, setUpForm] = useState<UploadFull | null>(null);
  const [lgForm, setLgForm] = useState<LoggingFull | null>(null);
  const [psForm, setPsForm] = useState<PushFull | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (au?.jwt_expires_minutes !== undefined) {
      setAuForm({ jwt_expires_minutes: au.jwt_expires_minutes });
    }
  }, [au]);
  useEffect(() => {
    if (up?.max_size_mb !== undefined) setUpForm({ max_size_mb: up.max_size_mb });
  }, [up]);
  useEffect(() => {
    if (lg?.level) setLgForm({ level: lg.level });
  }, [lg]);
  useEffect(() => {
    if (ps) {
      setPsForm({
        enabled: !!ps.enabled,
        vapid_subject: ps.vapid_subject ?? "",
        vapid_public_key: ps.vapid_public_key ?? "",
        vapid_private_key: ps.vapid_private_key ?? "",
      });
    }
  }, [ps]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (auForm) await saveSection("auth", auForm);
      if (upForm) await saveSection("upload", upForm);
      if (lgForm) await saveSection("logging", lgForm);
      if (psForm) await saveSection("push", psForm);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const ready = auForm && upForm && lgForm && psForm;
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const mono = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono";

  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">시스템 설정</h1>
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
              <h3 className="text-sm font-semibold">인증 (JWT)</h3>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  JWT 만료 시간 (분)
                </label>
                <input
                  type="number" min={5}
                  className={input}
                  value={auForm!.jwt_expires_minutes}
                  onChange={(e) =>
                    setAuForm({ ...auForm!, jwt_expires_minutes: Number(e.target.value) })
                  }
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  기본 1440분(24시간). 변경 시 이후 발급되는 토큰부터 적용. 모든 tenant 공통.
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold">업로드</h3>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  최대 업로드 크기 (MB)
                </label>
                <input
                  type="number" min={1}
                  className={input}
                  value={upForm!.max_size_mb}
                  onChange={(e) => setUpForm({ max_size_mb: Number(e.target.value) })}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  단일 프로세스 적용 — 모든 tenant 공통.
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold">로그</h3>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  루트 로그 레벨
                </label>
                <select
                  className={input}
                  value={lgForm!.level}
                  onChange={(e) => setLgForm({ level: e.target.value })}
                >
                  {LOG_LEVELS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  변경 즉시 적용. 디버깅 후엔 INFO 로 원복.
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">PWA Web Push (VAPID)</h3>
                <label className="inline-flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={psForm!.enabled}
                    onChange={(e) => setPsForm({ ...psForm!, enabled: e.target.checked })}
                  />
                  활성화
                </label>
              </div>
              <p className="text-[11px] text-muted-foreground">
                deployment 단일 키쌍 — 모든 tenant 공통. 키 회전 시 모든 사용자
                구독이 무효화되어 재등록이 필요. 신규 키 생성: <span className="font-mono">npx web-push generate-vapid-keys --json</span>
              </p>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  Subject (mailto: 또는 https:// URL — 운영자 연락처)
                </label>
                <input
                  type="text"
                  className={input}
                  value={psForm!.vapid_subject}
                  onChange={(e) =>
                    setPsForm({ ...psForm!, vapid_subject: e.target.value })
                  }
                  placeholder="mailto:admin@example.com"
                />
              </div>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  Public Key (Base64URL)
                </label>
                <textarea
                  className={mono}
                  rows={2}
                  value={psForm!.vapid_public_key}
                  onChange={(e) =>
                    setPsForm({ ...psForm!, vapid_public_key: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block mb-1 text-xs font-medium text-muted-foreground">
                  Private Key (PEM 또는 Base64URL — 평문 저장)
                </label>
                <textarea
                  className={mono}
                  rows={6}
                  value={psForm!.vapid_private_key}
                  onChange={(e) =>
                    setPsForm({ ...psForm!, vapid_private_key: e.target.value })
                  }
                />
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
