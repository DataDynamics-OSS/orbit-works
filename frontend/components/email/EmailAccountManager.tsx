"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Plus, Trash2, Users, X } from "lucide-react";

import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Account = {
  id: string;
  display_name: string;
  email_addr: string;
  kind: string;
  protocol: string;
  host: string;
  port: number;
  security: string;
  username: string;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
  smtp_username: string | null;
  shared_seen: boolean;
  sync_enabled: boolean;
  last_error: string | null;
  can_manage?: boolean;
  // 단건 조회에서만 채워짐(저장된 평문). 목록에서는 null.
  password_plain?: string | null;
  smtp_password_plain?: string | null;
};

type Member = {
  id: string;
  user_id: string;
  user_name: string | null;
  role: string;
  can_send: boolean;
  can_manage: boolean;
};

type PickUser = { id: string; name: string; email: string };

const EMPTY_FORM = {
  display_name: "",
  email_addr: "",
  kind: "PERSONAL",
  protocol: "IMAP",
  host: "",
  port: 993,
  security: "SSL",
  username: "",
  password: "",
  smtp_host: "",
  smtp_port: 587,
  smtp_security: "STARTTLS",
  smtp_username: "",
  smtp_password: "",
  shared_seen: false,
};
type FormState = typeof EMPTY_FORM;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const INPUT =
  "h-9 rounded-md border border-input bg-background px-2 text-sm w-full";

export function EmailAccountManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [editing, setEditing] = useState<string | null>(null); // account id or "new"
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [membersFor, setMembersFor] = useState<Account | null>(null);

  const { data: accounts } = useQuery<Account[]>({
    queryKey: ["email-accounts"],
    queryFn: async () => (await api.get("/email/accounts")).data,
  });

  function fillForm(a: Account, password: string, smtpPassword: string) {
    setForm({
      ...EMPTY_FORM,
      display_name: a.display_name,
      email_addr: a.email_addr,
      kind: a.kind,
      protocol: a.protocol,
      host: a.host,
      port: a.port,
      security: a.security,
      username: a.username,
      smtp_host: a.smtp_host ?? "",
      smtp_port: a.smtp_port ?? 587,
      smtp_security: a.smtp_security ?? "STARTTLS",
      smtp_username: a.smtp_username ?? "",
      shared_seen: a.shared_seen,
      password,
      smtp_password: smtpPassword,
    });
  }

  function startNew() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }
  async function startEdit(a: Account) {
    // 우선 목록 데이터로 즉시 폼 채움(비번은 비움), 이어 단건 조회로 저장된 평문 채움.
    fillForm(a, "", "");
    setEditing(a.id);
    try {
      const full = (await api.get(`/email/accounts/${a.id}`)).data as Account;
      fillForm(
        full,
        full.password_plain ?? "",
        full.smtp_password_plain ?? "",
      );
    } catch {
      /* 단건 조회 실패해도 편집은 계속(비번 빈 채 → 유지) */
    }
  }

  const saveM = useMutation({
    mutationFn: async () => {
      const body: any = { ...form };
      // 빈 비밀번호는 보내지 않음(편집 시 기존 유지). 생성 시엔 그대로.
      if (editing !== "new" && !body.password) delete body.password;
      if (!body.smtp_password) delete body.smtp_password;
      if (editing === "new") {
        return (await api.post("/email/accounts", body)).data;
      }
      return (await api.patch(`/email/accounts/${editing}`, body)).data;
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["email-accounts"] });
      setEditing(null);
      await dialog.alert("저장되었습니다.");
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/email/accounts/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-accounts"] }),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  const testM = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/email/accounts/${id}/test`)).data,
    // 테스트가 last_error 를 갱신/해제하므로 성공·실패 모두 목록을 다시 가져온다.
    onSettled: () => qc.invalidateQueries({ queryKey: ["email-accounts"] }),
    onSuccess: async (d: any) =>
      dialog.alert(`연결 성공 — 폴더 ${d.folder_count}개`),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "연결 실패", { title: "연결 테스트" }),
  });
  // 테스트는 단일 mutation 인스턴스 — 진행 중인 계정 id 를 좁혀서 해당 행만 표시.
  const testingId = testM.isPending ? (testM.variables as string) : null;

  async function confirmDelete(a: Account) {
    const ok = await dialog.confirm(
      `'${a.display_name}' 계정을 삭제할까요? 보관된 메일도 함께 삭제됩니다.`,
      { destructive: true },
    );
    if (ok) deleteM.mutate(a.id);
  }

  return (
    <Dialog open onClose={onClose} title="메일 계정 관리" width="max-w-[480px]">
      <div className="w-full space-y-4">
        {/* 계정 목록 */}
        {editing === null && !membersFor && (
          <>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={startNew}
                className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
              >
                <Plus className="h-4 w-4" /> 새 계정
              </button>
            </div>
            <div className="space-y-2">
              {(accounts ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground">
                  등록된 계정이 없습니다.
                </div>
              )}
              {(accounts ?? []).map((a) => {
                const testing = testingId === a.id;
                return (
                <div
                  key={a.id}
                  className="rounded-md border border-border p-2 text-sm"
                >
                 <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {a.display_name}
                      {a.kind === "SHARED" && (
                        <span className="ml-1 rounded bg-muted px-1 text-[10px]">
                          공유
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.email_addr} · {a.protocol} {a.host}:{a.port}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => testM.mutate(a.id)}
                    disabled={testing}
                    className="h-8 rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-60"
                  >
                    {testing ? "테스트 중…" : "테스트"}
                  </button>
                  {a.kind === "SHARED" && a.can_manage !== false && (
                    <button
                      type="button"
                      onClick={() => setMembersFor(a)}
                      className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
                    >
                      <Users className="h-3.5 w-3.5" /> 멤버
                    </button>
                  )}
                  {a.can_manage !== false && (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(a)}
                        className="h-8 rounded-md border border-border px-2 text-xs hover:bg-muted"
                      >
                        편집
                      </button>
                      <button
                        type="button"
                        onClick={() => confirmDelete(a)}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                 </div>
                 {/* 연결 테스트 진행 표시 — 서버가 진행률을 주지 않으므로 indeterminate bar. */}
                 {testing && (
                   <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                     <div className="h-full w-1/3 rounded-full bg-primary animate-backup-progress" />
                   </div>
                 )}
                </div>
                );
              })}
            </div>
          </>
        )}

        {/* 계정 추가/편집 폼 */}
        {editing !== null && (
          <AccountForm
            form={form}
            setForm={setForm}
            isNew={editing === "new"}
            saving={saveM.isPending}
            onCancel={() => setEditing(null)}
            onSave={() => saveM.mutate()}
          />
        )}

        {/* 멤버 관리 */}
        {membersFor && (
          <MemberPanel account={membersFor} onClose={() => setMembersFor(null)} />
        )}
      </div>
    </Dialog>
  );
}

function AccountForm({
  form,
  setForm,
  isNew,
  saving,
  onCancel,
  onSave,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  isNew: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (k: keyof FormState, v: any) => setForm({ ...form, [k]: v });
  const [showPassword, setShowPassword] = useState(false);
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{isNew ? "새 계정" : "계정 편집"}</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="표시 이름">
          <input
            className={INPUT}
            value={form.display_name}
            onChange={(e) => set("display_name", e.target.value)}
          />
        </Field>
        <Field label="메일 주소">
          <input
            className={INPUT}
            value={form.email_addr}
            onChange={(e) => set("email_addr", e.target.value)}
          />
        </Field>
        <Field label="종류">
          <select
            className={INPUT}
            value={form.kind}
            disabled={!isNew}
            onChange={(e) => set("kind", e.target.value)}
          >
            <option value="PERSONAL">개인</option>
            <option value="SHARED">공유</option>
          </select>
        </Field>
        <Field label="프로토콜">
          <select
            className={INPUT}
            value={form.protocol}
            onChange={(e) => set("protocol", e.target.value)}
          >
            <option value="IMAP">IMAP</option>
            <option value="POP3">POP3</option>
          </select>
        </Field>
      </div>

      <div className="text-[11px] font-medium text-muted-foreground">수신 서버</div>
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <Field label="호스트">
            <input
              className={INPUT}
              value={form.host}
              onChange={(e) => set("host", e.target.value)}
            />
          </Field>
        </div>
        <Field label="포트">
          <input
            type="number"
            className={INPUT}
            value={form.port}
            onChange={(e) => set("port", Number(e.target.value))}
          />
        </Field>
        <Field label="보안">
          <select
            className={INPUT}
            value={form.security}
            onChange={(e) => set("security", e.target.value)}
          >
            <option value="SSL">SSL</option>
            <option value="STARTTLS">STARTTLS</option>
            <option value="NONE">없음</option>
          </select>
        </Field>
        <div className="col-span-2">
          <Field label="사용자명">
            <input
              className={INPUT}
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
            />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={isNew ? "비밀번호" : "비밀번호(변경 시만)"}>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                className={INPUT + " pr-9 text-foreground"}
                value={form.password}
                placeholder={isNew ? "" : "변경하지 않으면 비워두세요"}
                onChange={(e) => set("password", e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 표시"}
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </Field>
        </div>
      </div>

      <div className="text-[11px] font-medium text-muted-foreground">발송 서버(SMTP)</div>
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <Field label="SMTP 호스트">
            <input
              className={INPUT}
              value={form.smtp_host}
              onChange={(e) => set("smtp_host", e.target.value)}
            />
          </Field>
        </div>
        <Field label="포트">
          <input
            type="number"
            className={INPUT}
            value={form.smtp_port}
            onChange={(e) => set("smtp_port", Number(e.target.value))}
          />
        </Field>
        <Field label="보안">
          <select
            className={INPUT}
            value={form.smtp_security}
            onChange={(e) => set("smtp_security", e.target.value)}
          >
            <option value="STARTTLS">STARTTLS</option>
            <option value="SSL">SSL</option>
            <option value="NONE">없음</option>
          </select>
        </Field>
      </div>

      {form.kind === "SHARED" && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.shared_seen}
            onChange={(e) => set("shared_seen", e.target.checked)}
          />
          공유 읽음(한 명이 읽으면 모두 읽음으로 처리)
        </label>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted"
        >
          취소
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </div>
  );
}

function MemberPanel({
  account,
  onClose,
}: {
  account: Account;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [pickUserId, setPickUserId] = useState("");
  const [canSend, setCanSend] = useState(true);

  const { data: members } = useQuery<Member[]>({
    queryKey: ["email-account-members", account.id],
    queryFn: async () =>
      (await api.get(`/email/accounts/${account.id}/members`)).data,
  });
  const { data: users } = useQuery<PickUser[]>({
    queryKey: ["email-users-picker"],
    queryFn: async () => (await api.get("/email/users-picker")).data,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["email-account-members", account.id] });

  const addM = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/email/accounts/${account.id}/members`, {
          user_id: pickUserId,
          role: "MEMBER",
          can_send: canSend,
          can_manage: false,
        })
      ).data,
    onSuccess: () => {
      setPickUserId("");
      invalidate();
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "추가 실패", { title: "오류" }),
  });
  const removeM = useMutation({
    mutationFn: async (mid: string) =>
      (await api.delete(`/email/accounts/${account.id}/members/${mid}`)).data,
    onSuccess: invalidate,
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "제거 실패", { title: "오류" }),
  });

  const existingIds = new Set((members ?? []).map((m) => m.user_id));
  const selectable = (users ?? []).filter((u) => !existingIds.has(u.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          멤버 — {account.display_name}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-1">
        {(members ?? []).map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
          >
            <span className="flex-1 truncate">
              {m.user_name ?? m.user_id}{" "}
              <span className="text-xs text-muted-foreground">({m.role})</span>
            </span>
            {!m.can_send && (
              <span className="text-[11px] text-muted-foreground">발송 불가</span>
            )}
            {m.role !== "OWNER" && (
              <button
                type="button"
                onClick={() => removeM.mutate(m.id)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-rose-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-end gap-2 border-t border-border pt-3">
        <Field label="멤버 추가">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm w-[300px]"
            value={pickUserId}
            onChange={(e) => setPickUserId(e.target.value)}
          >
            <option value="">사용자 선택…</option>
            {selectable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-1 pb-2 text-xs">
          <input
            type="checkbox"
            checked={canSend}
            onChange={(e) => setCanSend(e.target.checked)}
          />
          발송 허용
        </label>
        <button
          type="button"
          disabled={!pickUserId || addM.isPending}
          onClick={() => addM.mutate()}
          className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          추가
        </button>
      </div>
    </div>
  );
}
