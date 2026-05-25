"use client";

/**
 * 고객사 인터랙션(통화·미팅·이메일·기타) 슬라이드 드로어.
 *
 * - `/customers/{id}` 옆에서 회사 단위 활동 로그를 작성·수정·삭제.
 * - 작성자는 토큰의 mapped_developer_id 로 자동 채움 (백엔드 처리). 매핑이 없는
 *   admin 은 NULL → "관리자" 로 표시.
 * - 첨부는 인터랙션 생성 후 별도 POST 로 추가하므로 신규 작성 흐름은
 *   "POST 인터랙션 → 각 파일별 POST attachments" 두 단계.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  Link2,
  Mail,
  MessageSquare,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";

type InteractionType = "CALL" | "MEETING" | "EMAIL" | "OTHER";

type Attachment = {
  id: string;
  interaction_id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

type Interaction = {
  id: string;
  customer_id: string;
  type: InteractionType;
  occurred_at: string;        // ISO datetime
  author_id: string | null;
  author_name: string | null;
  title: string;
  body: string | null;
  participants: string | null;
  follow_up_at: string | null; // ISO date
  attachments: Attachment[];
  created_at: string;
  updated_at: string;
};

type FormState = {
  type: InteractionType;
  occurred_at: string;       // datetime-local 입력값 (yyyy-MM-ddTHH:mm)
  title: string;
  body: string;
  participants: string;
  follow_up_at: string;      // yyyy-MM-dd
};

const TYPE_LABEL: Record<InteractionType, string> = {
  CALL: "통화",
  MEETING: "미팅",
  EMAIL: "이메일",
  OTHER: "기타",
};

const TYPE_ICON: Record<InteractionType, React.ReactNode> = {
  CALL: <Phone className="h-3 w-3" />,
  MEETING: <Users className="h-3 w-3" />,
  EMAIL: <Mail className="h-3 w-3" />,
  OTHER: <MessageSquare className="h-3 w-3" />,
};

const TYPE_COLOR: Record<InteractionType, string> = {
  CALL: "bg-blue-100 text-blue-700",
  MEETING: "bg-purple-100 text-purple-700",
  EMAIL: "bg-amber-100 text-amber-700",
  OTHER: "bg-slate-100 text-slate-700",
};

function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const BLANK_FORM: FormState = {
  type: "MEETING",
  occurred_at: nowLocal(),
  title: "",
  body: "",
  participants: "",
  follow_up_at: "",
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bytes(n: number | null): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function CustomerActivityDrawer({
  customerId,
  customerName,
  ownerName,
  myDeveloperId,
  canManage,
  onClose,
}: {
  customerId: string | null;
  customerName: string | null;
  ownerName?: string | null;
  myDeveloperId: string | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [filterType, setFilterType] = useState<"" | InteractionType>("");
  const [mineOnly, setMineOnly] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      await dialog.alert("클립보드 복사에 실패했습니다.", { title: "오류" });
    }
  };

  const { data: interactions = [], isLoading } = useQuery<Interaction[]>({
    queryKey: [
      "customer-interactions",
      customerId,
      { type: filterType, mine: mineOnly },
    ],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filterType) params.type = filterType;
      if (mineOnly && myDeveloperId) params.author_id = "me";
      return (
        await api.get(`/customers/${customerId}/interactions`, { params })
      ).data;
    },
    enabled: !!customerId,
  });

  // ESC → close
  useEffect(() => {
    if (!customerId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [customerId, onClose]);

  const createM = useMutation({
    mutationFn: async () => {
      if (!customerId) return null;
      const payload = formToPayload(form);
      const created = (
        await api.post(`/customers/${customerId}/interactions`, payload)
      ).data as Interaction;
      // 첨부 파일은 인터랙션 생성 후 별도 POST.
      for (const f of pendingFiles) {
        const fd = new FormData();
        fd.append("file", f);
        await api.post(
          `/customer-interactions/${created.id}/attachments`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer-interactions", customerId] });
      setForm(BLANK_FORM);
      setPendingFiles([]);
      setShowForm(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editingId) return null;
      return (
        await api.patch(
          `/customer-interactions/${editingId}`,
          formToPayload(form),
        )
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer-interactions", customerId] });
      setEditingId(null);
      setForm(BLANK_FORM);
      setShowForm(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/customer-interactions/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["customer-interactions", customerId],
      }),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  function startCreate() {
    setEditingId(null);
    setForm({ ...BLANK_FORM, occurred_at: nowLocal() });
    setPendingFiles([]);
    setShowForm(true);
  }

  function startEdit(i: Interaction) {
    setEditingId(i.id);
    setForm({
      type: i.type,
      occurred_at: i.occurred_at.slice(0, 16),
      title: i.title,
      body: i.body ?? "",
      participants: i.participants ?? "",
      follow_up_at: i.follow_up_at ?? "",
    });
    setPendingFiles([]);
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(BLANK_FORM);
    setPendingFiles([]);
  }

  async function handleDelete(i: Interaction) {
    const ok = await dialog.confirm("이 활동을 삭제하시겠습니까?", {
      title: "삭제 확인",
      destructive: true,
    });
    if (ok) deleteM.mutate(i.id);
  }

  const formValid = form.title.trim().length > 0 && !!form.occurred_at;

  if (!customerId) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="h-full w-full max-w-[640px] bg-card border-l border-border shadow-xl flex flex-col">
        <header className="flex items-start justify-between border-b border-border px-4 py-3 shrink-0">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">활동 로그</div>
            <h2 className="text-sm font-semibold truncate">
              {customerName ?? "—"}
            </h2>
            {ownerName && (
              <div className="text-xs text-muted-foreground mt-0.5">
                담당자: {ownerName}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={copyShareLink}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 h-7 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="링크 복사"
              title="현재 활동 로그 URL을 클립보드에 복사"
            >
              {linkCopied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="text-emerald-600">복사됨</span>
                </>
              ) : (
                <>
                  <Link2 className="h-3.5 w-3.5" />
                  <span>링크 복사</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* toolbar */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 shrink-0 flex-wrap">
          {canManage && !showForm && (
            <button
              type="button"
              onClick={startCreate}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-3.5 w-3.5" />
              활동 추가
            </button>
          )}
          <select
            value={filterType}
            onChange={(e) =>
              setFilterType(e.target.value as "" | InteractionType)
            }
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">전체</option>
            <option value="CALL">통화</option>
            <option value="MEETING">미팅</option>
            <option value="EMAIL">이메일</option>
            <option value="OTHER">기타</option>
          </select>
          <label
            className={
              "h-8 inline-flex items-center gap-1.5 rounded-md border border-border px-2 text-xs select-none " +
              (myDeveloperId
                ? "cursor-pointer hover:bg-muted"
                : "opacity-50 cursor-not-allowed")
            }
            title={
              myDeveloperId
                ? "내가 작성한 활동만"
                : "로그인 계정에 직원 매핑이 없습니다"
            }
          >
            <input
              type="checkbox"
              disabled={!myDeveloperId}
              checked={mineOnly && !!myDeveloperId}
              onChange={(e) => setMineOnly(e.target.checked)}
              className="h-3 w-3"
            />
            내 활동만
          </label>
        </div>

        {/* form */}
        {showForm && (
          <InteractionForm
            form={form}
            setForm={setForm}
            pendingFiles={pendingFiles}
            setPendingFiles={setPendingFiles}
            editingExistingAttachments={
              editingId
                ? interactions.find((i) => i.id === editingId)?.attachments ?? []
                : []
            }
            editingId={editingId}
            onCancel={cancelForm}
            onSave={() =>
              editingId ? updateM.mutate() : createM.mutate()
            }
            saving={createM.isPending || updateM.isPending}
            valid={formValid}
            customerId={customerId}
          />
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {isLoading ? (
            <div className="text-xs text-muted-foreground">불러오는 중…</div>
          ) : interactions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
              {showForm
                ? "위 양식에 활동 내용을 작성하세요."
                : "기록된 활동이 없습니다."}
            </div>
          ) : (
            interactions.map((i) => (
              <InteractionItem
                key={i.id}
                interaction={i}
                canModify={
                  canManage ||
                  (!!myDeveloperId && i.author_id === myDeveloperId)
                }
                onEdit={() => startEdit(i)}
                onDelete={() => handleDelete(i)}
              />
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 작성·편집 폼
// ---------------------------------------------------------------------------

type ContactBrief = {
  id: string;
  name: string;
  title: string | null;
  customer_id?: string | null;
  company_name?: string | null;
};

type DeveloperBrief = {
  id: string;
  name: string;
  tag: string | null;
  email: string | null;
  employment_type: string;
};

// 검색·선택 풀에 들어가는 통일된 항목.
type Pickable = {
  key: string; // dedup key — `<source>:<id>`
  name: string;
  title?: string | null;
  company?: string | null; // 표시용 — 직원이면 "직원" 등.
  source: "this_company" | "other_contact" | "developer";
};

const SOURCE_BADGE: Record<Pickable["source"], string> = {
  this_company: "이 회사",
  other_contact: "주소록",
  developer: "직원",
};

const SOURCE_BADGE_COLOR: Record<Pickable["source"], string> = {
  this_company: "bg-primary/10 text-primary",
  other_contact: "bg-amber-100 text-amber-700",
  developer: "bg-emerald-100 text-emerald-700",
};

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}

function InteractionForm({
  form,
  setForm,
  pendingFiles,
  setPendingFiles,
  editingExistingAttachments,
  editingId,
  onCancel,
  onSave,
  saving,
  valid,
  customerId,
}: {
  form: FormState;
  setForm: (f: FormState | ((prev: FormState) => FormState)) => void;
  pendingFiles: File[];
  setPendingFiles: (f: File[] | ((prev: File[]) => File[])) => void;
  editingExistingAttachments: Attachment[];
  editingId: string | null;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  valid: boolean;
  customerId: string;
}) {
  const qc = useQueryClient();
  // 폰트 한 단계 ↑ — text-xs(12px) → text-sm(14px). 입력 패딩도 함께 키움.
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  // 편집 모드에서 신규 파일 즉시 업로드 (기존 인터랙션이 이미 존재하므로).
  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      if (!editingId) return;
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        await api.post(
          `/customer-interactions/${editingId}/attachments`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
      }
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["customer-interactions", customerId] }),
  });

  const deleteAttM = useMutation({
    mutationFn: async (attId: string) =>
      api.delete(`/customer-interaction-attachments/${attId}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["customer-interactions", customerId] }),
  });

  return (
    <div className="border-b border-border bg-muted/30 px-4 py-3 space-y-3 shrink-0">
      <div className="grid grid-cols-3 gap-3">
        <FormField label="활동 유형">
          <select
            value={form.type}
            onChange={(e) =>
              setForm((p) => ({ ...p, type: e.target.value as InteractionType }))
            }
            className={input}
          >
            <option value="MEETING">미팅</option>
            <option value="CALL">통화</option>
            <option value="EMAIL">이메일</option>
            <option value="OTHER">기타</option>
          </select>
        </FormField>
        <FormField label="활동 일시">
          <input
            type="datetime-local"
            value={form.occurred_at}
            onChange={(e) =>
              setForm((p) => ({ ...p, occurred_at: e.target.value }))
            }
            className={input}
          />
        </FormField>
        <FormField label="다음 미팅일 (후속)">
          <input
            type="date"
            value={form.follow_up_at}
            onChange={(e) =>
              setForm((p) => ({ ...p, follow_up_at: e.target.value }))
            }
            className={input}
          />
        </FormField>
      </div>
      <FormField label="제목" required>
        <input
          type="text"
          value={form.title}
          onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          className={input}
        />
      </FormField>
      <FormField label="동석자">
        <ParticipantsPicker
          customerId={customerId}
          value={form.participants}
          onChange={(v) => setForm((p) => ({ ...p, participants: v }))}
          input={input}
        />
      </FormField>
      <FormField label="활동 내용">
        <textarea
          value={form.body}
          onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
          rows={5}
          className={input + " resize-y"}
        />
      </FormField>

      {/* 편집 모드 — 기존 첨부 + 즉시 업로드 */}
      {editingId && (
        <div className="space-y-1">
          {editingExistingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {editingExistingAttachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px]"
                >
                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                  {a.file_name}
                  <button
                    type="button"
                    onClick={() => deleteAttM.mutate(a.id)}
                    className="text-muted-foreground hover:text-destructive ml-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <FileInput
            multiple
            onPick={(files) => uploadM.mutate(files)}
            label="첨부 추가"
            disabled={uploadM.isPending}
          />
        </div>
      )}

      {/* 신규 모드 — 저장 시 일괄 업로드 */}
      {!editingId && (
        <div className="space-y-1">
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pendingFiles.map((f, idx) => (
                <span
                  key={`${f.name}-${idx}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px]"
                >
                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                  {f.name}
                  <button
                    type="button"
                    onClick={() =>
                      setPendingFiles((p) => p.filter((_, i) => i !== idx))
                    }
                    className="text-muted-foreground hover:text-destructive ml-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <FileInput
            multiple
            onPick={(files) =>
              setPendingFiles((p) => [...p, ...files])
            }
            label="첨부 선택"
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-md border border-border px-3 text-xs"
        >
          취소
        </button>
        <button
          type="button"
          disabled={!valid || saving}
          onClick={onSave}
          className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 동석자 multi-select — 절충 모델
//
//   ┌─ 선택됨 (chip + ✕ 제거) ────────────────────┐
//   │ [김XX 부장 ✕] [박YY 대리 @협력사A ✕] ...   │
//   ├─ 이 회사 담당자 (1-click toggle) ────────── │
//   │ [김XX 부장] [이XX 선임] [최XX 차장] ...     │
//   ├─ 다른 회사 / 협력사 검색 ──────────────────  │
//   │ [이름·직함·회사로 검색 ▼ autocomplete]      │
//   │ 검색 결과 없으면 "✚ '입력값' 직접 추가"      │
//   └────────────────────────────────────────────  ┘
//
// 직렬화: 모든 선택 (toggle / 검색 add / 직접 add) 의 name 들이 콤마로 join 되어
// 기존 `participants` (string) 에 그대로 저장. backend 변경 없음.
// 편집 시 token 들을 다시 parse — 전체 주소록과 매칭해 출처 (이 회사 / 외부 /
// off-roster) 표시. 어떤 출처든 ✕ 클릭으로 제거.
// ---------------------------------------------------------------------------
function ParticipantsPicker({
  customerId,
  value,
  onChange,
  input,
}: {
  customerId: string;
  value: string;
  onChange: (v: string) => void;
  input: string;
}) {
  // 이 회사 담당자 — toggle chip 영역.
  const { data: thisCompany = [] } = useQuery<ContactBrief[]>({
    queryKey: ["customer-contacts", "by-customer", customerId],
    queryFn: async () =>
      (
        await api.get("/customer-contacts", {
          params: { customer_id: customerId },
        })
      ).data,
    enabled: !!customerId,
  });
  // 전체 주소록 — 검색 dropdown 데이터 소스. 고객사 + 협력사 모두 포함 (kind 미지정).
  const { data: allContacts = [] } = useQuery<ContactBrief[]>({
    queryKey: ["customer-contacts", "all"],
    queryFn: async () => (await api.get("/customer-contacts")).data,
  });
  // 직원 directory — 자사 직원도 동석자가 될 수 있어 검색 풀에 포함.
  const { data: developers = [] } = useQuery<DeveloperBrief[]>({
    queryKey: ["developers", "directory"],
    queryFn: async () => (await api.get("/developers/directory")).data,
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  // value → token list (콤마/슬래시 분리). 순서 유지.
  const tokens = useMemo(
    () =>
      value
        .split(/[,/]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [value],
  );

  const thisCompanyIds = useMemo(
    () => new Set(thisCompany.map((c) => c.id)),
    [thisCompany],
  );

  // 검색·표시용 통합 풀 — 이 회사 담당자 + 다른 주소록 contacts + 직원 directory.
  // 같은 이름이 여러 source 에 있을 수 있으나 검색 시 모두 노출 (사용자가 원하는 것 선택).
  const pool = useMemo<Pickable[]>(() => {
    const out: Pickable[] = [];
    for (const c of allContacts) {
      const isThis = !!c.id && thisCompanyIds.has(c.id);
      out.push({
        key: `contact:${c.id}`,
        name: c.name,
        title: c.title,
        company: isThis ? null : c.company_name ?? null,
        source: isThis ? "this_company" : "other_contact",
      });
    }
    for (const d of developers) {
      out.push({
        key: `dev:${d.id}`,
        name: d.name,
        title: d.tag,
        company: null,
        source: "developer",
      });
    }
    return out;
  }, [allContacts, developers, thisCompanyIds]);

  // 이름 → 첫 번째 매칭 Pickable (chip 의 직함/회사 메타 표시용).
  // 우선순위: this_company > other_contact > developer.
  const metaByName = useMemo(() => {
    const m = new Map<string, Pickable>();
    const order = { this_company: 0, other_contact: 1, developer: 2 } as const;
    for (const p of pool) {
      const cur = m.get(p.name);
      if (!cur || order[p.source] < order[cur.source]) m.set(p.name, p);
    }
    return m;
  }, [pool]);

  function setTokens(nextTokens: string[]) {
    onChange(nextTokens.join(", "));
  }

  function addName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (tokens.includes(trimmed)) return;
    setTokens([...tokens, trimmed]);
  }

  function removeName(name: string) {
    setTokens(tokens.filter((n) => n !== name));
  }

  function toggleThisCompany(c: ContactBrief) {
    if (tokens.includes(c.name)) {
      removeName(c.name);
    } else {
      addName(c.name);
    }
  }

  // 검색 결과 — 이미 선택됐거나 이 회사 quick-pick 영역에 있는 항목은 제외.
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return pool
      .filter((p) => !tokens.includes(p.name)) // 이미 선택됨 제외
      .filter((p) => p.source !== "this_company") // 이 회사 chip 영역과 중복 제외
      .filter((p) => {
        const hay = [p.name, p.title ?? "", p.company ?? "", SOURCE_BADGE[p.source]]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 12);
  }, [searchQuery, pool, tokens]);

  const trimmedQuery = searchQuery.trim();
  const canAddCustom =
    trimmedQuery.length > 0 &&
    !tokens.includes(trimmedQuery) &&
    !filtered.some((c) => c.name === trimmedQuery);

  function chipMeta(name: string): { title?: string; company?: string; source?: Pickable["source"] } {
    const p = metaByName.get(name);
    if (!p) return {};
    return {
      title: p.title ?? undefined,
      company: p.company ?? undefined,
      source: p.source,
    };
  }

  return (
    <div className="space-y-2">
      {/* ── 1. 선택된 동석자 chips (출처 무관, ✕ 로 제거) ── */}
      {tokens.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tokens.map((name) => {
            const meta = chipMeta(name);
            const sourceLabel =
              meta.source === "developer"
                ? "직원"
                : meta.source === "other_contact" && meta.company
                  ? meta.company
                  : meta.source === "other_contact"
                    ? "주소록"
                    : null;
            return (
              <span
                key={name}
                className="h-7 inline-flex items-center gap-1 rounded-full border border-primary bg-primary text-primary-foreground px-2.5 text-xs"
              >
                <span>{name}</span>
                {meta.title && (
                  <span className="opacity-80">· {meta.title}</span>
                )}
                {sourceLabel && (
                  <span className="opacity-80">@ {sourceLabel}</span>
                )}
                <button
                  type="button"
                  onClick={() => removeName(name)}
                  className="ml-0.5 rounded-full hover:bg-white/20 p-0.5"
                  aria-label={`${name} 제거`}
                  title="제거"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* ── 2. 이 회사 담당자 (1-click toggle) ── */}
      {thisCompany.length > 0 && (
        <div>
          <div className="text-[11px] text-muted-foreground mb-1">
            이 회사 담당자
          </div>
          <div className="flex flex-wrap gap-1.5">
            {thisCompany.map((c) => {
              const sel = tokens.includes(c.name);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleThisCompany(c)}
                  className={
                    "h-7 inline-flex items-center gap-1 rounded-full border px-2.5 text-xs transition-colors " +
                    (sel
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background hover:bg-muted")
                  }
                >
                  {c.name}
                  {c.title && (
                    <span
                      className={
                        sel ? "text-primary/80" : "text-muted-foreground"
                      }
                    >
                      · {c.title}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 3. 검색 — 다른 고객사·협력사·자사 직원 + 직접 입력 ── */}
      <div>
        <div className="text-[11px] text-muted-foreground mb-1">
          다른 고객사·협력사·자사 직원에서 추가
        </div>
        <div className="relative">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => {
              setTimeout(() => setShowDropdown(false), 150);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (filtered.length > 0) {
                  addName(filtered[0].name);
                  setSearchQuery("");
                } else if (canAddCustom) {
                  addName(trimmedQuery);
                  setSearchQuery("");
                }
              } else if (e.key === "Escape") {
                setShowDropdown(false);
              }
            }}
            placeholder="이름·직함·회사로 검색 (Enter 로 추가)"
            className={input}
          />
          {showDropdown && (filtered.length > 0 || canAddCustom) && (
            <div className="absolute top-full left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-popover shadow-lg">
              {filtered.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addName(p.name);
                    setSearchQuery("");
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
                >
                  <span className="font-medium">{p.name}</span>
                  {p.title && (
                    <span className="text-xs text-muted-foreground">
                      {p.title}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    {p.company && (
                      <span className="text-xs text-muted-foreground">
                        @ {p.company}
                      </span>
                    )}
                    <span
                      className={
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium " +
                        SOURCE_BADGE_COLOR[p.source]
                      }
                    >
                      {SOURCE_BADGE[p.source]}
                    </span>
                  </span>
                </button>
              ))}
              {canAddCustom && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addName(trimmedQuery);
                    setSearchQuery("");
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left border-t border-border text-muted-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>
                    "<span className="font-medium text-foreground">{trimmedQuery}</span>" 직접 추가 (주소록·직원에 없음)
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileInput({
  multiple,
  onPick,
  label,
  disabled,
}: {
  multiple?: boolean;
  onPick: (files: File[]) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        "h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] " +
        (disabled ? "opacity-50" : "cursor-pointer hover:bg-muted")
      }
    >
      <Paperclip className="h-3 w-3" />
      {label}
      <input
        type="file"
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          if (list.length > 0) onPick(list);
          e.target.value = "";
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// 항목 카드
// ---------------------------------------------------------------------------

function InteractionItem({
  interaction,
  canModify,
  onEdit,
  onDelete,
}: {
  interaction: Interaction;
  canModify: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const i = interaction;
  // 후속 일자가 오늘 이전이면 강조 (지났음).
  const followOverdue = useMemo(() => {
    if (!i.follow_up_at) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const f = new Date(i.follow_up_at);
    return f.getTime() <= today.getTime();
  }, [i.follow_up_at]);

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <span
          className={
            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium " +
            TYPE_COLOR[i.type]
          }
        >
          {TYPE_ICON[i.type]}
          {TYPE_LABEL[i.type]}
        </span>
        <div className="text-xs text-muted-foreground mt-0.5">
          {formatDateTime(i.occurred_at)}
          {i.author_name ? ` · ${i.author_name}` : " · 관리자"}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {canModify && (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="text-muted-foreground hover:text-foreground"
                title="수정"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="text-muted-foreground hover:text-destructive"
                title="삭제"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-1.5 text-base font-semibold">{i.title}</div>
      {i.participants && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">동석자:</span> {i.participants}
        </div>
      )}
      {i.body && (
        <div className="mt-1.5 whitespace-pre-wrap text-sm text-foreground/90">
          {i.body}
        </div>
      )}
      {i.follow_up_at && (
        <div
          className={
            "mt-1.5 inline-flex items-center gap-1 text-xs " +
            (followOverdue ? "text-amber-700 font-medium" : "text-muted-foreground")
          }
        >
          <Calendar className="h-3.5 w-3.5" />
          <span className="font-medium">다음 미팅일:</span> {i.follow_up_at}
          {followOverdue ? " (지났음)" : ""}
        </div>
      )}
      {i.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {i.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  async function handleDownload() {
    const res = await api.get(
      `/customer-interaction-attachments/${attachment.id}/download`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = attachment.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px]">
      <Paperclip className="h-3 w-3 text-muted-foreground" />
      <button
        type="button"
        onClick={handleDownload}
        className="truncate max-w-[200px] hover:underline"
        title="다운로드"
      >
        {attachment.file_name}
      </button>
      {attachment.size != null && (
        <span className="text-muted-foreground">
          ({bytes(attachment.size)})
        </span>
      )}
      <AttachmentPreviewButton
        filename={attachment.file_name}
        mime={attachment.mime_type ?? null}
        downloadPath={`/customer-interaction-attachments/${attachment.id}/download`}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formToPayload(f: FormState): Record<string, unknown> {
  // datetime-local → ISO 8601 (그대로 넘기면 백엔드가 timezone-aware 로 파싱).
  // datetime-local 은 timezone 정보가 없으므로 브라우저 로컬을 가정하고
  // Date 객체로 한 번 변환해 ISO 로 직렬화.
  const dt = new Date(f.occurred_at);
  return {
    type: f.type,
    occurred_at: dt.toISOString(),
    title: f.title.trim(),
    body: f.body.trim() || null,
    participants: f.participants.trim() || null,
    follow_up_at: f.follow_up_at || null,
  };
}
