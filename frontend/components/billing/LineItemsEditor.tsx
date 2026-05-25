"use client";

import { Copy, Trash2 } from "lucide-react";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  Currency,
  GRADE_LABEL,
  GRADE_ORDER,
  ItemKind,
  KIND_LABEL,
  KIND_UNIT_DEFAULT,
  LineItem,
  computeLine,
  formatNumberInput,
  isHumanService,
  stripCommas,
  toNum,
} from "@/lib/billing";

// 견적서·청구서 공용 라인 편집 Grid.
// - 제품/컨설팅/기술지원/개발/운영·유지보수/기타 6종 kind 지원
// - 인력성(컨설팅/기술지원/개발/운영·유지보수) 는 M/M + 등급 입력, 기간 컬럼은 숨김
// - 비인력성은 기간(start/end) 입력, M/M 숨김
// - 년수 컬럼은 모든 kind 에서 표시 (DEVELOPMENT 만 "-" 고정, 년수 무의미)
// - 공급가액 = quantity × unit_price × years × (1 - discount%)
//   사용자가 공급가액 셀을 직접 타이핑하면 `manual_total=true` 로 전환 — qty/price/discount/years
//   변경 시에만 자동 재계산으로 복귀.
type Props = {
  items: LineItem[];
  onChange: (next: LineItem[]) => void;
  currency: Currency;
};

// qty/price/discount 기반 자동 line_total. manual_total 플래그 관리용.
function autoTotal(it: LineItem): number {
  const q = toNum(it.quantity);
  const u = toNum(it.unit_price);
  const d = toNum(it.discount_rate);
  const yRaw = toNum(it.years);
  const y = yRaw >= 1 ? yRaw : 1;
  return q * u * y * (1 - d / 100);
}

export function LineItemsEditor({ items, onChange, currency }: Props) {
  const dialog = useDialog();

  function addItem(kind: ItemKind) {
    const human = isHumanService(kind);
    const next: LineItem = {
      kind,
      name: "",
      description: "",
      unit: KIND_UNIT_DEFAULT[kind],
      quantity: "1",
      unit_price: "0",
      discount_rate: "0",
      role: human ? "" : undefined,
      period_start: null,
      period_end: null,
      // 인력성 라인의 초기 M/M 은 수량과 동기화해서 1.
      months: human ? "1" : null,
      // 다년 계약 배수 — 기본 1년.
      years: "1",
      line_total: "0",
      manual_total: false,
    };
    onChange([...items, next]);
  }

  // 일반 업데이트. qty/price/discount 변경 시 manual_total 해제 + line_total 재계산.
  function update(idx: number, patch: Partial<LineItem>) {
    const next = items.slice();
    const prev = next[idx];
    const merged = { ...prev, ...patch };

    const resetKeys = ["quantity", "unit_price", "discount_rate", "years"] as const;
    const touchedAuto = resetKeys.some((k) => k in patch);
    if (touchedAuto) {
      // 자동 계산 필드가 바뀌었다 → 수동 입력 해제, 재계산.
      merged.manual_total = false;
      merged.line_total = String(autoTotal(merged));
    }

    // 인력 성격 라인은 시작일/종료일을 사용하지 않는다 (M/M 입력으로만 계산).
    if (isHumanService(merged.kind)) {
      merged.period_start = null;
      merged.period_end = null;
    }

    next[idx] = merged;
    onChange(next);
  }

  // 공급가액 수동 입력. manual_total=true 로 고정.
  function setManualTotal(idx: number, value: string) {
    const next = items.slice();
    next[idx] = { ...next[idx], line_total: value, manual_total: true };
    onChange(next);
  }

  async function remove(idx: number) {
    if (
      await dialog.confirm("이 라인을 삭제하시겠습니까?", { destructive: true })
    ) {
      onChange(items.filter((_, i) => i !== idx));
    }
  }

  function move(idx: number, delta: -1 | 1) {
    const j = idx + delta;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    const tmp = next[idx];
    next[idx] = next[j];
    next[j] = tmp;
    onChange(next);
  }

  function duplicate(idx: number) {
    const src = items[idx];
    // 원본의 모든 값을 그대로 복사. position 은 onChange 이후 부모에서 재계산 되지만,
    // 여기서도 명시적으로 원본 값을 유지한 채 바로 아래에 삽입.
    const copy: LineItem = { ...src };
    const next = items.slice();
    next.splice(idx + 1, 0, copy);
    onChange(next);
  }

  const inp = "h-8 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        {(
          [
            "PRODUCT",
            "CONSULTING",
            "TECH_SUPPORT",
            "DEVELOPMENT",
            "MAINTENANCE",
            "OTHER",
          ] as ItemKind[]
        ).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => addItem(k)}
            className="h-8 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
          >
            + {KIND_LABEL[k]}
          </button>
        ))}
        <span className="ml-2 text-[11px] text-muted-foreground self-center">
          공급가액은 자동 계산되지만 직접 입력하면 입력값이 유지됩니다.
        </span>
      </div>

      {/* overflow-x-auto 제거 — 일부 브라우저(Windows Chrome)에서 세로
          스크롤바 예약 공간이 가로 스크롤바처럼 상시 노출되던 이슈 해결.
          w-full 은 유지해 테이블이 컨테이너를 꽉 채우고(품명 열이 남는
          공간 흡수), 좁은 화면에서 오버플로 시 부모 페이지 스크롤로 처리. */}
      <div className="border border-border rounded-md">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-center">
              <th className="p-2 font-semibold w-10 text-center">#</th>
              <th className="p-2 font-semibold w-20 text-center">구분</th>
              <th className="p-2 font-semibold min-w-[128px] text-center">품명 / 규격</th>
              <th className="p-2 font-semibold w-16 text-center">단위</th>
              <th className="p-2 font-semibold w-[154px] text-center">시작일</th>
              <th className="p-2 font-semibold w-[154px] text-center">종료일</th>
              <th className="p-2 font-semibold w-20 text-center">M/M</th>
              <th className="p-2 font-semibold w-20 text-center">년수</th>
              <th className="p-2 font-semibold w-20 text-center">수량</th>
              <th className="p-2 font-semibold w-28 text-center">단가</th>
              <th className="p-2 font-semibold w-20 text-center">할인(%)</th>
              <th className="p-2 font-semibold w-32 text-center">공급가액</th>
              <th className="p-2 font-semibold w-24 text-center">동작</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={13}
                  className="p-6 text-center text-muted-foreground text-sm"
                >
                  위의 + 버튼으로 라인을 추가하세요.
                </td>
              </tr>
            ) : (
              items.map((it, idx) => {
                const c = computeLine(it);
                return (
                  <tr key={idx} className="border-b border-border/60 align-top">
                    <td className="p-2 text-center pt-3">{idx + 1}</td>
                    <td className="p-2 pt-3">
                      <span className="inline-block text-[11px] px-1.5 py-0.5 rounded bg-muted">
                        {KIND_LABEL[it.kind]}
                      </span>
                    </td>
                    <td className="p-2">
                      <input
                        className={inp + " w-full"}
                        placeholder="품명"
                        value={it.name}
                        onChange={(e) => update(idx, { name: e.target.value })}
                      />
                      <textarea
                        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-sm whitespace-pre-wrap break-words resize-y"
                        placeholder="규격 / 설명 (선택)"
                        rows={2}
                        value={it.description ?? ""}
                        onChange={(e) =>
                          update(idx, { description: e.target.value })
                        }
                      />
                      {isHumanService(it.kind) && (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground w-8 shrink-0">
                            등급
                          </span>
                          <select
                            className={inp + " shrink-0"}
                            style={{ width: 80 }}
                            value={it.role ?? ""}
                            onChange={(e) =>
                              update(idx, { role: e.target.value || null })
                            }
                          >
                            <option value="">선택</option>
                            {GRADE_ORDER.map((g) => (
                              <option key={g} value={g}>
                                {GRADE_LABEL[g]}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </td>
                    <td className="p-2 pt-3">
                      <input
                        className={inp + " w-full"}
                        value={it.unit ?? ""}
                        onChange={(e) => update(idx, { unit: e.target.value })}
                      />
                    </td>
                    <td className="p-2 pt-3">
                      {isHumanService(it.kind) ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <DateInput
                          value={it.period_start ?? ""}
                          onChange={(v) =>
                            update(idx, {
                              period_start: v || null,
                            })
                          }
                        />
                      )}
                    </td>
                    <td className="p-2 pt-3">
                      {isHumanService(it.kind) ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <DateInput
                          value={it.period_end ?? ""}
                          onChange={(v) =>
                            update(idx, { period_end: v || null })
                          }
                        />
                      )}
                    </td>
                    {/* M/M — 인력성 라인에서 편집. 양수 소수점 허용. */}
                    <td className="p-2 pt-3">
                      {isHumanService(it.kind) ? (
                        <input
                          className={inp + " w-full text-right tabular-nums"}
                          type="number"
                          min={0}
                          step="0.01"
                          value={it.months ?? ""}
                          placeholder="예: 1.5"
                          onChange={(e) => {
                            // M/M 편집 시 months + quantity 를 동시 갱신해 합계 계산에 반영.
                            const v = e.target.value;
                            update(idx, { months: v || null, quantity: v });
                          }}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    {/* 년수 — 다년 계약 배수. 정수, 최소 1. 공급가액에 곱해진다.
                        개발(DEVELOPMENT) 라인은 다년 개념이 없어 고정 1. */}
                    <td className="p-2 pt-3">
                      {it.kind === "DEVELOPMENT" ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <input
                          className={inp + " w-full text-right tabular-nums"}
                          type="number"
                          min={1}
                          step="1"
                          value={it.years ?? "1"}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = parseInt(raw, 10);
                            // 빈 값이거나 1 미만이면 1 로 보정. 정수만 허용 (소수점 버림).
                            const normalized =
                              !Number.isFinite(n) || n < 1 ? "1" : String(n);
                            update(idx, { years: normalized });
                          }}
                        />
                      )}
                    </td>
                    <td className="p-2 pt-3">
                      <input
                        className={inp + " w-full text-right tabular-nums disabled:opacity-60"}
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.quantity}
                        disabled={isHumanService(it.kind)}
                        title={
                          isHumanService(it.kind)
                            ? "인력성 라인은 M/M 으로 입력하세요."
                            : ""
                        }
                        onChange={(e) => update(idx, { quantity: e.target.value })}
                      />
                    </td>
                    <td className="p-2 pt-3">
                      <input
                        className={inp + " w-full text-right tabular-nums"}
                        type="text"
                        inputMode="decimal"
                        value={formatNumberInput(it.unit_price)}
                        onChange={(e) =>
                          update(idx, {
                            unit_price: stripCommas(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="p-2 pt-3">
                      <input
                        className={inp + " w-full text-right tabular-nums"}
                        type="number"
                        min={0}
                        max={100}
                        step="0.1"
                        value={it.discount_rate}
                        onChange={(e) =>
                          update(idx, { discount_rate: e.target.value })
                        }
                        disabled={!!it.manual_total}
                        title={
                          it.manual_total
                            ? "공급가액을 수동 입력 중입니다. 적용하려면 공급가액을 비우세요."
                            : ""
                        }
                      />
                    </td>
                    <td className="p-2 pt-3">
                      <input
                        className={
                          inp +
                          " w-full text-right tabular-nums " +
                          (it.manual_total
                            ? "border-amber-500 bg-amber-50"
                            : "")
                        }
                        type="text"
                        inputMode="decimal"
                        value={formatNumberInput(
                          it.manual_total
                            ? (it.line_total ?? "")
                            : String(Math.round(c.total)),
                        )}
                        onChange={(e) =>
                          setManualTotal(idx, stripCommas(e.target.value))
                        }
                        title={
                          it.manual_total
                            ? "수동 입력됨 — 수량/단가/할인을 바꾸면 자동 계산으로 돌아갑니다."
                            : "수량×단가×(1-할인) 자동 계산. 직접 타이핑하면 수동 입력 모드로 전환됩니다."
                        }
                      />
                    </td>
                    <td className="p-2 pt-3 text-center whitespace-nowrap">
                      {/* 한 줄에 ↑ ↓ 삭제 복제 — 복제가 아래로 밀리지 않도록 flex-row */}
                      <div className="inline-flex items-center gap-1">
                        <Tooltip label="위로" side="top">
                          <button
                            type="button"
                            onClick={() => move(idx, -1)}
                            disabled={idx === 0}
                            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 px-1"
                          >
                            ↑
                          </button>
                        </Tooltip>
                        <Tooltip label="아래로" side="top">
                          <button
                            type="button"
                            onClick={() => move(idx, 1)}
                            disabled={idx === items.length - 1}
                            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 px-1"
                          >
                            ↓
                          </button>
                        </Tooltip>
                        <Tooltip label="행 삭제" side="top">
                          <button
                            type="button"
                            onClick={() => remove(idx)}
                            className="inline-flex items-center text-destructive hover:bg-destructive/10 rounded p-1 ml-1"
                            aria-label="삭제"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip label="현재 행을 복사해서 아래에 추가" side="top">
                          <button
                            type="button"
                            onClick={() => duplicate(idx)}
                            className="inline-flex items-center text-primary hover:bg-primary/10 rounded p-1"
                            aria-label="복제"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function monthsBetween(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  const diffDays = (e.getTime() - s.getTime()) / 86_400_000 + 1;
  return Math.max(0, Math.round((diffDays / 30.44) * 100) / 100);
}
