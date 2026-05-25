"use client";

/**
 * Contacts — 주소록 4-tab (직원 · 프리랜서 · 고객 · 협력사).
 *
 * 데이터 소스:
 * - 직원 / 프리랜서 탭 — `/developers?employment_type=…&status_filter=ACTIVE`.
 *   Settings > 고급 > 디렉터리 제외 리스트 + 퇴사자(INACTIVE)는 서버에서 자동 숨김.
 *   (`include_hidden` 을 넘기지 않음 → 기본 false → 제외 리스트 적용.)
 * - 고객 / 협력사 탭 — `/customer-contacts?kind=CUSTOMER|PARTNER`.
 *   `customer_contacts` 테이블 한 곳에서 kind 로 분리 저장. 회사명은
 *   `/customers` (Accounts) 목록에서 `<select>` 드롭다운으로 선택 — 등록되지
 *   않은 회사는 이전 값이면 "(미등록)" 옵션으로 유지되지만, 새로 입력은 불가.
 *
 * UI 구성:
 * - 상단 탭 + 검색 입력(우측) + "주소 추가" 버튼(고객/협력사 탭에서만).
 * - 카드 그리드(sm:3 / lg:4 / xl:6)로 이름·회사·직함·연락처를 요약.
 * - 고객/협력사 카드는 클릭 시 수정 다이얼로그 오픈 — kind 는 열려 있는
 *   탭에 따라 payload 에 자동 주입되므로 사용자는 신경 쓰지 않는다.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileDown,
  GitBranch,
  Mail,
  Phone,
  Plus,
  Search,
  Smartphone,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { sortDevelopersKo } from "@/lib/sort-developers";
import { downloadContactsPDF } from "@/lib/contacts-export";
import { tenureFromHireDate } from "@/lib/format";
import { birthDateFromRRN, isBirthdayThisMonth } from "@/lib/resident";
import { OrgChartDialog } from "@/components/developers/OrgChartDialog";

type DeveloperContact = {
  id: string;
  name: string;
  tag?: string | null;
  title?: string | null;
  phone?: string | null;
  company_email?: string | null;
  personal_email?: string | null;
  employment_type?: string | null;
  status?: string | null;
  // 카드에 추가 표시 — 입사일/근무기간/직위/직책/이번 달 생일 강조용.
  hire_date?: string | null;
  resident_number?: string | null;
  rank_id?: string | null;
  position_id?: string | null;
};

type ContactKind = "CUSTOMER" | "PARTNER";

type CustomerContact = {
  id: string;
  kind: ContactKind;
  name: string;
  customer_id?: string | null;
  // 백엔드가 customer.name 에서 derive 해서 채워주는 표시 전용 필드 (입력 X).
  company_name?: string | null;
  title?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  memo?: string | null;
};

type CustomerAccount = { id: string; name: string };

type Tab = "FULL_TIME" | "FREELANCER" | "CUSTOMER" | "PARTNER";

export default function ContactsPage() {
  const [tab, setTab] = useState<Tab>("FULL_TIME");
  const [q, setQ] = useState("");
  // "주소 추가" 는 고객 탭에서만 노출. 버튼을 상단 검색 옆에 두기 위해 상태를
  // 부모로 끌어올리고 CustomerContactsPanel 에는 controlled prop 으로 전달.
  const [addOpen, setAddOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  // 고객/협력사 — 회사별 그룹 보기 (기본 ON). OFF 시 평면 그리드(컬러 사이드바
  // 만 유지) 로 회사 무관 스캔에 유리.
  const [grouped, setGrouped] = useState(true);
  const [orgChartOpen, setOrgChartOpen] = useState(false);
  const qc = useQueryClient();
  const dialog = useDialog();

  // PDF 다운로드 — 패널과 동일한 react-query 캐시에서 데이터를 읽고 검색어 q 로
  // 필터링한 뒤 contacts-export 의 회사별 그룹핑 빌더로 내려보낸다. 버튼은 패널
  // 내부가 아니라 상단 toolbar (검색 + 주소 추가 옆) 에 두기 위해 부모에서 처리.
  const handleDownloadPDF = async () => {
    if (tab !== "CUSTOMER" && tab !== "PARTNER") return;
    const cached =
      qc.getQueryData<CustomerContact[]>(["contacts", "external", tab]) ?? [];
    const lc = q.trim().toLowerCase();
    const rows = lc
      ? cached.filter((c) => {
          const bag = [
            c.name,
            c.company_name,
            c.title,
            c.phone,
            c.mobile,
            c.email,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return bag.includes(lc);
        })
      : cached;
    if (rows.length === 0) {
      await dialog.alert("내보낼 주소가 없습니다.", { title: "PDF 다운로드" });
      return;
    }
    setPdfBusy(true);
    try {
      await downloadContactsPDF({ kind: tab, rows });
    } catch (e: any) {
      await dialog.alert(e?.message ?? "PDF 생성 실패", { title: "오류" });
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <>
      <DashboardHeader title="주소록" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <TabBar className="flex-1 min-w-0">
            <TabItem active={tab === "FULL_TIME"} onClick={() => setTab("FULL_TIME")}>
              직원
            </TabItem>
            <TabItem active={tab === "FREELANCER"} onClick={() => setTab("FREELANCER")}>
              프리랜서
            </TabItem>
            <TabItem active={tab === "CUSTOMER"} onClick={() => setTab("CUSTOMER")}>
              고객
            </TabItem>
            <TabItem active={tab === "PARTNER"} onClick={() => setTab("PARTNER")}>
              협력사
            </TabItem>
          </TabBar>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="이름·회사·연락처 검색"
                className="h-9 w-72 rounded-md border border-input bg-background pl-8 pr-3 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() => setOrgChartOpen(true)}
              className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <GitBranch className="h-4 w-4" />
              결재선
            </button>
            {(tab === "CUSTOMER" || tab === "PARTNER") && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    checked={grouped}
                    onChange={(e) => setGrouped(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  회사별 그룹
                </label>
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
                >
                  <Plus className="h-4 w-4" />
                  주소 추가
                </button>
                <button
                  type="button"
                  onClick={handleDownloadPDF}
                  disabled={pdfBusy}
                  className="h-9 inline-flex items-center gap-1 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <FileDown className="h-4 w-4" />
                  {pdfBusy ? "생성 중..." : "PDF"}
                </button>
              </>
            )}
          </div>
        </div>

        {tab === "CUSTOMER" || tab === "PARTNER" ? (
          <CustomerContactsPanel
            key={tab}
            kind={tab}
            q={q}
            addOpen={addOpen}
            setAddOpen={setAddOpen}
            grouped={grouped}
          />
        ) : (
          <DeveloperContactsPanel q={q} employmentType={tab} />
        )}
      </div>

      <OrgChartDialog
        open={orgChartOpen}
        onClose={() => setOrgChartOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 직원 / 프리랜서 탭
// ---------------------------------------------------------------------------

function DeveloperContactsPanel({
  q,
  employmentType,
}: {
  q: string;
  employmentType: "FULL_TIME" | "FREELANCER";
}) {
  const { data = [], isLoading } = useQuery<DeveloperContact[]>({
    queryKey: ["contacts", "developers", employmentType],
    queryFn: async () =>
      (
        await api.get("/developers", {
          // status_filter=ACTIVE 로 퇴사자 제외.
          // include_hidden=false (기본) 로 Settings > 제외 리스트 적용.
          params: { employment_type: employmentType, status_filter: "ACTIVE" },
        })
      ).data,
  });

  // 직위·직책 마스터 — 카드 헤더의 ID → 이름 lookup.
  const { data: ranksList = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["job-ranks-active"],
    queryFn: async () => (await api.get("/job-ranks")).data,
    staleTime: 5 * 60_000,
  });
  const { data: positionsList = [] } = useQuery<
    { id: string; name: string }[]
  >({
    queryKey: ["job-positions-active"],
    queryFn: async () => (await api.get("/job-positions")).data,
    staleTime: 5 * 60_000,
  });
  const rankMap = useMemo(
    () => new Map(ranksList.map((r) => [r.id, r.name])),
    [ranksList],
  );
  const positionMap = useMemo(
    () => new Map(positionsList.map((p) => [p.id, p.name])),
    [positionsList],
  );

  // 서버에서 employment_type 필터링을 하지만, 캐시된 응답이나 백엔드 구버전
  // 대응을 위해 클라이언트에서도 한 번 더 확인 후 검색어 기준 필터링.
  const filtered = useMemo(() => {
    const lc = q.trim().toLowerCase();
    const base = data.filter((d) =>
      employmentType ? d.employment_type === employmentType : true,
    );
    const searched = lc
      ? base.filter((d) => {
          const bag = [
            d.name,
            d.title,
            d.phone,
            d.company_email,
            d.personal_email,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return bag.includes(lc);
        })
      : base;
    return sortDevelopersKo(searched);
  }, [data, q, employmentType]);

  if (isLoading) return <div className="text-sm text-muted-foreground">불러오는 중…</div>;
  if (filtered.length === 0)
    return <EmptyCard>표시할 임직원이 없습니다.</EmptyCard>;

  const birthdayCount = filtered.filter((d) =>
    isBirthdayThisMonth(birthDateFromRRN(d.resident_number)),
  ).length;

  return (
    <div className="flex flex-col gap-3">
      {/* 범례 — 카드 배경색 의미 안내. */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded border border-amber-200 bg-amber-50" />
          이번 달 생일자
          {birthdayCount > 0 && (
            <span className="text-amber-700 font-medium">({birthdayCount}명)</span>
          )}
        </span>
      </div>

      {/* 카드 폭 250px 고정 — 화면 크기와 무관하게 균일한 명함 크기.
          auto-fill 로 viewport 폭에 맞춰 한 행에 들어가는 만큼 자동 배치. */}
      <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-3">
        {filtered.map((d) => {
          const rank = d.rank_id ? rankMap.get(d.rank_id) ?? null : null;
          const position = d.position_id
            ? positionMap.get(d.position_id) ?? null
            : null;
          const rankPosition =
            rank && position ? `${rank} / ${position}` : rank ?? position;
          const tenure = tenureFromHireDate(d.hire_date);
          const isBirthday = isBirthdayThisMonth(birthDateFromRRN(d.resident_number));
          return (
            <div
              key={d.id}
              className={
                "rounded-lg border p-4 flex flex-col gap-1 " +
                (isBirthday
                  ? "border-amber-200 bg-amber-50"
                  : "border-border bg-card")
              }
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm font-semibold">{d.name}</span>
                {rankPosition && (
                  <span className="text-xs text-muted-foreground">
                    {rankPosition}
                  </span>
                )}
                {d.tag && (
                  <span className="text-xs text-muted-foreground">· {d.tag}</span>
                )}
              </div>
              {d.phone && (
                <div className="text-xs flex items-center gap-1.5 mt-1">
                  <Phone className="h-3 w-3 text-muted-foreground" />
                  <a href={`tel:${d.phone}`} className="hover:underline">
                    {d.phone}
                  </a>
                </div>
              )}
              {(d.company_email || d.personal_email) && (
                <div className="text-xs flex items-center gap-1.5">
                  <Mail className="h-3 w-3 text-muted-foreground" />
                  <a
                    href={`mailto:${d.company_email || d.personal_email}`}
                    className="hover:underline truncate"
                  >
                    {d.company_email || d.personal_email}
                  </a>
                </div>
              )}
              {(d.hire_date || tenure) && (
                <div className="text-xs text-muted-foreground mt-1">
                  {d.hire_date && (
                    <span>입사 {String(d.hire_date).slice(0, 10)}</span>
                  )}
                  {tenure && (
                    <span className="ml-1.5">· 근무기간 {tenure}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 고객 탭 — /customer-contacts CRUD
// ---------------------------------------------------------------------------

type CustomerForm = {
  name: string;
  customer_id: string | null;
  title: string;
  phone: string;
  mobile: string;
  email: string;
  memo: string;
};

const BLANK_FORM: CustomerForm = {
  name: "",
  customer_id: null,
  title: "",
  phone: "",
  mobile: "",
  email: "",
  memo: "",
};

// 회사별 결정적 컬러 — customer_id (또는 미지정 키) 해시로 8색 팔레트 회전.
// border-l 의 4px 컬러 바와 그룹 헤더의 dot 에 동일한 색을 적용해 같은 회사
// 카드를 한눈에 묶을 수 있게 한다.
const COMPANY_PALETTE: Array<{ bar: string; dot: string }> = [
  { bar: "border-l-sky-500", dot: "bg-sky-500" },
  { bar: "border-l-emerald-500", dot: "bg-emerald-500" },
  { bar: "border-l-amber-500", dot: "bg-amber-500" },
  { bar: "border-l-violet-500", dot: "bg-violet-500" },
  { bar: "border-l-rose-500", dot: "bg-rose-500" },
  { bar: "border-l-cyan-500", dot: "bg-cyan-500" },
  { bar: "border-l-orange-500", dot: "bg-orange-500" },
  { bar: "border-l-indigo-500", dot: "bg-indigo-500" },
];
const UNASSIGNED_COLOR = {
  bar: "border-l-slate-300",
  dot: "bg-slate-400",
};

function companyColor(key: string | null | undefined): {
  bar: string;
  dot: string;
} {
  if (!key) return UNASSIGNED_COLOR;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return COMPANY_PALETTE[Math.abs(h) % COMPANY_PALETTE.length];
}

function CustomerContactsPanel({
  kind,
  q,
  addOpen,
  setAddOpen,
  grouped,
}: {
  kind: ContactKind;
  q: string;
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
  grouped: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [addForm, setAddForm] = useState<CustomerForm>(BLANK_FORM);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CustomerForm>(BLANK_FORM);

  const label = kind === "PARTNER" ? "협력사" : "고객";

  const { data = [], isLoading } = useQuery<CustomerContact[]>({
    queryKey: ["contacts", "external", kind],
    queryFn: async () =>
      (await api.get("/customer-contacts", { params: { kind } })).data,
  });

  const { data: accounts = [] } = useQuery<CustomerAccount[]>({
    queryKey: ["customers", "light"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });
  const sortedAccounts = useMemo(
    () =>
      accounts
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [accounts],
  );

  const filtered = useMemo(() => {
    const lc = q.trim().toLowerCase();
    if (!lc) return data;
    return data.filter((c) => {
      const bag = [c.name, c.company_name, c.title, c.phone, c.mobile, c.email]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return bag.includes(lc);
    });
  }, [data, q]);

  // 회사별 그룹 — 회사 미지정은 마지막 회색 그룹.
  type Group = {
    key: string; // customer_id 또는 "__UNASSIGNED__"
    company: string; // 표시명
    rows: CustomerContact[];
  };
  const UNASSIGNED_KEY = "__UNASSIGNED__";
  const groups: Group[] = useMemo(() => {
    const byKey = new Map<string, Group>();
    for (const c of filtered) {
      const key = c.customer_id || UNASSIGNED_KEY;
      const company =
        key === UNASSIGNED_KEY ? "(미지정)" : c.company_name?.trim() || "(미지정)";
      const g =
        byKey.get(key) ??
        (() => {
          const ng: Group = { key, company, rows: [] };
          byKey.set(key, ng);
          return ng;
        })();
      g.rows.push(c);
    }
    const list = Array.from(byKey.values());
    list.sort((a, b) => {
      // 미지정은 항상 맨 뒤
      if (a.key === UNASSIGNED_KEY) return 1;
      if (b.key === UNASSIGNED_KEY) return -1;
      return a.company.localeCompare(b.company, "ko");
    });
    for (const g of list) {
      g.rows.sort((x, y) => x.name.localeCompare(y.name, "ko"));
    }
    return list;
  }, [filtered]);

  const createM = useMutation({
    mutationFn: async (form: CustomerForm) => {
      const payload = { ...normalize(form), kind };
      return (await api.post("/customer-contacts", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "external", kind] });
      setAddOpen(false);
      setAddForm(BLANK_FORM);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const updateM = useMutation({
    mutationFn: async ({ id, form }: { id: string; form: CustomerForm }) => {
      const payload = normalize(form);
      return (await api.patch(`/customer-contacts/${id}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "external", kind] });
      setEditTargetId(null);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/customer-contacts/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "external", kind] });
      setEditTargetId(null);
    },
  });

  const openEdit = (c: CustomerContact) => {
    setEditTargetId(c.id);
    setEditForm({
      name: c.name ?? "",
      customer_id: c.customer_id ?? null,
      title: c.title ?? "",
      phone: c.phone ?? "",
      mobile: c.mobile ?? "",
      email: c.email ?? "",
      memo: c.memo ?? "",
    });
  };

  return (
    <>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : filtered.length === 0 ? (
        <EmptyCard>등록된 {label} 주소가 없습니다.</EmptyCard>
      ) : grouped ? (
        <div className="flex flex-col gap-5">
          {groups.map((g) => {
            const color = companyColor(
              g.key === UNASSIGNED_KEY ? null : g.key,
            );
            return (
              <div key={g.key} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 sticky top-0 bg-background/90 backdrop-blur-sm py-1 z-10">
                  <span
                    className={"h-2.5 w-2.5 rounded-full shrink-0 " + color.dot}
                  />
                  <span className="text-sm font-semibold">{g.company}</span>
                  <span className="text-xs text-muted-foreground">
                    {g.rows.length}명
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-3">
                  {g.rows.map((c) => (
                    <ContactCard
                      key={c.id}
                      contact={c}
                      color={color}
                      showCompany={false}
                      onClick={() => openEdit(c)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-3">
          {filtered.map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              color={companyColor(c.customer_id)}
              showCompany={true}
              onClick={() => openEdit(c)}
            />
          ))}
        </div>
      )}

      <ContactFormDialog
        open={addOpen}
        title={`${label} 주소 추가`}
        form={addForm}
        setForm={setAddForm}
        accounts={sortedAccounts}
        onClose={() => {
          setAddOpen(false);
          setAddForm(BLANK_FORM);
        }}
        onSubmit={() => createM.mutate(addForm)}
        submitting={createM.isPending}
      />

      <ContactFormDialog
        open={!!editTargetId}
        title={`${label} 주소 수정`}
        form={editForm}
        setForm={setEditForm}
        accounts={sortedAccounts}
        onClose={() => setEditTargetId(null)}
        onSubmit={() =>
          editTargetId && updateM.mutate({ id: editTargetId, form: editForm })
        }
        submitting={updateM.isPending}
        onDelete={async () => {
          if (!editTargetId) return;
          const ok = await dialog.confirm("이 주소를 삭제하시겠습니까?", {
            title: "삭제 확인",
            confirmText: "삭제",
          });
          if (ok) deleteM.mutate(editTargetId);
        }}
      />
    </>
  );
}

function ContactFormDialog({
  open,
  title,
  form,
  setForm,
  accounts,
  onClose,
  onSubmit,
  submitting,
  onDelete,
}: {
  open: boolean;
  title: string;
  form: CustomerForm;
  setForm: (f: CustomerForm) => void;
  accounts: CustomerAccount[];
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
  onDelete?: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  // 회사가 없을 때 인라인으로 등록할 수 있도록. 신규 회사 등록 → 자동 선택.
  const [newCompanyOpen, setNewCompanyOpen] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const createCompanyM = useMutation({
    mutationFn: async (name: string) =>
      (await api.post("/customers", { name: name.trim() })).data as {
        id: string;
        name: string;
      },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["customers", "light"] });
      setForm({ ...form, customer_id: created.id });
      setNewCompanyOpen(false);
      setNewCompanyName("");
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "회사 등록 실패", {
        title: "오류",
      }),
  });
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-3xl"
      footer={
        <>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="h-9 mr-auto inline-flex items-center gap-1 rounded-md border border-border px-3 text-sm text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              삭제
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !form.name.trim()}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {submitting ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="이름 *">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={input}
            autoFocus
          />
        </Field>
        <Field label="직함">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={input}
            placeholder="차장 / 영업본부 등"
          />
        </Field>
        <Field label="회사">
          {/* 고객사(Accounts) FK 만 선택 가능. 자유 문자열 입력은 차단되어 있어
              회사 등록 → 매핑 흐름이 강제된다. 회사 미배정은 빈 값(NULL). */}
          <div className="flex items-center gap-1">
            <select
              value={form.customer_id ?? ""}
              onChange={(e) =>
                setForm({ ...form, customer_id: e.target.value || null })
              }
              className={input}
            >
              <option value="">미지정</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setNewCompanyOpen(true)}
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted"
              title="새 회사 등록"
              aria-label="새 회사 등록"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </Field>
        <Field label="전화">
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className={input}
          />
        </Field>
        <Field label="휴대전화">
          <input
            value={form.mobile}
            onChange={(e) => setForm({ ...form, mobile: e.target.value })}
            className={input}
          />
        </Field>
        <Field label="이메일">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className={input}
          />
        </Field>
        <Field label="메모" colSpan={3}>
          <textarea
            value={form.memo}
            onChange={(e) => setForm({ ...form, memo: e.target.value })}
            className={input + " min-h-20"}
            rows={3}
          />
        </Field>
      </div>

      {/* 인라인 새 회사 등록 — 회사명만 받는 미니 다이얼로그.
          저장 성공 시 customers 캐시 무효화 + 현재 폼의 customer_id 자동 설정. */}
      <Dialog
        open={newCompanyOpen}
        onClose={() => {
          setNewCompanyOpen(false);
          setNewCompanyName("");
        }}
        title="새 회사 등록"
        width="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setNewCompanyOpen(false);
                setNewCompanyName("");
              }}
              className="h-9 rounded-md border border-border px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={
                !newCompanyName.trim() || createCompanyM.isPending
              }
              onClick={() => createCompanyM.mutate(newCompanyName)}
              className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {createCompanyM.isPending ? "등록 중..." : "등록"}
            </button>
          </>
        }
      >
        <Field label="회사명 *">
          <input
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                newCompanyName.trim() &&
                !createCompanyM.isPending
              ) {
                createCompanyM.mutate(newCompanyName);
              }
            }}
            className={input}
            placeholder="(주) 회사명"
            autoFocus
          />
        </Field>
        <div className="mt-2 text-xs text-muted-foreground">
          상세 정보(사업자번호·주소·담당자 등) 는 등록 후 Accounts 페이지에서
          보강할 수 있습니다.
        </div>
      </Dialog>
    </Dialog>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const cls =
    colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ContactCard({
  contact,
  color,
  showCompany,
  onClick,
}: {
  contact: CustomerContact;
  color: { bar: string; dot: string };
  showCompany: boolean;
  onClick: () => void;
}) {
  const c = contact;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-left rounded-lg border border-border border-l-4 bg-card p-4 flex flex-col gap-1 hover:border-primary transition-colors " +
        color.bar
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">{c.name}</span>
        {c.title && (
          <span className="text-xs text-muted-foreground">· {c.title}</span>
        )}
      </div>
      {showCompany && c.company_name && (
        <div className="text-xs text-muted-foreground">{c.company_name}</div>
      )}
      {c.phone && (
        <div className="text-xs flex items-center gap-1.5 mt-1">
          <Phone className="h-3 w-3 text-muted-foreground" />
          {c.phone}
        </div>
      )}
      {c.mobile && (
        <div className="text-xs flex items-center gap-1.5">
          <Smartphone className="h-3 w-3 text-muted-foreground" />
          {c.mobile}
        </div>
      )}
      {c.email && (
        <div className="text-xs flex items-center gap-1.5">
          <Mail className="h-3 w-3 text-muted-foreground" />
          <span className="truncate">{c.email}</span>
        </div>
      )}
    </button>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function normalize(f: CustomerForm) {
  return {
    name: f.name.trim(),
    customer_id: f.customer_id || null,
    title: f.title.trim() || null,
    phone: f.phone.trim() || null,
    mobile: f.mobile.trim() || null,
    email: f.email.trim() || null,
    memo: f.memo.trim() || null,
  };
}
