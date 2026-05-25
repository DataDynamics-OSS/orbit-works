"use client";

/**
 * 임직원의 연차 승인자 (1명+ Primary, 나머지 참조) 설정.
 *
 * 원래 임직원 상세의 ApproversSection 을 권한 관리 메뉴(탭: 결재선·보안등급)
 * 로 이동. backend: GET/PUT /developers/{id}/approvers.
 *
 * 후보: 임직원(FULL_TIME) 중 로그인 계정(users)이 존재하는 사람만 (권한 체크가
 * users.id 기반).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

type Approver = {
  id: string;
  developer_id: string;
  approver_user_id: string;
  approver_name: string | null;
  approver_email: string | null;
  is_primary: boolean;
  position: number;
};
type UserOpt = { id: string; name?: string | null; email: string };
type DevOpt = {
  id: string;
  name: string;
  tag: string | null;
  email: string | null;
  employment_type: string;
};
type DevCandidate = DevOpt & { user_id: string };

export function LeaveApproversSection({ developerId }: { developerId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: rows = [] } = useQuery<Approver[]>({
    queryKey: ["dev-approvers", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/approvers`)).data,
    staleTime: 30_000,
  });

  const { data: devs = [] } = useQuery<DevOpt[]>({
    queryKey: ["devs-directory-fulltime"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 5 * 60 * 1000,
  });
  const { data: users = [] } = useQuery<UserOpt[]>({
    queryKey: ["users-directory"],
    queryFn: async () => (await api.get("/auth/users/directory")).data,
    staleTime: 5 * 60 * 1000,
  });

  const candidates: DevCandidate[] = useMemo(() => {
    if (devs.length === 0 || users.length === 0) return [];
    const userByEmail = new Map(users.map((u) => [u.email, u]));
    return devs.flatMap((d) => {
      const u = d.email ? userByEmail.get(d.email) : undefined;
      return u ? [{ ...d, user_id: u.id }] : [];
    });
  }, [devs, users]);

  const [draft, setDraft] = useState<Approver[] | null>(null);
  const current = draft ?? rows;
  const dirty = draft !== null;

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = (draft ?? []).map((a) => ({
        user_id: a.approver_user_id,
        is_primary: a.is_primary,
      }));
      return (await api.put(`/developers/${developerId}/approvers`, payload))
        .data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-approvers", developerId] });
      setDraft(null);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", {
        title: "승인자 저장 오류",
      });
    },
  });

  const available = candidates.filter(
    (c) => !current.some((x) => x.approver_user_id === c.user_id),
  );

  function addApprover(c: DevCandidate) {
    const next: Approver = {
      id: `tmp-${c.user_id}`,
      developer_id: developerId,
      approver_user_id: c.user_id,
      approver_name: c.name,
      approver_email: c.email,
      is_primary: current.length === 0,
      position: current.length,
    };
    setDraft([...(draft ?? rows), next]);
  }

  function removeApprover(idx: number) {
    const next = (draft ?? rows).slice();
    next.splice(idx, 1);
    if (next.length > 0 && !next.some((r) => r.is_primary)) {
      next[0] = { ...next[0], is_primary: true };
    }
    setDraft(next.map((r, i) => ({ ...r, position: i })));
  }

  function togglePrimary(idx: number) {
    const next = (draft ?? rows).map((r, i) => ({
      ...r,
      is_primary: i === idx,
    }));
    setDraft(next);
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold">연차 승인자</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            별표(Primary) 1명은 Direct Message 주요 수신자. 나머지는 참조. ADMIN
            은 항상 승인 가능.
          </p>
        </div>
        {dirty && (
          <div className="inline-flex gap-2">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs"
            >
              취소
            </button>
            <button
              type="button"
              disabled={saveM.isPending}
              onClick={() => saveM.mutate()}
              className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중…" : "저장"}
            </button>
          </div>
        )}
      </header>

      <div className="px-4 py-3 space-y-3">
        {current.length === 0 ? (
          <div className="text-sm text-muted-foreground py-2">
            지정된 승인자가 없습니다. ADMIN 만 승인할 수 있습니다.
          </div>
        ) : (
          <ul className="divide-y divide-border border border-border rounded-md">
            {current.map((a, idx) => (
              <li
                key={a.approver_user_id}
                className="flex items-center gap-2 px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => togglePrimary(idx)}
                  title={a.is_primary ? "Primary" : "Primary 로 지정"}
                  className={
                    "h-6 w-6 inline-flex items-center justify-center rounded " +
                    (a.is_primary
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted")
                  }
                >
                  {a.is_primary ? "★" : "☆"}
                </button>
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {a.approver_name || a.approver_email}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {a.approver_email}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeApprover(idx)}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-destructive/40 text-destructive hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {available.length > 0 ? (
          <div className="flex items-center gap-2">
            <select
              value=""
              onChange={(e) => {
                const c = available.find((x) => x.user_id === e.target.value);
                if (c) addApprover(c);
                e.currentTarget.value = "";
              }}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm min-w-[260px]"
            >
              <option value="">승인자 추가 (임직원)…</option>
              {available
                .slice()
                .sort((a, b) =>
                  (a.name + (a.tag ?? "")).localeCompare(
                    b.name + (b.tag ?? ""),
                    "ko-KR",
                  ),
                )
                .map((c) => (
                  <option key={c.user_id} value={c.user_id}>
                    {c.name}
                    {c.tag ? ` [${c.tag}]` : ""}
                    {c.email ? ` · ${c.email}` : ""}
                  </option>
                ))}
            </select>
          </div>
        ) : (
          devs.length > 0 && (
            <div className="text-xs text-muted-foreground">
              로그인 계정(users)이 있는 임직원만 승인자로 지정 가능합니다.
              현재 연결 가능한 후보가 없습니다.
            </div>
          )
        )}
      </div>
    </section>
  );
}
