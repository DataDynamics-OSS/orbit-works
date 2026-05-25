"use client";

/**
 * 이모지 picker 다이얼로그 — 회의록 편집기 본문에 이모지 삽입.
 *
 * SpecialCharPickerDialog 와 동일한 카테고리 + 그리드 패턴. emoji-mart 같은
 * 외부 라이브러리 없이 Unicode 글리프 직접 나열 (브라우저 OS 폰트로 렌더링).
 * 카테고리당 50자 (5행 × 10열) 로 시각적 일관성 유지 — 특수부호와 동일.
 */

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";

type Category = {
  key: string;
  label: string;
  chars: string[];
};

// 각 카테고리는 정확히 50자 (grid-cols-10 기준 5행).
const CATEGORIES: Category[] = [
  {
    key: "face",
    label: "표정",
    chars: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃",
      "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙",
      "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔",
      "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥",
      "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🥳",
    ],
  },
  {
    key: "gesture",
    label: "제스처",
    chars: [
      "👋", "🤚", "🖐", "✋", "🖖", "👌", "🤏", "✌", "🤞", "🤟",
      "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝", "👍", "👎",
      "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏",
      "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🫀",
      "🫁", "🦷", "🦴", "👀", "👁", "👅", "👄", "💋", "🩸", "💯",
    ],
  },
  {
    key: "nature",
    label: "자연·동물",
    chars: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄",
      "🐝", "🦋", "🐌", "🐞", "🐢", "🐍", "🦖", "🐳", "🐬", "🐟",
      "🐙", "🦀", "🌳", "🌲", "🌴", "🌵", "🌱", "🌿", "☘", "🍀",
      "🌷", "🌹", "🌺", "🌸", "🌼", "🌻", "🌞", "🌝", "🌚", "⭐",
    ],
  },
  {
    key: "food",
    label: "음식",
    chars: [
      "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈",
      "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆", "🥑", "🥦",
      "🥬", "🥒", "🌶", "🌽", "🥕", "🧄", "🧅", "🥔", "🍞", "🥐",
      "🥖", "🥨", "🧀", "🥚", "🍳", "🥓", "🥩", "🍗", "🍖", "🌭",
      "🍔", "🍟", "🍕", "🥪", "🌮", "🌯", "🍜", "🍝", "🍣", "🍰",
    ],
  },
  {
    key: "activity",
    label: "활동",
    chars: [
      "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🪀", "🏓", "🏸", "🏒", "🏑", "🥍", "🏏", "⛳", "🪁", "🏹",
      "🎣", "🤿", "🥊", "🥋", "🎽", "🛹", "🛷", "⛸", "🥌", "🎿",
      "⛷", "🏂", "🏋", "🤺", "🤸", "🤼", "🤽", "🤾", "🧗", "🚴",
      "🏆", "🥇", "🥈", "🥉", "🏅", "🎖", "🎯", "🎲", "🎮", "🎵",
    ],
  },
  {
    key: "object",
    label: "사물·교통",
    chars: [
      "💻", "🖥", "⌨", "🖱", "📱", "☎", "📞", "📟", "📠", "📺",
      "📷", "📹", "🎥", "🎞", "📽", "🔋", "🔌", "💡", "🔦", "🕯",
      "📔", "📕", "📖", "📗", "📘", "📙", "📚", "📓", "📒", "📃",
      "📄", "📑", "📊", "📈", "📉", "✏", "✒", "🖊", "🖋", "🖌",
      "🚗", "🚕", "🚙", "🚌", "🚎", "🏎", "🚓", "🚑", "🚒", "🚀",
    ],
  },
  {
    key: "sign",
    label: "기호·표시",
    chars: [
      "✅", "☑", "✔", "❌", "✖", "❎", "❗", "❓", "❕", "❔",
      "⚠", "🚫", "⛔", "🔞", "📵", "🚭", "💤", "💢", "💬", "💭",
      "🗨", "🗯", "♻", "🆗", "🆕", "🆙", "🆒", "🆓", "🆖", "🆗",
      "🔥", "✨", "⭐", "🌟", "💫", "💥", "💯", "❤", "🧡", "💛",
      "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣", "💕", "💖",
    ],
  },
];

export function EmojiPickerDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}) {
  const [active, setActive] = useState(CATEGORIES[0].key);
  const cat = CATEGORIES.find((c) => c.key === active) ?? CATEGORIES[0];

  return (
    <Dialog open={open} onClose={onClose} title="이모지 선택" width="max-w-md">
      <div className="flex flex-wrap gap-1 border-b border-border mb-2 -mx-2 px-2 pb-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActive(c.key)}
            className={
              "px-2 py-1 rounded-md text-xs font-medium transition-colors " +
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
        {cat.chars.map((ch, i) => (
          <button
            key={`${cat.key}-${i}`}
            type="button"
            onClick={() => {
              onSelect(ch);
              onClose();
            }}
            className="h-8 inline-flex items-center justify-center rounded-md border border-border hover:bg-muted text-base leading-none"
            title={ch}
          >
            {ch}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
