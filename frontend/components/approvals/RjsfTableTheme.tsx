"use client";

/**
 * rjsf 용 테이블 형식 테마 — 한국식 결재서/신청서 레이아웃.
 *
 * 기본 rjsf 는 라벨/입력을 세로로 쌓아 시각적으로 비좁고, 우리 Tailwind 디자인과
 * 어긋난다. 이 테마는 모든 객체 필드를 좌(라벨) / 우(값) 2열 테이블로 묶어
 * 한국 회사 결재 양식에서 흔히 보는 형태로 정리한다.
 *
 * 사용:
 *   <Form schema={...} uiSchema={...} templates={tableTemplates} widgets={tableWidgets} />
 *
 * - templates  : ObjectFieldTemplate (테이블) + FieldTemplate (라벨 제거)
 * - widgets    : Tailwind 로 스타일된 input / select / textarea / checkbox / date.
 *                Form 에 `disabled` 또는 `readonly` 가 걸리면 widget 이 plain text 로
 *                요약 표시 → 결재 상세 read-only 화면에 그대로 사용 가능.
 */

import { useEffect, useState } from "react";
import type {
  FieldTemplateProps,
  ObjectFieldTemplateProps,
  WidgetProps,
} from "@rjsf/utils";
import { api } from "@/lib/api";
import { TipTapEditor, TipTapViewer } from "@/components/board/TipTapEditor";

// ---------------------------------------------------------------------------
// 공통 — 화면 상태 판정
// ---------------------------------------------------------------------------

function isReadOnly(props: { disabled?: boolean; readonly?: boolean }) {
  return Boolean(props.disabled) || Boolean(props.readonly);
}

function emptyText(): string {
  return "—";
}

// ---------------------------------------------------------------------------
// ObjectFieldTemplate — 객체 properties 를 2열 테이블로 묶음
// ---------------------------------------------------------------------------

function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { properties, title, description } = props;
  // 루트 객체에는 title 을 노출하지 않음 (페이지에서 별도 헤더가 있는 경우가 다수).
  // rjsf v6: ContainerFieldTemplateProps.fieldPathId.id ('root' for root).
  const isRoot = (props as any).fieldPathId?.id === "root";
  const visible = properties.filter((p: any) => !p.hidden);

  return (
    <div className="space-y-2">
      {!isRoot && title && <h4 className="text-sm font-semibold">{title}</h4>}
      {!isRoot && description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <table className="w-full border border-border rounded-md overflow-hidden text-sm bg-background">
        <tbody>
          {visible.map((p: any) => {
            const schema = p.content?.props?.schema ?? {};
            const required = Boolean(p.content?.props?.required);
            const label: string = schema.title ?? p.name;
            const fieldDesc: string | undefined = schema.description;
            return (
              <tr key={p.name} className="border-b last:border-0 align-top">
                <th
                  scope="row"
                  className="bg-muted/40 text-left text-sm font-medium px-3 py-2 w-40 border-r border-border"
                >
                  <span>{label}</span>
                  {required && <span className="text-red-500 ml-0.5">*</span>}
                  {fieldDesc && (
                    <div className="text-xs text-muted-foreground font-normal mt-0.5 leading-snug">
                      {fieldDesc}
                    </div>
                  )}
                </th>
                <td className="px-3 py-2">{p.content}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldTemplate — 기본 wrapper(라벨/오류) 제거. 라벨은 ObjectFieldTemplate 가 그림.
// ---------------------------------------------------------------------------

function FieldTemplate(props: FieldTemplateProps) {
  const { children, errors, rawErrors, help, hidden } = props;
  if (hidden) return null;
  return (
    <div>
      {children}
      {Array.isArray(rawErrors) && rawErrors.length > 0 && (
        <ul className="text-[10px] text-red-500 mt-0.5 list-disc list-inside">
          {rawErrors.map((e: string, i: number) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {errors}
      {help}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

const inputClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "disabled:opacity-60 disabled:cursor-not-allowed";
const textareaClass =
  "w-full rounded-md border border-input bg-background p-2 text-sm " +
  "disabled:opacity-60 disabled:cursor-not-allowed";

function TextWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  if (ro) {
    return (
      <span className="text-sm">
        {props.value ? String(props.value) : emptyText()}
      </span>
    );
  }
  const t =
    props.schema?.format === "date"
      ? "date"
      : props.schema?.format === "email"
        ? "email"
        : "text";
  return (
    <input
      type={t}
      value={props.value ?? ""}
      onChange={(e) => props.onChange(e.target.value || undefined)}
      onBlur={(e) => props.onBlur?.(props.id, e.target.value)}
      onFocus={(e) => props.onFocus?.(props.id, e.target.value)}
      placeholder={props.placeholder}
      required={props.required}
      autoFocus={props.autofocus}
      className={inputClass}
    />
  );
}

function NumberWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  if (ro) {
    const v = props.value;
    return (
      <span className="text-sm tabular-nums">
        {v === null || v === undefined || v === ""
          ? emptyText()
          : typeof v === "number"
            ? v.toLocaleString()
            : String(v)}
      </span>
    );
  }
  return (
    <input
      type="number"
      value={props.value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          props.onChange(undefined);
          return;
        }
        const n = Number(raw);
        props.onChange(Number.isFinite(n) ? n : undefined);
      }}
      onBlur={(e) => props.onBlur?.(props.id, e.target.value)}
      placeholder={props.placeholder}
      required={props.required}
      className={inputClass + " tabular-nums"}
      min={props.schema?.minimum}
      max={props.schema?.maximum}
      step={props.schema?.type === "integer" ? 1 : "any"}
    />
  );
}

function SelectWidget(props: WidgetProps) {
  const opts = (props.options?.enumOptions as { value: any; label: string }[]) ?? [];
  if (isReadOnly(props)) {
    const matched = opts.find((o) => o.value === props.value);
    return (
      <span className="text-sm">
        {matched?.label ?? (props.value ? String(props.value) : emptyText())}
      </span>
    );
  }
  return (
    <select
      value={props.value ?? ""}
      onChange={(e) => props.onChange(e.target.value || undefined)}
      required={props.required}
      className={inputClass}
    >
      {!props.required && <option value="">{props.placeholder ?? "선택…"}</option>}
      {opts.map((o) => (
        <option key={String(o.value)} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function TextareaWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  const rows = ((props.options?.rows as number) ?? 4) | 0;
  if (ro) {
    return (
      <span className="text-sm whitespace-pre-wrap">
        {props.value ? String(props.value) : emptyText()}
      </span>
    );
  }
  return (
    <textarea
      value={props.value ?? ""}
      onChange={(e) => props.onChange(e.target.value || undefined)}
      onBlur={(e) => props.onBlur?.(props.id, e.target.value)}
      placeholder={props.placeholder}
      required={props.required}
      rows={rows}
      className={textareaClass}
    />
  );
}

function CheckboxWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  if (ro) {
    return (
      <span className="text-sm">
        {props.value === true ? "예" : props.value === false ? "아니오" : emptyText()}
      </span>
    );
  }
  return (
    <label className="inline-flex items-center gap-2 text-sm select-none">
      <input
        type="checkbox"
        checked={Boolean(props.value)}
        onChange={(e) => props.onChange(e.target.checked)}
        className="h-4 w-4 rounded border-input"
      />
      <span className="text-sm text-muted-foreground">{props.label}</span>
    </label>
  );
}

function DateWidget(props: WidgetProps) {
  return <TextWidget {...props} schema={{ ...props.schema, format: "date" }} />;
}

// ---------------------------------------------------------------------------
// MoneyWidget — 3자리 콤마 입력. 내부값은 정수로 유지.
// ---------------------------------------------------------------------------

function formatMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d-]/g, ""));
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("ko-KR");
}

function MoneyWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  const [text, setText] = useState<string>(formatMoney(props.value));
  // 외부 value 변경 시 표시 동기화 (form 초기화 등).
  useEffect(() => {
    setText(formatMoney(props.value));
  }, [props.value]);

  if (ro) {
    return (
      <span className="text-sm tabular-nums">
        {props.value === null || props.value === undefined || props.value === ""
          ? emptyText()
          : `${formatMoney(props.value)} 원`}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d-]/g, "");
          setText(raw === "" ? "" : Number(raw).toLocaleString("ko-KR"));
          if (raw === "") {
            props.onChange(undefined);
          } else {
            const n = Number(raw);
            props.onChange(Number.isFinite(n) ? n : undefined);
          }
        }}
        onBlur={(e) => props.onBlur?.(props.id, e.target.value)}
        placeholder={props.placeholder}
        required={props.required}
        className={inputClass + " tabular-nums text-right pr-2"}
      />
      <span className="text-xs text-muted-foreground shrink-0">원</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomerPickerWidget — /customers 에서 거래처 (고객사·협력사) 단일 선택.
// 저장값은 customer.name (string). id 까지 보존하려면 schema 확장 필요.
// ---------------------------------------------------------------------------

type CustomerLite = { id: string; name: string };

let _customersCache: CustomerLite[] | null = null;

async function _loadCustomers(): Promise<CustomerLite[]> {
  if (_customersCache) return _customersCache;
  const r = await api.get("/customers");
  const list: CustomerLite[] = (r.data as any[]).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  _customersCache = list;
  return list;
}

function CustomerPickerWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  const [list, setList] = useState<CustomerLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    _loadCustomers().then((l) => {
      if (alive) {
        setList(l);
        setLoaded(true);
      }
    }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, []);

  if (ro) {
    return (
      <span className="text-sm">
        {props.value ? String(props.value) : emptyText()}
      </span>
    );
  }

  const visible = filter
    ? list.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : list;

  return (
    <div className="space-y-1">
      <select
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value || undefined)}
        required={props.required}
        className={inputClass}
      >
        {!props.required && <option value="">선택…</option>}
        {!loaded && <option>불러오는 중…</option>}
        {visible.map((c) => (
          <option key={c.id} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      {list.length > 12 && (
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="필터 (이름)"
          className={"h-7 text-xs " + inputClass.replace("h-8", "h-7")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectPickerWidget — /projects 에서 프로젝트 단일 선택.
// 저장값은 project.name (string) — CustomerPickerWidget 패턴 mirror.
// ---------------------------------------------------------------------------

type ProjectLite = { id: string; name: string };

let _projectsCache: ProjectLite[] | null = null;

async function _loadProjects(): Promise<ProjectLite[]> {
  if (_projectsCache) return _projectsCache;
  const r = await api.get("/projects");
  const list: ProjectLite[] = (r.data as any[]).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  _projectsCache = list;
  return list;
}

function ProjectPickerWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  const [list, setList] = useState<ProjectLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    _loadProjects().then((l) => {
      if (alive) {
        setList(l);
        setLoaded(true);
      }
    }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, []);

  if (ro) {
    return (
      <span className="text-sm">
        {props.value ? String(props.value) : emptyText()}
      </span>
    );
  }

  const visible = filter
    ? list.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : list;

  return (
    <div className="space-y-1">
      <select
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value || undefined)}
        required={props.required}
        className={inputClass}
      >
        {!props.required && <option value="">선택…</option>}
        {!loaded && <option>불러오는 중…</option>}
        {visible.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      {list.length > 12 && (
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="필터 (이름)"
          className={"h-7 text-xs " + inputClass.replace("h-8", "h-7")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RichTextWidget — 게시판과 동일한 TipTap 리치 에디터.
// 저장값: HTML 문자열. 빈 문서는 "" 로 정규화 (TipTapEditor 가 처리).
// ---------------------------------------------------------------------------

function RichTextWidget(props: WidgetProps) {
  const ro = isReadOnly(props);
  const value: string = typeof props.value === "string" ? props.value : "";
  if (ro) {
    return (
      <div className="text-sm">
        <TipTapViewer html={value} />
      </div>
    );
  }
  const minHeight =
    typeof props.options?.minHeight === "number"
      ? (props.options.minHeight as number)
      : undefined;
  return (
    <TipTapEditor
      value={value}
      onChange={(html) => props.onChange(html || undefined)}
      placeholder={props.placeholder}
      minHeight={minHeight}
    />
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const tableTemplates = {
  ObjectFieldTemplate,
  FieldTemplate,
};

export const tableWidgets = {
  TextWidget,
  EmailWidget: TextWidget,
  URLWidget: TextWidget,
  NumberWidget,
  IntegerWidget: NumberWidget,
  SelectWidget,
  TextareaWidget,
  CheckboxWidget,
  DateWidget,
  // 결재용 전용 widgets — schema 의 ui:widget 으로 명시 호출.
  money: MoneyWidget,
  customerPicker: CustomerPickerWidget,
  projectPicker: ProjectPickerWidget,
  richText: RichTextWidget,
};
