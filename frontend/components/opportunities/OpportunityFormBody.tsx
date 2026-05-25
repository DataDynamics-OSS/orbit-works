"use client";

import { DateInput } from "@/components/ui/DateInput";
import { sortDevelopersKo } from "@/lib/sort-developers";

export type OppStage = "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION";
export type OppStatus = "OPEN" | "WON" | "LOST" | "ABANDONED";
export type OppBusinessType = "RESEARCH" | "PRIVATE" | "PUBLIC";

export type OppFormValues = {
  name?: string | null;
  customer_id?: string | null;
  owner_id?: string | null;
  sales_rep_id?: string | null;
  stage?: OppStage;
  status?: OppStatus;
  probability?: number;
  expected_amount?: string | number | null;
  currency?: "KRW" | "USD";
  expected_close_date?: string | null;
  registered_at?: string | null;
  source?: string | null;
  business_type?: OppBusinessType | null;
  description?: string | null;
  contact_name?: string | null;
  contact_department?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
};

type Customer = { id: string; name: string };
export type UserBrief = { id: string; name?: string | null; email: string };
export type DeveloperBrief = {
  id: string;
  name: string;
  title?: string | null;
};

function formatNumberInput(v: string): string {
  if (!v) return "";
  const digits = v.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}

export function OpportunityFormBody({
  form,
  setForm,
  customers,
  developers = [],
  error,
}: {
  form: OppFormValues;
  setForm: (
    u: OppFormValues | ((prev: OppFormValues) => OppFormValues),
  ) => void;
  customers: Customer[];
  developers?: DeveloperBrief[];
  error: string | null;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="기회명 *" colSpan={2}>
        <input
          value={form.name ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="예: 삼성SDS 데이터플랫폼 확장"
          className={input}
        />
      </Field>
      <Field label="고객사">
        <select
          value={form.customer_id ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, customer_id: e.target.value || null }))
          }
          className={input}
        >
          <option value="">선택</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="영업대표">
        <select
          value={form.sales_rep_id ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, sales_rep_id: e.target.value || null }))
          }
          className={input}
        >
          <option value="">선택</option>
          {sortDevelopersKo(developers).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.title ? ` · ${d.title}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="등록일">
        <DateInput
          value={form.registered_at ?? ""}
          onChange={(v) => setForm((p) => ({ ...p, registered_at: v || null }))}
        />
      </Field>
      <Field label="예상 마감일">
        <DateInput
          value={form.expected_close_date ?? ""}
          onChange={(v) => setForm((p) => ({ ...p, expected_close_date: v }))}
        />
      </Field>
      <Field label="단계">
        <select
          value={form.stage ?? "LEAD"}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              stage: e.target.value as OppStage,
              probability:
                { LEAD: 10, QUALIFIED: 25, PROPOSAL: 50, NEGOTIATION: 75 }[
                  e.target.value as OppStage
                ] ?? p.probability,
            }))
          }
          className={input}
        >
          <option value="LEAD">발굴</option>
          <option value="QUALIFIED">검증</option>
          <option value="PROPOSAL">제안</option>
          <option value="NEGOTIATION">협상</option>
        </select>
      </Field>
      <Field label="확률 (%)">
        <input
          type="number"
          min={0}
          max={100}
          value={form.probability ?? 0}
          onChange={(e) =>
            setForm((p) => ({ ...p, probability: Number(e.target.value) }))
          }
          className={input}
        />
      </Field>
      <Field label="통화">
        <select
          value={form.currency ?? "KRW"}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              currency: e.target.value as "KRW" | "USD",
            }))
          }
          className={input}
        >
          <option value="KRW">KRW</option>
          <option value="USD">USD</option>
        </select>
      </Field>
      <Field label="예상 금액">
        <input
          type="text"
          inputMode="numeric"
          value={formatNumberInput(String(form.expected_amount ?? ""))}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              expected_amount: e.target.value.replace(/[^0-9]/g, ""),
            }))
          }
          placeholder="0"
          className={`${input} text-right`}
        />
      </Field>
      <Field label="사업구분">
        <select
          value={form.business_type ?? ""}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              business_type:
                (e.target.value || null) as OppBusinessType | null,
            }))
          }
          className={input}
        >
          <option value="">선택</option>
          <option value="RESEARCH">연구과제</option>
          <option value="PRIVATE">민간사업</option>
          <option value="PUBLIC">공공사업</option>
        </select>
      </Field>
      <Field label="소스 (채널)">
        <input
          value={form.source ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, source: e.target.value }))}
          placeholder="예: 인바운드, 소개, RFP"
          className={input}
        />
      </Field>

      <div className="col-span-2 mt-2 border-t border-border pt-3">
        <div className="text-xs font-semibold mb-2">고객사 담당자 정보</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="담당자 부서">
            <input
              value={form.contact_department ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, contact_department: e.target.value }))
              }
              placeholder="예: 인프라팀"
              className={input}
            />
          </Field>
          <Field label="담당자명">
            <input
              value={form.contact_name ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, contact_name: e.target.value }))
              }
              placeholder="예: 홍길동"
              className={input}
            />
          </Field>
          <Field label="전화번호">
            <input
              value={form.contact_phone ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, contact_phone: e.target.value }))
              }
              placeholder="010-1234-5678"
              className={input}
            />
          </Field>
          <Field label="전자우편 주소">
            <input
              type="email"
              value={form.contact_email ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, contact_email: e.target.value }))
              }
              placeholder="contact@example.com"
              className={input}
            />
          </Field>
        </div>
      </div>

      <Field label="설명" colSpan={2}>
        <textarea
          value={form.description ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, description: e.target.value }))
          }
          rows={3}
          className={input}
        />
      </Field>
      {error && (
        <div className="col-span-2 text-xs text-destructive">{error}</div>
      )}
    </div>
  );
}

export function oppToPayload(f: OppFormValues): Record<string, unknown> {
  return {
    name: f.name,
    customer_id: f.customer_id || null,
    owner_id: f.owner_id || null,
    sales_rep_id: f.sales_rep_id || null,
    stage: f.stage,
    status: f.status,
    probability: Number(f.probability ?? 10),
    expected_amount: f.expected_amount || "0",
    currency: f.currency || "KRW",
    expected_close_date: f.expected_close_date || null,
    registered_at: f.registered_at || null,
    source: f.source || null,
    business_type: f.business_type || null,
    description: f.description || null,
    contact_name: f.contact_name || null,
    contact_department: f.contact_department || null,
    contact_phone: f.contact_phone || null,
    contact_email: f.contact_email || null,
  };
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`flex flex-col gap-1 ${colSpan === 2 ? "col-span-2" : ""}`}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
