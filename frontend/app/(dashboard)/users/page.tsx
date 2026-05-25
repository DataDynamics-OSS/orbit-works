"use client";

import { useMemo, useState } from "react";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, Save } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Role = "ADMIN" | "SALES" | "HR" | "SUPPORT" | "ETC";

type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  created_at: string | null;
};

type FormState = {
  email: string;
  name: string;
  role: Role;
  password: string;
  password_confirm: string;
  is_active: boolean;
};

const BLANK: FormState = {
  email: "",
  name: "",
  role: "SALES",
  password: "",
  password_confirm: "",
  is_active: true,
};

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "관리자",
  SALES: "영업",
  HR: "HR (관리)",
  SUPPORT: "지원",
  ETC: "기타",
};

const ROLE_BADGE: Record<Role, string> = {
  ADMIN: "bg-purple-100 text-purple-700 border-purple-200",
  SALES: "bg-sky-100 text-sky-700 border-sky-200",
  HR: "bg-emerald-100 text-emerald-700 border-emerald-200",
  SUPPORT: "bg-amber-100 text-amber-700 border-amber-200",
  ETC: "bg-slate-100 text-slate-700 border-slate-200",
};

// 기본 관리자 계정 식별자 (config.yaml 의 auth.initial_admin.email 와 일치시키기).
// 서버에서도 삭제를 차단하지만 UI에서도 버튼을 비활성화해 혼동 방지.
const PROTECTED_ADMIN_EMAIL = "admin";

function errorMessage(e: any, fallback: string): string {
  return (
    e?.response?.data?.detail?.[0]?.msg ??
    e?.response?.data?.detail ??
    fallback
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  // Me (to disable dangerous actions on own row)
  const { data: me } = useQuery<{ id: string; role: Role; email: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60 * 1000,
  });

  const { data: users = [], error: listErr } = useQuery<User[]>({
    queryKey: ["users-admin"],
    queryFn: async () => (await api.get("/auth/users")).data,
    retry: false,
  });

  // Dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(BLANK);
  const [addError, setAddError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(BLANK);
  const [editError, setEditError] = useState<string | null>(null);

  const [pwOpen, setPwOpen] = useState(false);
  const [pwTargetId, setPwTargetId] = useState<string | null>(null);
  const [pwTargetEmail, setPwTargetEmail] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  // Mutations
  const createM = useMutation({
    mutationFn: async () => {
      if (addForm.password !== addForm.password_confirm) {
        throw new Error("비밀번호가 일치하지 않습니다.");
      }
      const payload = {
        email: addForm.email,
        name: addForm.name,
        role: addForm.role,
        password: addForm.password,
      };
      return (await api.post("/auth/users", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users-admin"] });
      setAddOpen(false);
      setAddForm(BLANK);
      setAddError(null);
    },
    onError: (e: any) =>
      setAddError(e?.message ?? errorMessage(e, "등록 실패")),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return null;
      const payload: Record<string, unknown> = {
        name: editForm.name,
        role: editForm.role,
        is_active: editForm.is_active,
      };
      return (await api.patch(`/auth/users/${editTargetId}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users-admin"] });
      setEditOpen(false);
      setEditTargetId(null);
      setEditError(null);
    },
    onError: (e: any) => setEditError(errorMessage(e, "수정 실패")),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/auth/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users-admin"] }),
  });

  const pwM = useMutation({
    mutationFn: async () => {
      if (!pwTargetId) return null;
      if (pwNew !== pwConfirm) {
        throw new Error("비밀번호가 일치하지 않습니다.");
      }
      return (
        await api.post(`/auth/users/${pwTargetId}/password`, {
          new_password: pwNew,
        })
      ).data;
    },
    onSuccess: () => {
      setPwOpen(false);
      setPwTargetId(null);
      setPwNew("");
      setPwConfirm("");
      setPwError(null);
    },
    onError: (e: any) =>
      setPwError(e?.message ?? errorMessage(e, "재설정 실패")),
  });

  function openAdd() {
    setAddForm(BLANK);
    setAddError(null);
    setAddOpen(true);
  }

  function openEdit(row: User) {
    setEditTargetId(row.id);
    setEditForm({
      email: row.email,
      name: row.name,
      role: row.role,
      password: "",
      password_confirm: "",
      is_active: row.is_active,
    });
    setEditError(null);
    setEditOpen(true);
  }

  function openPasswordReset(row: User) {
    setPwTargetId(row.id);
    setPwTargetEmail(row.email);
    setPwNew("");
    setPwConfirm("");
    setPwError(null);
    setPwOpen(true);
  }

  async function confirmDelete(row: User) {
    if (row.id === me?.id) {
      await dialog.alert("본인 계정은 삭제할 수 없습니다.");
      return;
    }
    if (row.email === PROTECTED_ADMIN_EMAIL) {
      await dialog.alert("기본 관리자 계정은 삭제할 수 없습니다.");
      return;
    }
    if (
      await dialog.confirm(`"${row.email}" 사용자를 영구 삭제하시겠습니까?`, {
        destructive: true,
      })
    ) {
      deleteM.mutate(row.id);
    }
  }

  const columnDefs = useMemo<ColDef<User>[]>(
    () => [
      {
        field: "email",
        headerName: "ID",
        cellRenderer: (p: any) => (
          <span className="font-medium">
            {p.value}
            {me?.id === p.data?.id && (
              <span className="ml-2 text-xs text-muted-foreground">(나)</span>
            )}
            {p.data?.email === PROTECTED_ADMIN_EMAIL && (
              <span className="ml-2 text-xs text-amber-600">(기본 관리자)</span>
            )}
          </span>
        ),
      },
      { field: "name", headerName: "이름" },
      {
        field: "role",
        headerName: "권한",
        cellRenderer: (p: any) => (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[(p.value as Role) ?? "user"] ?? ""}`}
          >
            {ROLE_LABEL[(p.value as Role) ?? "user"] ?? p.value}
          </span>
        ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
      {
        field: "is_active",
        headerName: "상태",
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="inline-flex items-center gap-1 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              활성
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <span className="inline-block w-2 h-2 rounded-full bg-slate-400" />
              비활성
            </span>
          ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
      {
        field: "created_at",
        headerName: "등록일",
        valueFormatter: (p) =>
          p.value ? new Date(p.value).toLocaleDateString("ko-KR") : "-",
      },
      {
        colId: "actions",
        headerName: "작업",
        cellRenderer: (p: any) => (
          <div className="flex gap-1 items-center h-full">
            <button
              type="button"
              onClick={() => openPasswordReset(p.data as User)}
              className="text-xs text-primary hover:underline"
            >
              비밀번호 재설정
            </button>
          </div>
        ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
        sortable: false,
        filter: false,
      },
    ],
    [me?.id],
  );

  return (
    <>
      <DashboardHeader title="사용자 관리" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        {listErr ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            사용자 목록을 불러올 수 없습니다. 관리자 권한이 필요합니다.
          </div>
        ) : (
          <DataGrid<User>
            rowData={users}
            columnDefs={columnDefs}
            getRowId={(r) => r.id}
            searchPlaceholder="이메일·이름 검색"
            autoSizeStrategy={{
              type: "fitCellContents",
              colIds: ["email", "name", "role", "is_active", "created_at", "actions"],
            }}
            onRowDoubleClicked={openEdit}
            enableCheckbox={false}
          />
        )}
      </div>

      {/* Add Dialog */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="신규 사용자 등록"
        width="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() =>
                addForm.email && addForm.password && createM.mutate()
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              등록
            </button>
          </>
        }
      >
        <UserFormBody
          form={addForm}
          setForm={setAddForm}
          showPassword
          showEmail
          error={addError}
        />
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="사용자 수정"
        width="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => updateM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        <UserFormBody
          form={editForm}
          setForm={setEditForm}
          showPassword={false}
          showEmail={false}
          isSelf={editTargetId === me?.id}
          isAdminRole={editForm.role === "ADMIN"}
          error={editError}
        />
      </Dialog>

      {/* Password Reset Dialog */}
      <Dialog
        open={pwOpen}
        onClose={() => setPwOpen(false)}
        title={`비밀번호 재설정 — ${pwTargetEmail}`}
        width="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setPwOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => pwNew && pwM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <RotateCcw className="h-4 w-4" />
              재설정
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">새 비밀번호 *</span>
            <input
              type="password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              새 비밀번호 확인 *
            </span>
            <input
              type="password"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {pwNew && pwConfirm && pwNew !== pwConfirm && (
              <span className="text-xs text-destructive">
                비밀번호가 일치하지 않습니다.
              </span>
            )}
          </label>
          <p className="text-xs text-muted-foreground">
            관리자 권한으로 비밀번호를 강제 재설정합니다. 해당 사용자에게
            직접 전달해 주세요.
          </p>
          {pwError && (
            <div className="text-xs text-destructive">{pwError}</div>
          )}
        </div>
      </Dialog>
    </>
  );
}

function UserFormBody({
  form,
  setForm,
  showPassword,
  showEmail,
  isSelf,
  isAdminRole,
  error,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  showPassword: boolean;
  showEmail: boolean;
  isSelf?: boolean;
  isAdminRole?: boolean;
  error: string | null;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const roleLocked = isSelf || isAdminRole;
  const roleHint = isSelf
    ? "(본인 계정은 변경 불가)"
    : isAdminRole
      ? "(관리자 권한은 다른 역할로 변경 불가)"
      : "";
  const pwMismatch =
    showPassword &&
    !!form.password &&
    !!form.password_confirm &&
    form.password !== form.password_confirm;
  return (
    <div className="grid grid-cols-1 gap-3">
      {showEmail && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">ID *</span>
          <input
            value={form.email}
            onChange={(e) =>
              setForm((p) => ({ ...p, email: e.target.value }))
            }
            placeholder="예: alice"
            className={input}
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">이름</span>
        <input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">권한 {roleHint}</span>
        <select
          value={form.role}
          onChange={(e) =>
            setForm((p) => ({ ...p, role: e.target.value as Role }))
          }
          disabled={roleLocked}
          className={input + " disabled:opacity-60"}
        >
          <option value="ADMIN">관리자</option>
          <option value="SALES">영업</option>
          <option value="HR">HR (관리)</option>
          <option value="SUPPORT">지원</option>
          <option value="ETC">기타</option>
        </select>
      </label>
      {!showPassword && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.is_active}
            disabled={isSelf}
            onChange={(e) =>
              setForm((p) => ({ ...p, is_active: e.target.checked }))
            }
          />
          계정 활성 상태 {isSelf && "(본인 계정은 변경 불가)"}
        </label>
      )}
      {showPassword && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">초기 비밀번호 *</span>
            <input
              type="password"
              value={form.password}
              onChange={(e) =>
                setForm((p) => ({ ...p, password: e.target.value }))
              }
              autoComplete="new-password"
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              초기 비밀번호 확인 *
            </span>
            <input
              type="password"
              value={form.password_confirm}
              onChange={(e) =>
                setForm((p) => ({ ...p, password_confirm: e.target.value }))
              }
              autoComplete="new-password"
              className={input}
            />
            {pwMismatch && (
              <span className="text-xs text-destructive">
                비밀번호가 일치하지 않습니다.
              </span>
            )}
          </label>
        </>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
