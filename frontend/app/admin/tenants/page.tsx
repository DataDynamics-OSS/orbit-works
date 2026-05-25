"use client";

/**
 * SUPER_ADMIN — Tenant 목록 + 신규/수정/비활성.
 *
 * 신규 생성: tenant 메타데이터 + 첫 admin 유저 → 저장 → 자동 로그아웃 → 로그인 화면.
 * 수정: 회사 프로필 + 도메인 + 활성 상태 변경 (admin 유저는 별도 흐름).
 * 비활성: soft delete — 데이터 row 는 유지, tenant 사용자 로그인만 차단.
 */

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Power, PowerOff, Save, Trash2, X } from "lucide-react";
import { api, clearToken } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

type Tenant = {
  id: string;
  slug: string;
  name: string;
  domains: string[];
  is_active: boolean;
  business_no: string | null;
  representative: string | null;
  address: string | null;
  phone: string | null;
  fax: string | null;
  contact_email: string | null;
  name_en: string | null;
  representative_en: string | null;
  address_en: string | null;
  number_prefix: string;
  developer_count: number;
  user_count: number;
  admin_count: number;
  created_at: string | null;
};

export default function TenantsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [openNew, setOpenNew] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ["admin-tenants"],
    queryFn: async () => (await api.get("/tenants")).data,
    staleTime: 0,
  });

  const setActiveM = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      if (active) {
        await api.patch(`/tenants/${id}`, { is_active: true });
      } else {
        await api.delete(`/tenants/${id}`);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-tenants"] }),
  });

  const hardDeleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/tenants/${id}/hard-delete`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-tenants"] }),
  });

  async function toggleActive(t: Tenant) {
    if (t.is_active) {
      const ok = await dialog.confirm(
        `${t.name} 을(를) 비활성화하시겠습니까?\n해당 회사의 모든 사용자는 로그인이 차단됩니다. 데이터는 유지됩니다.`,
        { destructive: true, title: "Tenant 비활성" },
      );
      if (!ok) return;
    }
    setActiveM.mutate({ id: t.id, active: !t.is_active });
  }

  async function hardDelete(t: Tenant) {
    const ok = await dialog.confirm(
      `${t.name} 을(를) 영구 삭제하시겠습니까?\n\n` +
        "삭제 버튼을 누르는 경우 관련된 모든 데이터를 삭제합니다. " +
        "다시 복원할 수 없습니다.",
      { destructive: true, title: "Tenant 영구 삭제" },
    );
    if (!ok) return;
    hardDeleteM.mutate(t.id);
  }

  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">Tenant 관리</h1>
        <button
          type="button"
          onClick={() => setOpenNew(true)}
          className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
        >
          <Plus className="h-4 w-4" />
          Tenant 추가
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {tenants.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
            등록된 tenant 가 없습니다. 우측 상단 "Tenant 추가" 로 첫 회사를 등록하세요.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-sm uppercase text-muted-foreground">
                <tr>
                  <th className="p-2 text-left">Slug</th>
                  <th className="p-2 text-left">이름</th>
                  <th className="p-2 text-left">도메인</th>
                  <th className="p-2 text-left">대표자</th>
                  <th className="p-2 text-left">사업자번호</th>
                  <th className="p-2 text-right">인원</th>
                  <th className="p-2 text-center">상태</th>
                  <th className="p-2 text-right">작업</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-t border-border">
                    <td className="p-2 font-mono">{t.slug}</td>
                    <td className="p-2 font-medium">{t.name}</td>
                    <td className="p-2 text-muted-foreground">
                      {t.domains.join(", ") || "—"}
                    </td>
                    <td className="p-2">{t.representative ?? "—"}</td>
                    <td className="p-2 font-mono">{t.business_no ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums leading-tight">
                      <div>Total {t.developer_count}</div>
                      <div>Active {t.user_count}</div>
                      <div>Admin {t.admin_count}</div>
                    </td>
                    <td className="p-2 text-center">
                      {t.is_active ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-sm text-emerald-700">
                          활성
                        </span>
                      ) : (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-sm text-rose-700">
                          비활성
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(t)}
                          className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-sm hover:bg-muted"
                          title="수정"
                        >
                          <Pencil className="h-3 w-3" />
                          수정
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleActive(t)}
                          className={
                            "h-7 inline-flex items-center gap-1 rounded-md border px-2 text-sm " +
                            (t.is_active
                              ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100")
                          }
                          title={t.is_active ? "비활성화" : "활성화"}
                        >
                          {t.is_active ? (
                            <>
                              <PowerOff className="h-3 w-3" />
                              비활성
                            </>
                          ) : (
                            <>
                              <Power className="h-3 w-3" />
                              활성
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => hardDelete(t)}
                          className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 text-sm text-destructive hover:bg-destructive/20"
                          title="영구 삭제 (복구 불가)"
                        >
                          <Trash2 className="h-3 w-3" />
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openNew && (
        <NewTenantDialog
          onClose={() => setOpenNew(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["admin-tenants"] });
            setOpenNew(false);
          }}
        />
      )}

      {editing && (
        <EditTenantDialog
          tenant={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["admin-tenants"] });
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

type ProfileFields = {
  name: string;
  domainsRaw: string;
  businessNo: string;
  representative: string;
  address: string;
  phone: string;
  fax: string;
  contactEmail: string;
  nameEn: string;
  representativeEn: string;
  addressEn: string;
  numberPrefix: string;
};

const EMPTY_PROFILE: ProfileFields = {
  name: "",
  domainsRaw: "",
  businessNo: "",
  representative: "",
  address: "",
  phone: "",
  fax: "",
  contactEmail: "",
  nameEn: "",
  representativeEn: "",
  addressEn: "",
  numberPrefix: "DD",
};

function profilePayload(p: ProfileFields) {
  const tokens = p.domainsRaw
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  for (const t of tokens) {
    if (!t.startsWith("@")) {
      throw new Error(
        `도메인은 @로 시작해야 합니다: ${t} (예: @acme.com)`,
      );
    }
  }
  const domains = tokens.map((t) => t.slice(1)).filter(Boolean);
  return {
    name: p.name.trim(),
    domains,
    business_no: p.businessNo.trim() || null,
    representative: p.representative.trim() || null,
    address: p.address.trim() || null,
    phone: p.phone.trim() || null,
    fax: p.fax.trim() || null,
    contact_email: p.contactEmail.trim() || null,
    name_en: p.nameEn.trim() || null,
    representative_en: p.representativeEn.trim() || null,
    address_en: p.addressEn.trim() || null,
    number_prefix: p.numberPrefix.trim() || "DD",
  };
}

function ProfileFormFields({
  value,
  onChange,
  slug,
  onSlugChange,
}: {
  value: ProfileFields;
  onChange: (next: ProfileFields) => void;
  /** 항상 표시 — 신규 모드에서는 입력, 수정 모드에서는 readonly. */
  slug: string;
  /** 미전달이면 readonly (수정 모드). */
  onSlugChange?: (v: string) => void;
}) {
  function set<K extends keyof ProfileFields>(k: K, v: ProfileFields[K]) {
    onChange({ ...value, [k]: v });
  }
  const slugReadOnly = !onSlugChange;
  return (
    <>
      <Section title="회사 정보 (한글)">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Slug (영문 식별자)" required>
            <input
              className={
                input +
                " font-mono " +
                (slugReadOnly ? "bg-muted text-muted-foreground" : "")
              }
              value={slug}
              onChange={(e) => onSlugChange?.(e.target.value)}
              placeholder="acme"
              required
              readOnly={slugReadOnly}
              title={slugReadOnly ? "Slug 는 생성 후 변경할 수 없습니다." : undefined}
            />
          </Field>
          <Field label="회사 이름" required>
            <input
              className={input}
              value={value.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Acme"
              required
            />
          </Field>
          <Field label="번호 prefix">
            <input
              className={input + " font-mono"}
              value={value.numberPrefix}
              onChange={(e) => set("numberPrefix", e.target.value)}
              placeholder="DD"
              maxLength={12}
            />
          </Field>
          <Field label="이메일 도메인 (콤마/공백 구분)" required>
            <input
              className={input}
              value={value.domainsRaw}
              onChange={(e) => set("domainsRaw", e.target.value)}
              placeholder="@acme.com, @acme.co.kr"
              required
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              각 도메인은 <span className="font-mono">@</span>로 시작해야 합니다
              (예: <span className="font-mono">@acme.com</span>). 서브도메인과
              구분하기 위함입니다.
            </p>
          </Field>
          <Field label="사업자번호">
            <input
              className={input}
              value={value.businessNo}
              onChange={(e) => set("businessNo", e.target.value)}
              placeholder="123-45-67890"
            />
          </Field>
          <Field label="대표자">
            <input
              className={input}
              value={value.representative}
              onChange={(e) => set("representative", e.target.value)}
            />
          </Field>
          <Field label="주소" colSpan={2}>
            <input
              className={input}
              value={value.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </Field>
          <Field label="전화">
            <input
              className={input}
              value={value.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
          </Field>
          <Field label="팩스">
            <input
              className={input}
              value={value.fax}
              onChange={(e) => set("fax", e.target.value)}
            />
          </Field>
          <Field label="대표 이메일" colSpan={2}>
            <input
              className={input}
              value={value.contactEmail}
              onChange={(e) => set("contactEmail", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section title="회사 정보 (영문)">
        <div className="grid grid-cols-2 gap-3">
          <Field label="영문 회사명" colSpan={2}>
            <input
              className={input}
              value={value.nameEn}
              onChange={(e) => set("nameEn", e.target.value)}
              placeholder="Acme Inc."
            />
          </Field>
          <Field label="영문 대표자">
            <input
              className={input}
              value={value.representativeEn}
              onChange={(e) => set("representativeEn", e.target.value)}
            />
          </Field>
          <Field label="영문 주소">
            <input
              className={input}
              value={value.addressEn}
              onChange={(e) => set("addressEn", e.target.value)}
            />
          </Field>
        </div>
      </Section>
    </>
  );
}

function NewTenantDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [profile, setProfile] = useState<ProfileFields>(EMPTY_PROFILE);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState("");
  const [adminName, setAdminName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      if (adminPassword !== adminPasswordConfirm) {
        throw new Error("비밀번호와 비밀번호 확인이 일치하지 않습니다.");
      }
      await api.post("/tenants", {
        slug: slug.trim(),
        ...profilePayload(profile),
        admin_email: adminEmail.trim().toLowerCase(),
        admin_password: adminPassword,
        admin_name: adminName.trim(),
      });
    },
    onSuccess: () => {
      // tenant + tenant admin 생성 완료 → super admin 로그아웃 후 로그인 화면.
      onCreated();
      clearToken();
      router.replace("/login");
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      setError(typeof d === "string" ? d : e?.message ?? "생성 실패");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    m.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-base font-bold">Tenant 추가</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-4 space-y-4 overflow-auto">
          <ProfileFormFields
            value={profile}
            onChange={setProfile}
            slug={slug}
            onSlugChange={setSlug}
          />

          <Section title="첫 관리자 (Tenant Admin)">
            <div className="grid grid-cols-2 gap-3">
              <Field label="이메일 (위 도메인 중 하나)" required>
                <input
                  className={input}
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@acme.com"
                  required
                />
              </Field>
              <Field label="이름">
                <input
                  className={input}
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                />
              </Field>
              <Field label="임시 비밀번호" required>
                <input
                  className={input + " font-mono"}
                  type="text"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                  minLength={4}
                />
              </Field>
              <Field label="비밀번호 확인" required>
                <input
                  className={
                    input +
                    " font-mono " +
                    (adminPasswordConfirm &&
                    adminPassword !== adminPasswordConfirm
                      ? "border-destructive"
                      : "")
                  }
                  type="text"
                  value={adminPasswordConfirm}
                  onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                  required
                  minLength={4}
                />
                {adminPasswordConfirm &&
                  adminPassword !== adminPasswordConfirm && (
                    <p className="mt-1 text-[11px] text-destructive">
                      비밀번호가 일치하지 않습니다.
                    </p>
                  )}
              </Field>
            </div>
          </Section>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            저장 시 자동으로 로그아웃되어 로그인 화면으로 이동합니다. 위 admin 계정으로 다시 로그인하세요.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={
                m.isPending ||
                !adminPassword ||
                adminPassword !== adminPasswordConfirm
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {m.isPending ? "생성 중..." : "생성 + 로그아웃"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EditTenantDialog({
  tenant,
  onClose,
  onSaved,
}: {
  tenant: Tenant;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [profile, setProfile] = useState<ProfileFields>({
    name: tenant.name,
    domainsRaw: tenant.domains.map((d) => "@" + d).join(", "),
    businessNo: tenant.business_no ?? "",
    representative: tenant.representative ?? "",
    address: tenant.address ?? "",
    phone: tenant.phone ?? "",
    fax: tenant.fax ?? "",
    contactEmail: tenant.contact_email ?? "",
    nameEn: tenant.name_en ?? "",
    representativeEn: tenant.representative_en ?? "",
    addressEn: tenant.address_en ?? "",
    numberPrefix: tenant.number_prefix,
  });
  // 추가 관리자 등록 (선택). 비우면 skip, email + 비번 채우면 POST /admin-users.
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState("");
  const [adminName, setAdminName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wantsAddAdmin =
    !!adminEmail.trim() || !!adminPassword || !!adminPasswordConfirm;

  const m = useMutation({
    mutationFn: async () => {
      if (wantsAddAdmin) {
        if (adminPassword !== adminPasswordConfirm) {
          throw new Error("비밀번호와 비밀번호 확인이 일치하지 않습니다.");
        }
        if (!adminEmail.trim() || !adminPassword) {
          throw new Error("관리자 추가는 이메일과 비밀번호가 모두 필요합니다.");
        }
      }
      await api.patch(`/tenants/${tenant.id}`, profilePayload(profile));
      if (wantsAddAdmin) {
        await api.post(`/tenants/${tenant.id}/admin-users`, {
          email: adminEmail.trim().toLowerCase(),
          password: adminPassword,
          name: adminName.trim(),
        });
      }
    },
    onSuccess: () => onSaved(),
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      setError(typeof d === "string" ? d : e?.message ?? "수정 실패");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    m.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-base font-bold">Tenant 수정</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-4 space-y-4 overflow-auto">
          <ProfileFormFields value={profile} onChange={setProfile} slug={tenant.slug} />

          <Section title="관리자 추가 / 비밀번호 갱신 (선택)">
            <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">
              미등록 이메일이면 신규 admin 생성, 이미 같은 tenant 에 등록된 사용자면 비밀번호만 갱신.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="이메일">
                <input
                  className={input}
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="신규 admin 또는 기존 admin 비번 재설정"
                />
              </Field>
              <Field label="이름">
                <input
                  className={input}
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                />
              </Field>
              <Field label="임시 비밀번호">
                <input
                  className={input + " font-mono"}
                  type="text"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  minLength={4}
                />
              </Field>
              <Field label="비밀번호 확인">
                <input
                  className={
                    input +
                    " font-mono " +
                    (adminPasswordConfirm &&
                    adminPassword !== adminPasswordConfirm
                      ? "border-destructive"
                      : "")
                  }
                  type="text"
                  value={adminPasswordConfirm}
                  onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                  minLength={4}
                />
                {adminPasswordConfirm &&
                  adminPassword !== adminPasswordConfirm && (
                    <p className="mt-1 text-[11px] text-destructive">
                      비밀번호가 일치하지 않습니다.
                    </p>
                  )}
              </Field>
            </div>
          </Section>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={
                m.isPending ||
                (wantsAddAdmin && adminPassword !== adminPasswordConfirm)
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {m.isPending ? "저장 중..." : "저장"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const input =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  required,
  colSpan = 1,
  children,
}: {
  label: string;
  required?: boolean;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div className={colSpan === 2 ? "col-span-2" : ""}>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
