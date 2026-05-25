"use client";

/**
 * 게시판 리치 에디터 — TipTap.
 * - 화이트 테마, 풀 툴바.
 * - StarterKit (heading/list/blockquote/code/codeBlock/horizontalRule/hardBreak/history)
 *   + Underline + Link + Image + Table + TaskList + TextAlign + Placeholder.
 * - 출력: HTML 문자열. 빈 문서는 "<p></p>" 가 아니라 빈 문자열로 정규화.
 */

import { forwardRef, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { compressImageToDataUrl } from "@/lib/image-compress";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { ResizableImage as Image } from "@/components/board/tiptap-resizable-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { TextAlign } from "@tiptap/extension-text-align";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Indent as IndentExtension } from "./extensions/indent";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Indent,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Outdent,
  Minus,
  Palette,
  Quote,
  Redo,
  Sigma,
  Smile,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline as UnderlineIcon,
  Undo,
} from "lucide-react";

import {
  EMOJI_CATEGORIES,
  type EmojiCategory,
  type EmojiItem,
  findEmojiByChar,
  getRecentEmojis,
  pushRecentEmoji,
  searchEmojis,
} from "@/components/board/emoji-data";

const EMPTY_HTML_PATTERNS = [/^<p><\/p>$/, /^<p>\s*<\/p>$/];

export function isEmptyTipTapHtml(html: string): boolean {
  if (!html) return true;
  const t = html.trim();
  return EMPTY_HTML_PATTERNS.some((re) => re.test(t));
}

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  minHeight?: number;
};


/**
 * paste/drop 한 이미지 파일들을 압축 → base64 → image node 로 삽입.
 * pos 가 null 이면 현재 selection 위치.
 */
async function insertImagesFromFiles(
  view: import("@tiptap/pm/view").EditorView,
  files: File[],
  pos?: number,
): Promise<void> {
  for (const f of files) {
    let dataUrl: string;
    try {
      dataUrl = await compressImageToDataUrl(f, { maxDim: 1280, quality: 0.75 });
    } catch {
      continue;
    }
    const node = view.state.schema.nodes.image?.create({ src: dataUrl });
    if (!node) continue;
    const tr = view.state.tr;
    if (typeof pos === "number") tr.insert(pos, node);
    else tr.replaceSelectionWith(node);
    view.dispatch(tr);
  }
}

export function TipTapEditor({
  value,
  onChange,
  placeholder,
  readOnly = false,
  minHeight,
}: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        // StarterKit 의 기본 설정 사용. heading 1~6, list, blockquote, code,
        // codeBlock, horizontalRule, hardBreak, history 모두 포함.
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: "text-primary underline",
          rel: "noopener noreferrer",
          target: "_blank",
        },
      }),
      Image.configure({
        HTMLAttributes: { class: "max-w-full rounded" },
      }),
      Table.configure({
        resizable: true,
        HTMLAttributes: { class: "tiptap-table" },
      }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // 글자 색 — TextStyle 은 Color 의 의존성 (인라인 마크 wrapper).
      TextStyle,
      Color,
      // paragraph / heading 에 indent 정수 속성 부여 (table cell 안의 paragraph
      // 도 자동 적용). 리스트는 sinkListItem/liftListItem 으로 별도 처리.
      IndentExtension,
      Placeholder.configure({
        placeholder: placeholder ?? "내용을 입력하세요...",
        emptyEditorClass: "is-editor-empty",
      }),
    ],
    content: value || "",
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      onChange(isEmptyTipTapHtml(html) ? "" : html);
    },
    // 이미지 클립보드 paste / drag-drop — 압축 후 base64 inline.
    // TipTap default 는 file → src 변환을 안 해서 빈 <img> 가 들어가던 문제 해결.
    // 1MB 짜리 스크린샷도 maxDim 1280 + JPEG 0.75 로 보통 100~200KB 까지 축소.
    editorProps: {
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files || []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImagesFromFiles(view, files);
        return true;
      },
      handleDrop(view, event) {
        const dt = (event as DragEvent).dataTransfer;
        const files = Array.from(dt?.files || []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        const e = event as DragEvent;
        const coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
        void insertImagesFromFiles(view, files, coords?.pos);
        return true;
      },
    },
  });

  // 외부 value 가 비동기 로딩되어 나중에 채워지는 경우 동기화
  useEffect(() => {
    if (!editor) return;
    if ((value || "") === editor.getHTML()) return;
    if (isEmptyTipTapHtml(editor.getHTML()) && !value) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [value, editor]);

  // 표 안에서 우클릭 → 컨텍스트 메뉴 (행/열 추가·삭제 등)
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor || readOnly) return;
    if (!editor.isActive("table")) return; // 표 밖이면 브라우저 기본 메뉴
    e.preventDefault();
    setTableMenu({ x: e.clientX, y: e.clientY });
  };

  if (!editor) return null;

  return (
    <div className="rounded-md border border-border bg-white">
      {!readOnly && <Toolbar editor={editor} />}
      <div
        className={
          "tiptap-content " +
          (readOnly
            ? "p-4"
            : minHeight !== undefined
              ? "p-4"
              : "p-4 min-h-[300px]")
        }
        style={!readOnly && minHeight !== undefined ? { minHeight } : undefined}
        onContextMenu={onContextMenu}
      >
        <EditorContent editor={editor} />
      </div>
      {tableMenu && (
        <TableContextMenu
          editor={editor}
          x={tableMenu.x}
          y={tableMenu.y}
          onClose={() => setTableMenu(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 뷰어 — 읽기 전용 (게시글 보기 화면).
// ---------------------------------------------------------------------------
//
// forwardRef — 부모가 본문 컨테이너 DOM 을 받아 heading 추출(목차) 등에 사용.
export const TipTapViewer = forwardRef<HTMLDivElement, { html: string }>(
  function TipTapViewer({ html }, ref) {
    if (!html || isEmptyTipTapHtml(html)) {
      return <p className="text-muted-foreground text-sm italic">(내용 없음)</p>;
    }
    return (
      <div
        ref={ref}
        className="tiptap-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function Toolbar({ editor }: { editor: Editor }) {
  const btn =
    "h-8 w-8 inline-flex items-center justify-center rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed";
  const btnActive =
    "h-8 w-8 inline-flex items-center justify-center rounded bg-slate-200 text-slate-900";
  const sep = "mx-1 h-5 w-px bg-border";

  return (
    // sticky — KB 처럼 본문이 긴 페이지에서 스크롤 시 toolbar 가 viewport
    // 상단에 붙어 따라온다. z-10 으로 본문 위, 다이얼로그(z-50+) 아래 유지.
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-border bg-slate-50 px-2 py-1.5">
      {/* 텍스트 서식 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={editor.isActive("bold") ? btnActive : btn}
        title="굵게 (Ctrl+B)"
      >
        <Bold className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={editor.isActive("italic") ? btnActive : btn}
        title="기울임 (Ctrl+I)"
      >
        <Italic className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={editor.isActive("underline") ? btnActive : btn}
        title="밑줄 (Ctrl+U)"
      >
        <UnderlineIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={editor.isActive("strike") ? btnActive : btn}
        title="취소선"
      >
        <Strikethrough className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={editor.isActive("code") ? btnActive : btn}
        title="인라인 코드"
      >
        <Code className="h-4 w-4" />
      </button>
      <ColorButton editor={editor} />
      <EmojiButton editor={editor} />
      {/* 별도 진입점 — 회의록(BlockNote) UX 일치. 같은 picker 의 '기호' 탭으로 직접 진입. */}
      <EmojiButton
        editor={editor}
        defaultTab="sym"
        icon={<Sigma className="h-4 w-4" />}
        title="특수문자"
      />

      <span className={sep} />

      {/* 헤딩 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        className={editor.isActive("heading", { level: 1 }) ? btnActive : btn}
        title="제목 1"
      >
        <Heading1 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={editor.isActive("heading", { level: 2 }) ? btnActive : btn}
        title="제목 2"
      >
        <Heading2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        className={editor.isActive("heading", { level: 3 }) ? btnActive : btn}
        title="제목 3"
      >
        <Heading3 className="h-4 w-4" />
      </button>

      <span className={sep} />

      {/* 목록 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={editor.isActive("bulletList") ? btnActive : btn}
        title="글머리 기호 목록"
      >
        <List className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={editor.isActive("orderedList") ? btnActive : btn}
        title="번호 매기기 목록"
      >
        <ListOrdered className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        className={editor.isActive("taskList") ? btnActive : btn}
        title="체크리스트"
      >
        <ListChecks className="h-4 w-4" />
      </button>
      {/* 들여쓰기 / 내어쓰기 — 리스트 안이면 sinkListItem/liftListItem,
          그 외 paragraph / heading 이면 커스텀 indent 확장이 padding-left 부여.
          table cell 안의 paragraph 도 후자로 처리됨. */}
      <button
        type="button"
        onClick={() => {
          const c = editor.chain().focus();
          if (editor.isActive("taskItem")) c.sinkListItem("taskItem").run();
          else if (editor.isActive("listItem")) c.sinkListItem("listItem").run();
          else c.indent().run();
        }}
        className={btn}
        title="들여쓰기"
      >
        <Indent className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => {
          const c = editor.chain().focus();
          if (editor.isActive("taskItem")) c.liftListItem("taskItem").run();
          else if (editor.isActive("listItem")) c.liftListItem("listItem").run();
          else c.outdent().run();
        }}
        className={btn}
        title="내어쓰기"
      >
        <Outdent className="h-4 w-4" />
      </button>

      <span className={sep} />

      {/* 정렬 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
        className={editor.isActive({ textAlign: "left" }) ? btnActive : btn}
        title="왼쪽 정렬"
      >
        <AlignLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
        className={editor.isActive({ textAlign: "center" }) ? btnActive : btn}
        title="가운데 정렬"
      >
        <AlignCenter className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
        className={editor.isActive({ textAlign: "right" }) ? btnActive : btn}
        title="오른쪽 정렬"
      >
        <AlignRight className="h-4 w-4" />
      </button>

      <span className={sep} />

      {/* 블록 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={editor.isActive("blockquote") ? btnActive : btn}
        title="인용문"
      >
        <Quote className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        className={editor.isActive("codeBlock") ? btnActive : btn}
        title="코드 블록"
      >
        <Code2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        className={btn}
        title="가로줄"
      >
        <Minus className="h-4 w-4" />
      </button>

      <span className={sep} />

      {/* 링크 / 이미지 */}
      <button
        type="button"
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("링크 URL", prev ?? "https://");
          if (url === null) return;
          if (url === "") {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            return;
          }
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href: url })
            .run();
        }}
        className={editor.isActive("link") ? btnActive : btn}
        title="링크"
      >
        <LinkIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => {
          const url = window.prompt("이미지 URL", "https://");
          if (!url) return;
          editor.chain().focus().setImage({ src: url }).run();
        }}
        className={btn}
        title="이미지 (URL)"
      >
        <ImageIcon className="h-4 w-4" />
      </button>

      <span className={sep} />

      {/* 표 */}
      <button
        type="button"
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
        className={btn}
        title="표 삽입 (3×3)"
      >
        <TableIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().addRowAfter().run()}
        disabled={!editor.can().addRowAfter()}
        className={btn}
        title="아래 행 추가"
      >
        <span className="text-[10px] font-semibold">+R</span>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().addColumnAfter().run()}
        disabled={!editor.can().addColumnAfter()}
        className={btn}
        title="오른쪽 열 추가"
      >
        <span className="text-[10px] font-semibold">+C</span>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().deleteRow().run()}
        disabled={!editor.can().deleteRow()}
        className={btn}
        title="행 삭제"
      >
        <span className="text-[10px] font-semibold">−R</span>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().deleteColumn().run()}
        disabled={!editor.can().deleteColumn()}
        className={btn}
        title="열 삭제"
      >
        <span className="text-[10px] font-semibold">−C</span>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().deleteTable().run()}
        disabled={!editor.can().deleteTable()}
        className={btn}
        title="표 삭제"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <span className={sep} />

      {/* Undo / Redo */}
      <button
        type="button"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        className={btn}
        title="실행 취소 (Ctrl+Z)"
      >
        <Undo className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        className={btn}
        title="다시 실행 (Ctrl+Y)"
      >
        <Redo className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table Context Menu — 표 안 우클릭 시 노출되는 floating 메뉴.
//   Portal 로 body 에 렌더 → AG Grid 등 overflow 컨테이너 영향 없음.
//   외부 클릭 / Esc / 명령 실행 후 자동 닫힘.
// ---------------------------------------------------------------------------

function TableContextMenu({
  editor,
  x,
  y,
  onClose,
}: {
  editor: Editor;
  x: number;
  y: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (
        tgt instanceof HTMLElement &&
        !tgt.closest("[data-tt-table-menu]")
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 화면 밖 넘어가지 않도록 좌표 보정
  const left =
    typeof window !== "undefined"
      ? Math.min(x, window.innerWidth - 220)
      : x;
  const top =
    typeof window !== "undefined"
      ? Math.min(y, window.innerHeight - 380)
      : y;

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  type Item =
    | { kind: "sep" }
    | { kind: "action"; label: string; disabled?: boolean; onClick: () => void; danger?: boolean };

  const items: Item[] = [
    {
      kind: "action",
      label: "↑ 위에 행 추가",
      disabled: !editor.can().addRowBefore(),
      onClick: run(() => editor.chain().focus().addRowBefore().run()),
    },
    {
      kind: "action",
      label: "↓ 아래에 행 추가",
      disabled: !editor.can().addRowAfter(),
      onClick: run(() => editor.chain().focus().addRowAfter().run()),
    },
    {
      kind: "action",
      label: "← 왼쪽 열 추가",
      disabled: !editor.can().addColumnBefore(),
      onClick: run(() => editor.chain().focus().addColumnBefore().run()),
    },
    {
      kind: "action",
      label: "→ 오른쪽 열 추가",
      disabled: !editor.can().addColumnAfter(),
      onClick: run(() => editor.chain().focus().addColumnAfter().run()),
    },
    { kind: "sep" },
    {
      kind: "action",
      label: "행 삭제",
      disabled: !editor.can().deleteRow(),
      onClick: run(() => editor.chain().focus().deleteRow().run()),
    },
    {
      kind: "action",
      label: "열 삭제",
      disabled: !editor.can().deleteColumn(),
      onClick: run(() => editor.chain().focus().deleteColumn().run()),
    },
    { kind: "sep" },
    {
      kind: "action",
      label: "셀 병합",
      disabled: !editor.can().mergeCells(),
      onClick: run(() => editor.chain().focus().mergeCells().run()),
    },
    {
      kind: "action",
      label: "셀 분리",
      disabled: !editor.can().splitCell(),
      onClick: run(() => editor.chain().focus().splitCell().run()),
    },
    {
      kind: "action",
      label: "헤더 행 토글",
      disabled: !editor.can().toggleHeaderRow(),
      onClick: run(() => editor.chain().focus().toggleHeaderRow().run()),
    },
    {
      kind: "action",
      label: "헤더 열 토글",
      disabled: !editor.can().toggleHeaderColumn(),
      onClick: run(() => editor.chain().focus().toggleHeaderColumn().run()),
    },
    { kind: "sep" },
    {
      kind: "action",
      label: "표 삭제",
      disabled: !editor.can().deleteTable(),
      onClick: run(() => editor.chain().focus().deleteTable().run()),
      danger: true,
    },
  ];

  return createPortal(
    <div
      data-tt-table-menu
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 1000,
        minWidth: 200,
      }}
      className="rounded-md border border-input bg-white shadow-lg py-1 text-sm"
    >
      {items.map((it, i) =>
        it.kind === "sep" ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onClick={it.onClick}
            className={
              "block w-full text-left px-3 py-1.5 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed " +
              (it.danger ? "text-rose-600" : "")
            }
          >
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// 글자 색상 버튼 — 팔레트 + "사용자 지정" + "지우기".
// ---------------------------------------------------------------------------

// 5×4 그리드 — 1행은 어두운/기본 톤, 2행은 색상환 균등, 3행은 밝은/포인트,
// 4행은 보조(라임·하늘·인디고·갈색·연회색).
const COLOR_PALETTE = [
  "#0f172a", // 검정 (slate-900)
  "#dc2626", // 빨강
  "#ea580c", // 주황
  "#ca8a04", // 노랑
  "#16a34a", // 초록
  "#0891b2", // 청록
  "#2563eb", // 파랑
  "#7c3aed", // 보라
  "#db2777", // 분홍
  "#64748b", // 회색
  // 추가 10종.
  "#7f1d1d", // 와인 (red-900) — 강조 어두운 빨강
  "#fbbf24", // 호박 (amber-400) — 밝은 노랑
  "#84cc16", // 라임 (lime-500)
  "#10b981", // 에메랄드 (emerald-500)
  "#0d9488", // 청록2 (teal-600)
  "#0284c7", // 하늘 (sky-600)
  "#4f46e5", // 인디고 (indigo-600)
  "#c026d3", // 자홍 (fuchsia-600)
  "#f43f5e", // 장미 (rose-500)
  "#92400e", // 갈색 (amber-800)
];

function ColorButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  // 사용자 지정 — 네이티브 OS color picker 사용. <input type="color"> 를 화면
  // 밖에 두고 .click() 으로 띄움. 변경 시 onChange 로 즉시 적용.
  const colorInputRef = useRef<HTMLInputElement | null>(null);

  // 외부 클릭 닫기.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (wrapRef.current && !wrapRef.current.contains(tgt)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 현재 선택된 색 (ColorPicker 의 indicator 용). 없으면 기본 검정.
  const current = (editor.getAttributes("textStyle").color as string) || "";

  const apply = (c: string) => {
    editor.chain().focus().setColor(c).run();
    setOpen(false);
  };
  const clear = () => {
    editor.chain().focus().unsetColor().run();
    setOpen(false);
  };
  const custom = () => {
    // 네이티브 color picker 트리거 — 일부 브라우저는 click() 호출 시점에 사용자
    // 제스처 컨텍스트가 필요하므로 onClick 안에서 직접 호출.
    if (colorInputRef.current) {
      colorInputRef.current.value = current || "#000000";
      colorInputRef.current.click();
    }
  };

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-muted relative"
        title="글자 색"
      >
        <Palette className="h-4 w-4" />
        {/* 현재 색 indicator — 아이콘 하단에 가는 막대로 표시. */}
        <span
          aria-hidden
          className="absolute bottom-1 left-1.5 right-1.5 h-0.5 rounded-sm"
          style={{ backgroundColor: current || "transparent" }}
        />
      </button>
      {/* 네이티브 OS color picker 트리거 — 화면에 보이지 않게 숨김. 사용자
          '사용자 지정' 클릭 시 .click() 으로 띄운다. 'open' 과 무관하게 항상
          마운트해야 mousedown → click 사용자 제스처 체인이 끊기지 않음. */}
      <input
        ref={colorInputRef}
        type="color"
        defaultValue={current || "#000000"}
        onChange={(e) => apply(e.target.value)}
        className="absolute opacity-0 pointer-events-none"
        style={{ width: 0, height: 0 }}
        tabIndex={-1}
        aria-hidden
      />
      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-50 rounded-md border border-input bg-white shadow-lg p-2"
          style={{ minWidth: 180 }}
        >
          <div className="grid grid-cols-5 gap-1 mb-2">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => apply(c)}
                className={
                  "h-6 w-6 rounded border-2 transition " +
                  (current.toLowerCase() === c.toLowerCase()
                    ? "border-primary"
                    : "border-transparent hover:border-slate-300")
                }
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
          <div className="flex gap-1 text-[11px]">
            <button
              type="button"
              onClick={custom}
              className="flex-1 rounded border border-input bg-background px-2 py-1 hover:bg-muted"
            >
              사용자 지정
            </button>
            <button
              type="button"
              onClick={clear}
              className="flex-1 rounded border border-input bg-background px-2 py-1 hover:bg-muted text-muted-foreground"
            >
              지우기
            </button>
          </div>
        </div>
      )}
    </span>
  );
}


// ---------------------------------------------------------------------------
// Emoji / 특수문자 picker — 큐레이션 5탭 (자주 / 표정 / 기호 / 화살표 /
// 수학·통화) + 검색. 풀 emoji set 은 OS native picker (⌃⌘Space) 보완.
// ColorButton 의 dropdown 패턴 mirror — 외부 클릭·Esc 로 닫힘.
// ---------------------------------------------------------------------------

function EmojiButton({
  editor,
  /** 진입 시 보일 탭 (key — recent / 카테고리 키). 기본 recent → 표정. */
  defaultTab,
  /** 버튼 아이콘 — 회의록 호환으로 '특수부호' 변형은 Sigma 사용. 기본 Smile. */
  icon,
  /** 버튼 title (툴팁). */
  title = "이모지 / 특수문자",
}: {
  editor: Editor;
  defaultTab?: string;
  icon?: React.ReactNode;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>(defaultTab || "recent");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // dropdown 열릴 때마다 recent 새로고침 (다른 에디터 인스턴스의 변경 반영).
  useEffect(() => {
    if (!open) return;
    setRecent(getRecentEmojis());
    setQuery("");
    // defaultTab 이 지정되면 그것을 그대로, 아니면 recent / 첫 카테고리.
    setTab(() => {
      if (defaultTab) return defaultTab;
      return getRecentEmojis().length > 0 ? "recent" : EMOJI_CATEGORIES[0].key;
    });
  }, [open, defaultTab]);

  // 외부 클릭·Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (wrapRef.current && !wrapRef.current.contains(tgt)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const insert = (it: EmojiItem) => {
    editor.chain().focus().insertContent(it.char).run();
    setRecent(pushRecentEmoji(it.char));
    // 닫지 않음 — 연속 삽입 가능. 명시적 Esc / 외부 클릭으로 닫기.
  };

  // 현재 탭 items — 검색 중이면 검색 결과 우선.
  const items: EmojiItem[] = (() => {
    if (query.trim()) return searchEmojis(query);
    if (tab === "recent") {
      return recent
        .map((c) => findEmojiByChar(c) ?? { char: c, name: c })
        .filter((x) => x.char);
    }
    const cat = EMOJI_CATEGORIES.find((c) => c.key === tab);
    return cat ? cat.items : [];
  })();

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-muted"
        title={title}
      >
        {icon ?? <Smile className="h-4 w-4" />}
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-50 rounded-md border border-input bg-white shadow-lg p-2"
          style={{ width: 360 }}
        >
          {/* 검색 */}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="검색 (예: 체크, smile, →)"
            className="w-full mb-2 h-7 rounded border border-input bg-background px-2 text-xs"
            autoFocus
          />
          {/* 탭 — 검색 중에는 숨김 (전체 결과 단일 grid). */}
          {!query.trim() && (
            <div className="flex items-center gap-0 mb-2 border-b border-border text-xs">
              <EmojiTab
                active={tab === "recent"}
                onClick={() => setTab("recent")}
                disabled={recent.length === 0}
              >
                자주
              </EmojiTab>
              {EMOJI_CATEGORIES.map((c) => (
                <EmojiTab
                  key={c.key}
                  active={tab === c.key}
                  onClick={() => setTab(c.key)}
                >
                  {c.label}
                </EmojiTab>
              ))}
            </div>
          )}
          {/* grid */}
          <div
            className="grid grid-cols-8 gap-0.5 max-h-[260px] overflow-y-auto"
          >
            {items.length === 0 ? (
              <div className="col-span-8 text-center text-xs text-muted-foreground py-4">
                {query.trim() ? "검색 결과 없음" : "최근 사용 항목이 없습니다."}
              </div>
            ) : (
              items.map((it) => (
                <button
                  key={it.char + "/" + it.name}
                  type="button"
                  onClick={() => insert(it)}
                  className="h-8 w-8 text-lg rounded hover:bg-muted flex items-center justify-center"
                  title={it.name}
                >
                  {it.char}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </span>
  );
}

function EmojiTab({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "h-7 px-2 -mb-px border-b-2 " +
        (disabled
          ? "border-transparent text-muted-foreground/40 cursor-not-allowed"
          : active
            ? "border-primary text-foreground font-semibold"
            : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
