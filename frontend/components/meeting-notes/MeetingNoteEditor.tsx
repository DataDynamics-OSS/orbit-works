"use client";

/**
 * BlockNote 기반 회의록 본문 에디터.
 *
 * - 5초 디바운스 autosave (props.onSave) 로 body(JSON) + plain_text 전송.
 * - 이미지 클립보드 붙여넣기는 base64 data URL 로 본문에 임베드 (P1 단순화).
 *   업로드 기반 URL 전환은 P2 협업 도입 시 같이 처리.
 *
 * SSR 회피: BlockNote(ProseMirror) 는 브라우저 전용이라 페이지에서는
 * `next/dynamic` 으로 ssr: false 동적 import 한다.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Sigma, Smile } from "lucide-react";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  filterSuggestionItems,
  type Block,
  type PartialBlock,
} from "@blocknote/core";
import { ko } from "@blocknote/core/locales";
import { codeBlockOptions } from "@blocknote/code-block";
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { offset, flip, shift, size } from "@floating-ui/react";
import { MeetingNoteToolbar } from "./MeetingNoteToolbar";
import { SpecialCharPickerDialog } from "./SpecialCharPickerDialog";
import { EmojiPickerDialog } from "./EmojiPickerDialog";
// @blocknote/core/fonts/inter.css 는 의도적으로 import 하지 않는다 — 그 CSS 가
// .bn-editor 에 Inter 글꼴을 강제해 본문이 페이지 글꼴(Pretendard) 과 어긋난다.
// 대신 meeting-note-editor.css 에서 font-family 를 페이지 stack 으로 통일.
import "@blocknote/mantine/style.css";
import "./meeting-note-editor.css";
import { compressImageToDataUrl } from "@/lib/image-compress";

// codeBlock 을 supportedLanguages + Shiki highlighter 옵션과 함께 재정의한
// 커스텀 schema. BlockNote v0.49 의 BlockNoteEditorOptions 에는 codeBlock 옵션이
// 없어 useCreateBlockNote 에 직접 전달해도 무시되므로 schema 단계에서 교체한다.
const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
  },
});

import type { MutableRefObject } from "react";

type Props = {
  initialBody: string | null;
  readOnly?: boolean;
  onSave: (body: string, plainText: string) => Promise<void> | void;
  /** autosave 디바운스 (ms). 기본 5000. */
  debounceMs?: number;
  /** 부모가 즉시 저장(저장 버튼 클릭 등) 을 트리거할 수 있도록 노출하는 ref.
   * 마운트 시 `current` 에 flush 함수가 채워지고, 언마운트 시 null. */
  saveRef?: MutableRefObject<(() => Promise<void>) | null>;
  /** 부모가 현재 본문을 HTML 로 export 할 수 있게 노출하는 ref.
   * 회의록 이메일 발송 시 BlockNote 의 blocksToHTMLLossy 호출. */
  htmlRef?: MutableRefObject<(() => Promise<string>) | null>;
  /** TOC 사이드 패널이 구독하는 heading 목록 콜백.
   *  document 가 바뀔 때마다 (마운트 + onChange) 호출. */
  onHeadingsChange?: (items: TocItem[]) => void;
};

export type TocItem = { id: string; level: number; text: string };

// BlockNote inline content → 평문 텍스트 (TOC 라벨 용).
function inlineContentToText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (c?.text) parts.push(c.text);
  }
  return parts.join("").trim();
}

function parseInitial(body: string | null): PartialBlock[] | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function blocksToPlainText(blocks: Block[]): string {
  // 단순 traversal — table/heading/paragraph/list 모두 inlineContent 텍스트만 추출.
  const out: string[] = [];
  const walk = (node: any): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (node.type === "text" && typeof node.text === "string") {
      out.push(node.text);
      return;
    }
    if (node.content) walk(node.content);
    if (node.children) walk(node.children);
  };
  walk(blocks);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

export function MeetingNoteEditor({
  initialBody,
  readOnly,
  onSave,
  debounceMs = 5000,
  saveRef,
  htmlRef,
  onHeadingsChange,
}: Props) {
  const initial = useMemo(() => parseInitial(initialBody), [initialBody]);

  // 특수부호 / 이모지 picker 다이얼로그 열림 상태.
  const [charOpen, setCharOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // - 이미지 paste : base64 data URL 로 본문에 임베드 (P1 단순화)
  // - 코드 블록    : 위 schema 를 통해 @blocknote/code-block 의 Shiki highlighter 적용
  //   (좌상단 select 로 언어 변경, 50+ 언어 지원).
  const editor = useCreateBlockNote({
    schema,
    // 한국어 로케일 — slash menu, table 핸들 메뉴("헤더 행/열로 전환"), drag handle
    // 등 UI 라벨이 한국어로 노출되어 발견성·사용성이 올라간다.
    dictionary: ko,
    initialContent: initial as PartialBlock<typeof schema.blockSchema>[] | undefined,
    // Chrome 의 한글 맞춤법 검사가 본문 전체에 빨간 줄을 그어 가독성을 해친다.
    // ProseMirror 루트(.bn-editor) 에 spellcheck="false" 를 내려 비활성화.
    domAttributes: { editor: { spellcheck: "false" } },
    uploadFile: async (file: File) => {
      // 본문 임베드 이미지 — 페이지 폭에 맞춰 1600px / JPEG q0.85 로 압축.
      // 원본 5MB 스크린샷이 ~150-300KB 로 줄어 저장(PATCH body) 이 빨라진다.
      return compressImageToDataUrl(file, { maxDim: 1600, quality: 0.85 });
    },
  }) as unknown as BlockNoteEditor;

  // picker 가 텍스트(특수부호) 반환 시 현재 커서 위치에 inline content 로 삽입.
  function insertText(text: string) {
    if (!text) return;
    try {
      editor.insertInlineContent(text);
    } catch {
      /* 비정상 상태 무시 */
    }
    setTimeout(() => editor.focus(), 0);
  }

  // autosave — 변경 감지 후 debounceMs 지난 뒤 1회 발송.
  const saveTimer = useRef<number | null>(null);
  const lastSerialized = useRef<string | null>(null);

  // 즉시 저장 (debounce 무시). Ctrl/Cmd+S 핸들러와 onChange 디바운스 양쪽에서
  // 사용. ref 로 관리해 useEffect 의존성을 늘리지 않는다.
  const flushSaveRef = useRef<() => Promise<void>>(async () => {});
  flushSaveRef.current = async () => {
    if (readOnly) return;
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const blocks = editor.document;
    const json = JSON.stringify(blocks);
    if (json === lastSerialized.current) return;
    const plain = blocksToPlainText(blocks);
    lastSerialized.current = json;
    try {
      await onSave(json, plain);
    } catch {
      lastSerialized.current = null;
    }
  };

  useEffect(() => {
    if (readOnly) return;
    const handle = () => {
      const blocks = editor.document;
      const json = JSON.stringify(blocks);
      if (json === lastSerialized.current) return;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        lastSerialized.current = json;
        const plain = blocksToPlainText(blocks);
        try {
          await onSave(json, plain);
        } catch {
          // 실패해도 다음 변경 때 다시 시도.
          lastSerialized.current = null;
        }
      }, debounceMs);
    };
    const off = editor.onChange(handle);
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      if (typeof off === "function") off();
    };
  }, [editor, readOnly, onSave, debounceMs]);

  // 부모(상세 페이지의 "저장" 버튼) 가 즉시 저장을 호출할 수 있도록 ref 노출.
  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = () => flushSaveRef.current();
    return () => {
      saveRef.current = null;
    };
  }, [saveRef]);

  // 부모가 본문을 HTML 로 export — 이메일 발송 등.
  useEffect(() => {
    if (!htmlRef) return;
    htmlRef.current = async () => {
      try {
        return await editor.blocksToHTMLLossy(editor.document);
      } catch {
        return "";
      }
    };
    return () => {
      htmlRef.current = null;
    };
  }, [editor, htmlRef]);

  // 편집 모드에서 본문 안의 <a> 클릭 시 자동 navigate 되면 hover 툴바 사용이
  // 어렵다. BlockNote 의 ProseMirror plugin (clickHandler.ts) 이 view.dom 의
  // click 이벤트에서 직접 window.open 을 호출하므로, wrapper-level capture 만으로는
  // 이미 너무 늦다 (이벤트가 view.dom 도달 전에 멈춰야 함). document 캡처에
  // mousedown/click 양쪽을 걸어 ProseMirror plugin 보다 먼저 가로챈다.
  //
  // 대상: BlockNote 가 본문에 렌더한 인라인 링크 — `a[data-inline-content-type="link"]`.
  // 다른 일반 링크 (헤더·메뉴 등) 는 정상 동작.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (readOnly) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.(
        'a[data-inline-content-type="link"]',
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      // Cmd/Ctrl-click 으로 새 탭을 직접 열고자 하는 의도는 허용.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    document.addEventListener("mousedown", handler, true);
    document.addEventListener("click", handler, true);
    document.addEventListener("auxclick", handler, true);
    return () => {
      document.removeEventListener("mousedown", handler, true);
      document.removeEventListener("click", handler, true);
      document.removeEventListener("auxclick", handler, true);
    };
  }, [readOnly]);

  // 사이드 TOC 구독 — heading 블록만 추려서 부모에 전달. mount + onChange.
  useEffect(() => {
    if (!onHeadingsChange) return;
    const compute = () => {
      const items: TocItem[] = [];
      for (const b of editor.document) {
        if ((b as any).type === "heading") {
          const level = Number((b as any).props?.level ?? 1);
          const text = inlineContentToText((b as any).content);
          items.push({ id: String((b as any).id), level, text });
        }
      }
      onHeadingsChange(items);
    };
    compute();
    const off = editor.onChange(compute);
    return () => {
      if (typeof off === "function") off();
    };
  }, [editor, onHeadingsChange]);

  return (
    <div className="mn-bn-root" ref={rootRef}>
      {!readOnly && (
        <MeetingNoteToolbar
          editor={editor}
          onOpenSpecialChar={() => setCharOpen(true)}
          onOpenEmoji={() => setEmojiOpen(true)}
        />
      )}
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme="light"
        slashMenu={false}
      >
        {/* `/특수부호` 슬래시 메뉴 추가. 기본 항목 + 우리 1개.
            placement 을 "top-start" 로 두어 슬래시 메뉴가 cursor **위쪽** 으로
            펼쳐진다 (페이지 맨 아래에서도 위쪽 viewport 가 충분해 모든 항목
            노출). cursor 가 페이지 상단이라 위쪽 공간이 부족하면 flip 이
            bottom-start 로 자동 전환. */}
        <SuggestionMenuController
          triggerCharacter="/"
          floatingUIOptions={{
            useFloatingOptions: {
              placement: "top-start",
              middleware: [
                offset(10),
                flip({
                  fallbackPlacements: ["bottom-start"],
                  padding: 10,
                }),
                shift({ padding: 10 }),
                size({
                  apply({ availableHeight, elements }) {
                    elements.floating.style.maxHeight = `${Math.max(
                      0,
                      availableHeight,
                    )}px`;
                  },
                  padding: 10,
                }),
              ],
            },
          }}
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                {
                  title: "특수부호",
                  subtext: "특수문자 picker 열기",
                  aliases: ["special", "symbol", "기호", "특수문자"],
                  group: "기타",
                  icon: <Sigma className="h-4 w-4" />,
                  onItemClick: () => setCharOpen(true),
                },
                {
                  title: "이모지",
                  subtext: "이모지 picker 열기",
                  aliases: ["emoji", "이모티콘", "emo"],
                  group: "기타",
                  icon: <Smile className="h-4 w-4" />,
                  onItemClick: () => setEmojiOpen(true),
                },
              ],
              query,
            )
          }
        />
      </BlockNoteView>
      <SpecialCharPickerDialog
        open={charOpen}
        onClose={() => setCharOpen(false)}
        onSelect={insertText}
      />
      <EmojiPickerDialog
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onSelect={insertText}
      />
    </div>
  );
}
