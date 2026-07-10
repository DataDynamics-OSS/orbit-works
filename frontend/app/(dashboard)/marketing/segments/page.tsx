"use client";

/**
 * 고객 세그먼트 — 캠페인 수신자 set 정의.
 *
 * 다이얼로그는 contact 단위 직접 관리 (`contact_ids`). 사용자는
 *  1) 좌측 후보 패널에서 회사별 contact 를 보고 + 로 우측 '선택된 수신자' 에
 *     추가하거나, 회사 옆 '전체 추가' 로 회사 단위로 일괄 추가.
 *  2) 우측에서 ☓ 로 개별 제거.
 *  3) 검색 input 으로 contact / 회사명 필터.
 *
 * 백엔드는 `contact_ids` 가 비어있지 않으면 그 set 만 수신자로 추출 (segment
 * 모델의 customer_ids 는 정보 보존만, 사실상 미사용). 기존에 customer_ids
 * 만 있는 세그먼트를 편집할 때는 해당 회사의 contact 들로 자동 펼쳐 채워준다.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Users, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/ToastProvider";

type Segment = {
  id: string;
  name: string;
  description: string | null;
  customer_ids: string[];
  contact_ids: string[];
  developer_ids: string[];
  include_kinds: ("CUSTOMER" | "PARTNER")[];
  recipient_count: number | null;
  created_at: string;
  updated_at: string;
};

type DeveloperRow = {
  id: string;
  name: string;
  company_email: string | null;
  employment_type: string;
  status: string;
};

type TenantOut = { name: string };

type Recipient = {
  customer_id: string | null;
  customer_name: string | null;
  customer_contact_id: string;
  contact_name: string;
  email: string;
  // 임직원 세그먼트는 EMPLOYEE shadow contact 도 수신자에 포함된다.
  kind: "CUSTOMER" | "PARTNER" | "EMPLOYEE";
};

type Contact = {
  id: string;
  name: string;
  customer_id: string | null;
  company_name: string | null;
  title: string | null;
  email: string | null;
  // EMPLOYEE 는 회사 직원 발송용 shadow contact (backend 가 lookup-or-create).
  kind: "CUSTOMER" | "PARTNER" | "EMPLOYEE";
};

type Customer = { id: string; name: string };

export default function SegmentsPage() {
  const qc = useQueryClient();
  const [dialogSegment, setDialogSegment] = useState<Segment | null | "new">(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data: segments = [] } = useQuery<Segment[]>({
    queryKey: ["marketing", "segments"],
    queryFn: async () => (await api.get("/marketing/segments")).data,
  });

  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/marketing/segments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["marketing", "segments"] }),
  });

  return (
    <>
      <DashboardHeader
        title="고객 세그먼트"
        actions={
          <button
            type="button"
            onClick={() => setDialogSegment("new")}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> 새 세그먼트
          </button>
        }
      />
      <div className="p-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          캠페인 수신자 추출 조건을 저장. 한 세그먼트를 여러 캠페인에서 재사용 가능.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {segments.length === 0 && (
            <div className="col-span-full text-center text-muted-foreground p-8 border border-dashed border-border rounded-lg">
              등록된 세그먼트가 없습니다.
            </div>
          )}
          {segments.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">{s.name}</div>
                  {s.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {s.description}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDialogSegment(s)}
                    className="text-muted-foreground hover:text-foreground rounded-md p-1"
                    aria-label="편집"
                    title="편집"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`"${s.name}" 세그먼트를 삭제하시겠어요?`))
                        del.mutate(s.id);
                    }}
                    className="text-red-600 hover:bg-red-50 rounded-md p-1"
                    aria-label="삭제"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold">{s.recipient_count ?? 0}</span>
                <span className="text-muted-foreground">명 수신자</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                {s.include_kinds.map((k) => (
                  <span
                    key={k}
                    className="inline-block rounded-full bg-muted px-2 py-0.5"
                  >
                    {k === "CUSTOMER" ? "고객" : "파트너"}
                  </span>
                ))}
                {s.contact_ids.length > 0 && (
                  <span className="inline-block rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5">
                    개별 {s.contact_ids.length}명
                  </span>
                )}
                {s.contact_ids.length === 0 && s.customer_ids.length > 0 && (
                  <span className="inline-block rounded-full bg-sky-100 text-sky-700 px-2 py-0.5">
                    회사 {s.customer_ids.length}곳 (전체 펼침)
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewId(s.id)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                수신자 미리보기 →
              </button>
            </div>
          ))}
        </div>
      </div>

      {dialogSegment !== null && (
        <SegmentDialog
          segment={dialogSegment === "new" ? null : dialogSegment}
          onClose={() => setDialogSegment(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "segments"] });
            setDialogSegment(null);
          }}
        />
      )}

      {previewId && (
        <PreviewDialog
          segmentId={previewId}
          segmentName={segments.find((s) => s.id === previewId)?.name || ""}
          onClose={() => setPreviewId(null)}
        />
      )}
    </>
  );
}


// 신규/편집 공용 세그먼트 다이얼로그. contact_ids 를 직접 다루는 2-패널 UI.
function SegmentDialog({
  segment,
  onClose,
  onSaved,
}: {
  segment: Segment | null; // null = NEW
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includePartners, setIncludePartners] = useState(false);
  // 회사 임직원 후보 노출 토글. ON 이면 좌측 후보에 tenant.name 그룹이 추가.
  const [includeEmployees, setIncludeEmployees] = useState(false);
  // 최종 수신자 set — 백엔드 contact_ids 에 그대로 저장.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 임직원 선택 set — developer.id. 별도 트랙(저장 시 developer_ids 로 전송).
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<string>>(
    new Set(),
  );
  const [query, setQuery] = useState("");

  const { data: contacts = [] } = useQuery<Contact[]>({
    queryKey: ["customer-contacts", "all-for-segment"],
    queryFn: async () => (await api.get("/customer-contacts")).data,
  });
  // 회사 마스터 — contact 0 인 회사도 후보 그룹으로 보이도록.
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "all-for-segment"],
    queryFn: async () => (await api.get("/customers")).data,
  });
  // 내부 임직원 — 항상 fetch (shadow contact ↔ developer 매핑 복원에 필요).
  const { data: employees = [] } = useQuery<DeveloperRow[]>({
    queryKey: ["developers", "full-time-active", "for-segment"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: { employment_type: "FULL_TIME", status_filter: "ACTIVE" },
        })
      ).data,
    staleTime: 60_000,
  });
  // tenant 이름 — '회사 프로필 > 한글' 의 회사명. 임직원 그룹 헤더에 사용.
  const { data: tenant } = useQuery<TenantOut>({
    queryKey: ["tenants", "me"],
    queryFn: async () => (await api.get("/tenants/me")).data,
    staleTime: 5 * 60_000,
  });
  // 이메일 있는 정규직 활성만 후보. 가나다순.
  const employeeCandidates = useMemo(
    () =>
      employees
        .filter((e) => e.status === "ACTIVE" && !!e.company_email)
        .sort((a, b) => a.name.localeCompare(b.name, "ko-KR")),
    [employees],
  );

  // 다이얼로그 첫 진입 시 초기화. segment 가 있으면 그 데이터로.
  // 처음 1회만 동작 (initialized ref) — selectedIds 가 user 입력으로 바뀐 뒤
  // contacts 가 늦게 도착해도 덮어쓰지 않도록.
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    if (!segment) {
      setInitialized(true);
      return;
    }
    setName(segment.name);
    setDescription(segment.description ?? "");
    setIncludePartners(segment.include_kinds.includes("PARTNER"));
    // 임직원 grant 가 있던 세그먼트면 토글 ON + 선택 set 복원.
    if (segment.developer_ids && segment.developer_ids.length > 0) {
      setIncludeEmployees(true);
      setSelectedEmployeeIds(new Set(segment.developer_ids));
    }
    if (segment.contact_ids.length > 0) {
      // shadow contact id 는 employee 토글에서 표현되므로 selectedIds 에서 제외.
      // (contacts 가 아직 안 도착했어도 set 은 작아서 후속 effect 가 깔끔히 정정 가능,
      //  여기선 raw 값 그대로 — 아래에 별도 정리 effect 가 있다.)
      setSelectedIds(new Set(segment.contact_ids));
      setInitialized(true);
    } else if (segment.customer_ids.length > 0) {
      // 마이그레이션 — 기존 customer_ids 만 있는 세그먼트는 contacts 도착 후
      // 해당 회사 contact 들로 펼쳐 채움.
      if (contacts.length === 0) return;
      const next = new Set<string>();
      const cset = new Set(segment.customer_ids);
      const kinds = new Set(segment.include_kinds);
      for (const c of contacts) {
        // EMPLOYEE 는 회사 단위 펼침 대상 아님 — 별도 토글로 제어.
        if (c.kind === "EMPLOYEE") continue;
        if (
          c.customer_id &&
          cset.has(c.customer_id) &&
          kinds.has(c.kind as "CUSTOMER" | "PARTNER") &&
          c.email
        ) {
          next.add(c.id);
        }
      }
      setSelectedIds(next);
      setInitialized(true);
    } else {
      setInitialized(true);
    }
  }, [segment, contacts, initialized]);

  // 후보 — 이메일 없는 contact / 임직원 shadow contact (kind=EMPLOYEE) 숨김.
  // shadow 는 회사 직원 그룹에서 별도로 노출되므로 중복 회피.
  const candidates = useMemo(
    () => contacts.filter((c) => !!c.email && c.kind !== "EMPLOYEE"),
    [contacts],
  );
  // EMPLOYEE shadow contact id 들 (selectedIds 에서 걸러낼 때 사용).
  const employeeShadowContactIds = useMemo(
    () => new Set(contacts.filter((c) => c.kind === "EMPLOYEE").map((c) => c.id)),
    [contacts],
  );

  // 회사 마스터 기준 그룹 — contact 가 0인 회사도 표시 (사용자가 회사 누락을
  // 즉시 인지하고 contact 추가하러 갈 수 있게). kind 필터된 contact 들을 매핑.
  const byCompany = useMemo(() => {
    const contactsByCid = new Map<string, Contact[]>();
    for (const c of candidates) {
      if (!includePartners && c.kind === "PARTNER") continue;
      const cid = c.customer_id ?? "(none)";
      const arr = contactsByCid.get(cid) ?? [];
      arr.push(c);
      contactsByCid.set(cid, arr);
    }
    const groups: { id: string; name: string; contacts: Contact[] }[] = [];
    for (const cust of customers) {
      groups.push({
        id: cust.id,
        name: cust.name,
        contacts: contactsByCid.get(cust.id) ?? [],
      });
      contactsByCid.delete(cust.id);
    }
    // 회사 미지정 contact — 회사 마스터에 없는 customer_id 또는 customer_id NULL.
    for (const [cid, list] of contactsByCid) {
      const name = cid === "(none)"
        ? "(회사 미지정)"
        : list[0]?.company_name ?? "(삭제된 회사)";
      groups.push({ id: cid, name, contacts: list });
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name, "ko-KR"));
  }, [customers, candidates, includePartners]);

  // 검색 필터. 회사명 매칭이면 contact 0 이어도 표시 (회사를 못 찾는 시나리오 회피).
  const filteredGroups = useMemo(() => {
    if (!query.trim()) return byCompany;
    const q = query.toLowerCase();
    return byCompany
      .map((g) => {
        const companyMatch = g.name.toLowerCase().includes(q);
        return {
          ...g,
          contacts: companyMatch
            ? g.contacts
            : g.contacts.filter(
                (c) =>
                  c.name.toLowerCase().includes(q) ||
                  (c.email ?? "").toLowerCase().includes(q),
              ),
          companyMatch,
        };
      })
      .filter((g) => g.companyMatch || g.contacts.length > 0);
  }, [byCompany, query]);

  function addOne(id: string) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.add(id);
      return n;
    });
  }
  function removeOne(id: string) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  }
  function addAllInCompany(items: Contact[]) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      for (const c of items) n.add(c.id);
      return n;
    });
  }
  function removeAllInCompany(items: Contact[]) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      for (const c of items) n.delete(c.id);
      return n;
    });
  }

  const selectedRows = useMemo(() => {
    if (selectedIds.size === 0) return [] as Contact[];
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return Array.from(selectedIds)
      .map((id) => byId.get(id))
      .filter((c): c is Contact => !!c)
      .sort((a, b) => {
        const cn = (a.company_name ?? "").localeCompare(
          b.company_name ?? "",
          "ko-KR",
        );
        if (cn !== 0) return cn;
        return a.name.localeCompare(b.name, "ko-KR");
      });
  }, [contacts, selectedIds]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        description: description || null,
        customer_ids: [],
        contact_ids: Array.from(selectedIds),
        // 토글 OFF 면 임직원 모두 해제 (개별 선택은 무효).
        developer_ids: includeEmployees ? Array.from(selectedEmployeeIds) : [],
        include_kinds: includePartners ? ["CUSTOMER", "PARTNER"] : ["CUSTOMER"],
      };
      if (segment) {
        return (await api.patch(`/marketing/segments/${segment.id}`, payload))
          .data;
      }
      return (await api.post("/marketing/segments", payload)).data;
    },
    onSuccess: () => {
      onSaved();
      toast.success("저장되었습니다.");
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      toast.error(err.response?.data?.detail || "저장에 실패했습니다.");
    },
  });

  // contacts 도착 후 selectedIds 에서 EMPLOYEE shadow id 제거 (UI 표시 중복 제거).
  // 저장 시 backend 가 developer_ids 로 다시 materialize 하므로 데이터 손실 없음.
  useEffect(() => {
    if (employeeShadowContactIds.size === 0) return;
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (employeeShadowContactIds.has(id)) {
          changed = true;
          continue;
        }
        next.add(id);
      }
      return changed ? next : prev;
    });
  }, [employeeShadowContactIds]);

  // 임직원 토글/추가/제거 헬퍼.
  function toggleEmployee(id: string, on: boolean) {
    setSelectedEmployeeIds((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  function addAllEmployees() {
    setSelectedEmployeeIds(new Set(employeeCandidates.map((e) => e.id)));
  }
  function removeAllEmployees() {
    setSelectedEmployeeIds(new Set());
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={segment ? `세그먼트 편집 — ${segment.name}` : "새 세그먼트"}
      width="max-w-5xl"
      footer={
        <div className="flex justify-between items-center gap-2 px-4 py-3 border-t border-border">
          <div className="text-xs text-muted-foreground">
            선택된 수신자{" "}
            <b className="text-foreground">
              {selectedIds.size + (includeEmployees ? selectedEmployeeIds.size : 0)}
            </b>
            명
            {includeEmployees && selectedEmployeeIds.size > 0 && (
              <span className="ml-1 text-[11px]">
                (임직원 {selectedEmployeeIds.size}명 포함)
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => {
                if (!name.trim()) {
                  toast.error("세그먼트 이름을 입력하세요.");
                  return;
                }
                save.mutate();
              }}
              disabled={save.isPending}
              className="text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              저장
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="세그먼트 이름">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예) 2026 Q2 라이센스 갱신 대상"
              className="w-full h-9 rounded-md border border-border bg-background px-2"
              autoFocus
            />
          </Field>
          <Field label="설명 (선택)">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-background px-2"
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includePartners}
              onChange={(e) => setIncludePartners(e.target.checked)}
            />
            파트너사 담당자도 후보에 포함
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeEmployees}
              onChange={(e) => {
                setIncludeEmployees(e.target.checked);
                // 토글 OFF 시 선택된 임직원도 초기화 (혼동 방지).
                if (!e.target.checked) setSelectedEmployeeIds(new Set());
              }}
            />
            회사 직원(임직원) 도 후보에 포함
          </label>
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름·회사명·이메일 검색…"
            className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3" style={{ minHeight: 360 }}>
          {/* 좌측: 후보 */}
          <div className="rounded-md border border-border bg-card">
            <header className="px-3 py-2 border-b border-border text-xs font-semibold flex items-center justify-between">
              <span>후보 — 회사별</span>
              <span className="text-muted-foreground">
                {filteredGroups.reduce((acc, g) => acc + g.contacts.length, 0)}명
              </span>
            </header>
            <div className="max-h-[420px] overflow-y-auto p-2 space-y-2">
              {/* 임직원 그룹 — 토글 ON 일 때만 표시. tenant 이름을 그룹명으로. */}
              {includeEmployees && (() => {
                const matched = !query.trim()
                  ? employeeCandidates
                  : employeeCandidates.filter((e) => {
                      const q = query.toLowerCase();
                      return (
                        e.name.toLowerCase().includes(q) ||
                        (e.company_email ?? "").toLowerCase().includes(q) ||
                        (tenant?.name ?? "").toLowerCase().includes(q)
                      );
                    });
                if (matched.length === 0) return null;
                const allOn =
                  matched.every((e) => selectedEmployeeIds.has(e.id)) &&
                  matched.length > 0;
                return (
                  <div className="rounded border-2 border-primary/40 bg-primary/5">
                    <div className="flex items-center justify-between px-2 py-1.5 bg-primary/10 border-b border-primary/30 text-xs">
                      <span className="font-medium">
                        {tenant?.name ?? "회사 직원"}{" "}
                        <span className="text-muted-foreground">
                          ({matched.length})
                        </span>
                        <span className="ml-1.5 text-[10px] rounded bg-primary/15 text-primary px-1">
                          임직원
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          allOn ? removeAllEmployees() : addAllEmployees()
                        }
                        className="text-[11px] px-2 py-0.5 rounded border border-border bg-background hover:bg-muted"
                      >
                        {allOn ? "전체 해제" : "전체 추가"}
                      </button>
                    </div>
                    <ul>
                      {matched.map((e) => {
                        const on = selectedEmployeeIds.has(e.id);
                        return (
                          <li
                            key={e.id}
                            className="flex items-center gap-2 px-2 py-1 text-xs border-b border-border/40 last:border-0"
                          >
                            <button
                              type="button"
                              onClick={() => toggleEmployee(e.id, !on)}
                              className={
                                "h-6 w-6 inline-flex items-center justify-center rounded " +
                                (on
                                  ? "bg-primary/15 text-primary hover:bg-primary/25"
                                  : "border border-border hover:bg-muted")
                              }
                              title={on ? "제거" : "추가"}
                            >
                              {on ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                            </button>
                            <span className="flex-1 truncate">{e.name}</span>
                            <span className="font-mono text-[10px] text-muted-foreground truncate">
                              {e.company_email}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
              {filteredGroups.length === 0 && !includeEmployees && (
                <div className="text-xs text-muted-foreground italic p-3 text-center">
                  검색 결과 없음.
                </div>
              )}
              {filteredGroups.map((g) => {
                const inSet = g.contacts.filter((c) => selectedIds.has(c.id));
                const empty = g.contacts.length === 0;
                const allSelected = !empty && inSet.length === g.contacts.length;
                return (
                  <div
                    key={g.id}
                    className="rounded border border-border bg-background"
                  >
                    <div className="flex items-center justify-between px-2 py-1.5 bg-muted/50 border-b border-border text-xs">
                      <span className="font-medium">
                        {g.name}{" "}
                        <span className="text-muted-foreground">
                          ({g.contacts.length})
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={empty}
                        onClick={() =>
                          allSelected
                            ? removeAllInCompany(g.contacts)
                            : addAllInCompany(g.contacts)
                        }
                        className="text-[11px] px-2 py-0.5 rounded border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {allSelected ? "전체 해제" : "전체 추가"}
                      </button>
                    </div>
                    {empty ? (
                      <div className="px-3 py-2 text-[11px] text-muted-foreground italic">
                        주소록(연락처) 없음 — 고객사 상세에서 추가 후 사용 가능.
                      </div>
                    ) : (
                    <ul>
                      {g.contacts.map((c) => {
                        const on = selectedIds.has(c.id);
                        return (
                          <li
                            key={c.id}
                            className="flex items-center gap-2 px-2 py-1 text-xs border-b border-border/40 last:border-0"
                          >
                            <button
                              type="button"
                              onClick={() => (on ? removeOne(c.id) : addOne(c.id))}
                              className={
                                "h-6 w-6 inline-flex items-center justify-center rounded " +
                                (on
                                  ? "bg-primary/15 text-primary hover:bg-primary/25"
                                  : "border border-border hover:bg-muted")
                              }
                              title={on ? "제거" : "추가"}
                            >
                              {on ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                            </button>
                            <span className="flex-1 truncate">
                              {c.name}
                              {c.title && (
                                <span className="text-muted-foreground"> · {c.title}</span>
                              )}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground truncate">
                              {c.email}
                            </span>
                            {c.kind === "PARTNER" && (
                              <span className="text-[10px] rounded bg-amber-100 text-amber-700 px-1">
                                파트너
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 우측: 선택된 수신자 */}
          <div className="rounded-md border border-border bg-card">
            <header className="px-3 py-2 border-b border-border text-xs font-semibold flex items-center justify-between">
              <span>선택된 수신자</span>
              <span className="text-muted-foreground">
                {selectedRows.length + (includeEmployees ? selectedEmployeeIds.size : 0)}명
              </span>
            </header>
            <div className="max-h-[420px] overflow-y-auto p-2 space-y-1">
              {/* 선택된 임직원 — 상단에 별도 표시 (구분 명확히). */}
              {includeEmployees && selectedEmployeeIds.size > 0 && (
                <ul className="space-y-1 mb-1">
                  {employeeCandidates
                    .filter((e) => selectedEmployeeIds.has(e.id))
                    .map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded border-2 border-primary/30 bg-primary/5 text-xs"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">
                            {e.name}
                            <span className="ml-1 text-[10px] rounded bg-primary/15 text-primary px-1">
                              임직원
                            </span>
                          </div>
                          <div className="text-muted-foreground truncate">
                            {tenant?.name ?? "회사 직원"} · {e.company_email}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleEmployee(e.id, false)}
                          className="text-red-600 hover:bg-red-50 rounded-md p-1"
                          aria-label="제거"
                          title="제거"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                </ul>
              )}
              {selectedRows.length === 0 && (!includeEmployees || selectedEmployeeIds.size === 0) ? (
                <div className="text-xs text-muted-foreground italic p-3 text-center">
                  좌측에서 + 버튼으로 수신자를 추가하세요.
                </div>
              ) : (
                <ul className="space-y-1">
                  {selectedRows.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded border border-border/60 bg-background text-xs"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
                          {c.name}
                          {c.title && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {c.title}
                            </span>
                          )}
                          {c.kind === "PARTNER" && (
                            <span className="ml-1 text-[10px] rounded bg-amber-100 text-amber-700 px-1">
                              파트너
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground truncate">
                          {c.company_name ?? "(회사 미지정)"} · {c.email}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeOne(c.id)}
                        className="text-red-600 hover:bg-red-50 rounded-md p-1"
                        aria-label="제거"
                        title="제거"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}


function PreviewDialog({
  segmentId,
  segmentName,
  onClose,
}: {
  segmentId: string;
  segmentName: string;
  onClose: () => void;
}) {
  const { data: recipients = [], isLoading, isError, error } = useQuery<Recipient[]>({
    queryKey: ["marketing", "segments", segmentId, "recipients"],
    queryFn: async () =>
      (await api.get(`/marketing/segments/${segmentId}/recipients`)).data,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`수신자 미리보기 · ${segmentName}`}
      width="max-w-3xl"
    >
      {isLoading ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="text-sm text-red-600">
          수신자를 불러오지 못했습니다
          {(error as any)?.response?.data?.detail
            ? ` — ${(error as any).response.data.detail}`
            : "."}
        </div>
      ) : recipients.length === 0 ? (
        <div className="text-sm text-muted-foreground">발송 대상 수신자가 없습니다.</div>
      ) : (
        <div className="text-xs">
          <div className="mb-2 text-muted-foreground">총 {recipients.length}명</div>
          <table className="w-full">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">담당자</th>
                <th className="text-left px-2 py-1.5 font-medium">회사</th>
                <th className="text-left px-2 py-1.5 font-medium">이메일</th>
                <th className="text-left px-2 py-1.5 font-medium">구분</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.customer_contact_id} className="border-t border-border">
                  <td className="px-2 py-1.5">{r.contact_name}</td>
                  <td className="px-2 py-1.5">{r.customer_name || "-"}</td>
                  <td className="px-2 py-1.5 font-mono">{r.email}</td>
                  <td className="px-2 py-1.5">
                    {r.kind === "CUSTOMER"
                      ? "고객"
                      : r.kind === "PARTNER"
                        ? "파트너"
                        : "임직원"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}
