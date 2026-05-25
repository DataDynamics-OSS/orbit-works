"use client";

/**
 * 특수부호 picker 다이얼로그 — 회의록 편집기에서 본문에 특수문자 삽입.
 *
 * 4 카테고리 (수학·기호, 화살표, 통화, 일반 부호) 의 글리프를 그리드로 노출.
 * 카테고리 탭으로 빠르게 전환하고, 클릭 시 onSelect 콜백.
 */

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";

type Category = {
  key: string;
  label: string;
  chars: string[];
};

// 각 카테고리는 정확히 50자 (grid-cols-10 기준 5행) — 탭 간 시각적 일관성 유지.
const CATEGORIES: Category[] = [
  {
    key: "math",
    label: "수학·기호",
    chars: [
      "±", "×", "÷", "≠", "≈", "≤", "≥", "<", ">", "=",
      "∞", "π", "Σ", "∑", "∫", "√", "∂", "∇", "∴", "∵",
      "α", "β", "γ", "δ", "ε", "θ", "λ", "μ", "σ", "φ",
      "Δ", "Ω", "∈", "∉", "⊂", "⊃", "∪", "∩", "∅", "∀",
      "≡", "≢", "≪", "≫", "⊕", "⊗", "⊥", "⊤", "∧", "∨",
    ],
  },
  {
    key: "arrow",
    label: "화살표",
    chars: [
      "→", "←", "↑", "↓", "↔", "↕", "⇒", "⇐", "⇑", "⇓",
      "⇔", "⇕", "↗", "↘", "↙", "↖", "⤴", "⤵", "↩", "↪",
      "⟶", "⟵", "▶", "◀", "▲", "▼", "↞", "↠", "↟", "↡",
      "↦", "↤", "↥", "↧", "↰", "↱", "↲", "↳", "↶", "↷",
      "⇄", "⇅", "⇆", "⇇", "⇈", "⇉", "⇊", "⇋", "⇌", "⇲",
    ],
  },
  {
    key: "currency",
    label: "통화",
    chars: [
      "₩", "$", "€", "£", "¥", "₹", "₽", "¢", "₿", "₫",
      "₴", "₲", "₠", "₡", "₢", "₣", "₤", "₥", "₦", "₧",
      "₨", "₪", "₭", "₮", "₯", "₰", "₱", "₳", "₵", "₶",
      "₷", "₸", "₺", "₻", "₼", "₾", "ƒ", "¤", "฿", "֏",
      "؋", "৳", "૱", "௹", "៛", "﷼", "﹩", "＄", "￠", "￦",
    ],
  },
  {
    key: "general",
    label: "일반 부호",
    chars: [
      "§", "©", "®", "™", "°", "…", "•", "‣", "◦", "·",
      "′", "″", "‴", "‹", "›", "«", "»", "‒", "–", "—",
      "「", "」", "『", "』", "《", "》", "〈", "〉", "※", "⁂",
      "★", "☆", "☑", "☒", "☐", "✓", "✗", "✔", "✘", "‼",
      "♠", "♣", "♥", "♦", "♪", "♫", "⁇", "❄", "❤", "✉",
    ],
  },
];

export function SpecialCharPickerDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (char: string) => void;
}) {
  const [active, setActive] = useState(CATEGORIES[0].key);
  const cat = CATEGORIES.find((c) => c.key === active) ?? CATEGORIES[0];

  return (
    <Dialog open={open} onClose={onClose} title="특수부호 선택" width="max-w-md">
      <div className="flex gap-1 border-b border-border mb-2 -mx-2 px-2 pb-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActive(c.key)}
            className={
              "px-3 py-1 rounded-md text-xs font-medium transition-colors " +
              (active === c.key
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted")
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-10 gap-1">
        {cat.chars.map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => {
              onSelect(ch);
              onClose();
            }}
            className="h-8 inline-flex items-center justify-center rounded-md border border-border hover:bg-muted text-base"
            title={ch}
          >
            {ch}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
