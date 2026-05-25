"use client";

/**
 * 회의록 편집기 상단 영구 툴바.
 *
 * BlockNote v0.49 의 editor instance 를 받아 toggleStyles / addStyles /
 * updateBlock 등을 직접 호출. floating toolbar 는 selection 기반이라 발견성이
 * 낮아, 자주 쓰는 기능을 항상 보이는 상단 바에 모은다.
 *
 * 활성 상태(B 가 toggled 됐는지, 현재 블록이 H1 인지 등) 는 editor.onChange +
 * onSelectionChange 로 추적해 시각적 highlight.
 *
 * 버튼 클릭 시 selection 이 풀리면 toggleStyles 가 동작하지 않는다 — 그래서
 * 모든 버튼이 onMouseDown 에서 preventDefault 로 focus 이동 차단.
 */

import { ReactNode, useEffect, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Code,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Paintbrush,
  Quote,
  Sigma,
  Smile,
  Strikethrough,
  Type,
  Underline,
} from "lucide-react";
import type { BlockNoteEditor } from "@blocknote/core";

// BlockNote 의 색상 팔레트 키 — addStyles 의 textColor/backgroundColor 값.
const COLORS = [
  { key: "default", label: "기본", swatch: "#374151" },
  { key: "gray", label: "회색", swatch: "#6b7280" },
  { key: "brown", label: "갈색", swatch: "#92400e" },
  { key: "red", label: "빨강", swatch: "#dc2626" },
  { key: "orange", label: "주황", swatch: "#ea580c" },
  { key: "yellow", label: "노랑", swatch: "#ca8a04" },
  { key: "green", label: "초록", swatch: "#16a34a" },
  { key: "blue", label: "파랑", swatch: "#2563eb" },
  { key: "purple", label: "보라", swatch: "#9333ea" },
  { key: "pink", label: "분홍", swatch: "#db2777" },
] as const;

const BLOCK_TYPES = [
  { key: "paragraph", label: "단락", props: undefined as any },
  { key: "heading_1", label: "제목 1", type: "heading", props: { level: 1 } },
  { key: "heading_2", label: "제목 2", type: "heading", props: { level: 2 } },
  { key: "heading_3", label: "제목 3", type: "heading", props: { level: 3 } },
  { key: "quote", label: "인용", type: "quote", props: undefined },
  { key: "codeBlock", label: "코드 블록", type: "codeBlock", props: undefined },
] as const;

export function MeetingNoteToolbar({
  editor,
  onOpenSpecialChar,
  onOpenEmoji,
}: {
  editor: BlockNoteEditor;
  onOpenSpecialChar: () => void;
  onOpenEmoji: () => void;
}) {
  const [activeStyles, setActiveStyles] = useState<any>({});
  const [blockTypeKey, setBlockTypeKey] = useState<string>("paragraph");
  const [textAlign, setTextAlign] = useState<string>("left");

  // editor.onChange / onSelectionChange 구독 + 마운트 직후 1회 동기화로 현재
  // selection 의 활성 스타일·블록 타입·정렬을 toolbar UI 에 반영한다.
  useEffect(() => {
    const update = () => {
      try {
        setActiveStyles(editor.getActiveStyles() ?? {});
      } catch {
        setActiveStyles({});
      }
      try {
        const block: any = editor.getTextCursorPosition().block;
        const type = block?.type as string;
        const lvl = block?.props?.level;
        let key = type ?? "paragraph";
        if (type === "heading" && (lvl === 1 || lvl === 2 || lvl === 3)) {
          key = `heading_${lvl}`;
        }
        setBlockTypeKey(key);
        setTextAlign((block?.props?.textAlignment as string) ?? "left");
      } catch {
        /* 비정상 상태 무시 */
      }
    };
    update();
    const offChange = editor.onChange(update);
    // BlockNote v0.49: onSelectionChange 도 제공.
    const offSel: (() => void) | undefined = (editor as any).onSelectionChange?.(
      update,
    );
    return () => {
      if (typeof offChange === "function") offChange();
      if (typeof offSel === "function") offSel();
    };
  }, [editor]);

  function applyBlockType(key: string) {
    const def = BLOCK_TYPES.find((b) => b.key === key);
    if (!def) return;
    const block = editor.getTextCursorPosition().block;
    try {
      if (def.key === "paragraph") {
        editor.updateBlock(block, { type: "paragraph" } as any);
      } else {
        editor.updateBlock(block, {
          type: def.type as any,
          props: def.props as any,
        } as any);
      }
      setTimeout(() => editor.focus(), 0);
    } catch {
      /* type 미지원 등은 무시 */
    }
  }

  function applyTextAlign(align: "left" | "center" | "right") {
    const block = editor.getTextCursorPosition().block;
    try {
      editor.updateBlock(block, {
        props: { textAlignment: align } as any,
      } as any);
      setTimeout(() => editor.focus(), 0);
    } catch {
      /* 무시 */
    }
  }

  function setColor(kind: "text" | "bg", color: string) {
    try {
      const styles: any = {};
      if (kind === "text") styles.textColor = color;
      else styles.backgroundColor = color;
      editor.addStyles(styles);
      setTimeout(() => editor.focus(), 0);
    } catch {
      /* 무시 */
    }
  }

  function createLink() {
    const url = window.prompt("링크 URL");
    if (!url) return;
    try {
      (editor as any).createLink(url);
      setTimeout(() => editor.focus(), 0);
    } catch {
      /* 무시 */
    }
  }

  return (
    <div
      // sticky top-0 — 부모 scroll container (회의록 상세 페이지의 overflow-auto
      // wrapper) 기준으로 본문 스크롤 시 toolbar 가 상단에 고정. bg-background
      // 로 본문 텍스트가 비치지 않도록 불투명 처리, z-10 으로 본문 위에.
      className="sticky top-0 z-10 bg-background flex flex-wrap items-center gap-1 mb-2 px-1 pt-1 pb-2 border-b border-border/60"
      onMouseDown={(e) => {
        // 툴바 영역 어디를 mousedown 해도 editor selection 이 풀리지 않게.
        if ((e.target as HTMLElement).tagName !== "INPUT") {
          e.preventDefault();
        }
      }}
    >
      {/* 블록 타입 */}
      <select
        value={blockTypeKey}
        onChange={(e) => applyBlockType(e.target.value)}
        className="h-7 rounded-md border border-border bg-background px-2 text-xs"
        title="블록 타입"
      >
        {BLOCK_TYPES.map((b) => (
          <option key={b.key} value={b.key}>
            {b.label}
          </option>
        ))}
      </select>

      <Divider />

      {/* 텍스트 스타일 */}
      <ToolBtn
        active={!!activeStyles.bold}
        onClick={() => editor.toggleStyles({ bold: true } as any)}
        title="굵게 (Ctrl+B)"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={!!activeStyles.italic}
        onClick={() => editor.toggleStyles({ italic: true } as any)}
        title="기울임 (Ctrl+I)"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={!!activeStyles.underline}
        onClick={() => editor.toggleStyles({ underline: true } as any)}
        title="밑줄 (Ctrl+U)"
      >
        <Underline className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={!!activeStyles.strike}
        onClick={() => editor.toggleStyles({ strike: true } as any)}
        title="취소선"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={!!activeStyles.code}
        onClick={() => editor.toggleStyles({ code: true } as any)}
        title="인라인 코드"
      >
        <Code className="h-3.5 w-3.5" />
      </ToolBtn>

      <Divider />

      {/* 색상 */}
      <ColorDropdown
        kind="text"
        currentColor={(activeStyles.textColor as string) ?? "default"}
        onSelect={(c) => setColor("text", c)}
        icon={<Type className="h-3.5 w-3.5" />}
        title="글자색"
      />
      <ColorDropdown
        kind="bg"
        currentColor={(activeStyles.backgroundColor as string) ?? "default"}
        onSelect={(c) => setColor("bg", c)}
        icon={<Paintbrush className="h-3.5 w-3.5" />}
        title="배경색"
      />

      <Divider />

      {/* 정렬 */}
      <ToolBtn
        active={textAlign === "left"}
        onClick={() => applyTextAlign("left")}
        title="왼쪽 정렬"
      >
        <AlignLeft className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={textAlign === "center"}
        onClick={() => applyTextAlign("center")}
        title="가운데 정렬"
      >
        <AlignCenter className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={textAlign === "right"}
        onClick={() => applyTextAlign("right")}
        title="오른쪽 정렬"
      >
        <AlignRight className="h-3.5 w-3.5" />
      </ToolBtn>

      <Divider />

      {/* 리스트 */}
      <ToolBtn
        active={blockTypeKey === "bulletListItem"}
        onClick={() => {
          const block = editor.getTextCursorPosition().block;
          try {
            editor.updateBlock(block, { type: "bulletListItem" } as any);
          } catch { /* 무시 */ }
          setTimeout(() => editor.focus(), 0);
        }}
        title="글머리 기호"
      >
        <List className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={blockTypeKey === "numberedListItem"}
        onClick={() => {
          const block = editor.getTextCursorPosition().block;
          try {
            editor.updateBlock(block, { type: "numberedListItem" } as any);
          } catch { /* 무시 */ }
          setTimeout(() => editor.focus(), 0);
        }}
        title="번호 매기기"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        active={blockTypeKey === "checkListItem"}
        onClick={() => {
          const block = editor.getTextCursorPosition().block;
          try {
            editor.updateBlock(block, { type: "checkListItem" } as any);
          } catch { /* 무시 */ }
          setTimeout(() => editor.focus(), 0);
        }}
        title="체크리스트"
      >
        <CheckSquare className="h-3.5 w-3.5" />
      </ToolBtn>

      <Divider />

      <ToolBtn onClick={createLink} title="링크">
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolBtn>
      <ToolBtn
        onClick={() => applyBlockType("quote")}
        active={blockTypeKey === "quote"}
        title="인용"
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolBtn>

      <Divider />

      {/* 특수부호 */}
      <ToolBtn onClick={onOpenSpecialChar} title="특수부호">
        <Sigma className="h-3.5 w-3.5" />
      </ToolBtn>

      {/* 이모지 */}
      <ToolBtn onClick={onOpenEmoji} title="이모지">
        <Smile className="h-3.5 w-3.5" />
      </ToolBtn>
    </div>
  );
}

function ToolBtn({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-pressed={!!active}
      className={
        "h-7 w-7 inline-flex items-center justify-center rounded-md text-foreground hover:bg-muted transition-colors " +
        (active ? "bg-muted text-primary" : "")
      }
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />;
}

function ColorDropdown({
  kind,
  currentColor,
  onSelect,
  icon,
  title,
}: {
  kind: "text" | "bg";
  currentColor: string;
  onSelect: (color: string) => void;
  icon: ReactNode;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const current = COLORS.find((c) => c.key === currentColor) ?? COLORS[0];
  return (
    <div className="relative" onMouseDown={(e) => e.preventDefault()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        className="h-7 inline-flex items-center gap-1 rounded-md px-1.5 text-xs text-foreground hover:bg-muted"
      >
        {icon}
        <span
          className="block h-2 w-3 rounded-sm border border-border"
          style={{ background: current.swatch }}
        />
      </button>
      {open && (
        <>
          {/* 외부 클릭으로 닫기 — backdrop. */}
          <button
            type="button"
            aria-label="닫기"
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full mt-1 z-50 rounded-md border border-border bg-popover p-1 shadow-md grid grid-cols-5 gap-1 min-w-[150px]">
            {COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => {
                  onSelect(c.key);
                  setOpen(false);
                }}
                title={c.label}
                className={
                  "h-6 w-6 rounded-md border border-border inline-flex items-center justify-center " +
                  (currentColor === c.key ? "ring-2 ring-primary" : "")
                }
                style={{ background: kind === "bg" ? c.swatch : "transparent" }}
              >
                {kind === "text" && (
                  <span
                    className="text-xs font-bold"
                    style={{ color: c.swatch }}
                  >
                    A
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
