"use client";

/**
 * 회의록 본문 편집기 — 게시판과 동일한 TipTap(HTML) 편집기를 재사용한다.
 *
 * 과거엔 BlockNote(JSON) 였으나 "표 셀 안에서 목록·번호매기기·정렬 미지원" 등
 * 구조적 한계가 있어, 게시판의 `TipTapEditor` 로 교체했다. 회의록 페이지·백엔드는
 * 수정하지 않도록 props 계약(initialBody / onSave / saveRef / htmlRef /
 * onHeadingsChange / TocItem)을 그대로 유지한다.
 *
 * - 저장 형식: TipTap **HTML** 문자열 (+ plain text). PATCH /meeting-notes/{id}/body.
 * - 기존 BlockNote JSON 본문은 로드 시 `blockNoteJsonToHtml` 로 자동 변환(best-effort)
 *   해 그대로 보여주고, 사용자가 편집·저장하면 HTML 로 영구 전환된다.
 * - 목차(TOC): 편집기 DOM 의 h1~h3 에 id 를 부여해 TocItem 을 만든다. 기존
 *   `MeetingNoteToc` 의 `getElementById(id)` 스크롤이 그대로 동작한다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { TipTapEditor } from "@/components/board/TipTapEditor";
import { blockNoteJsonToHtml, escapeHtml } from "./blocknote-to-html";

/** 사이드 목차(TOC) 항목. MeetingNoteToc 가 import 해 사용. */
export type TocItem = { id: string; level: number; text: string };

type Props = {
  /** 저장된 본문. HTML 또는 (레거시) BlockNote JSON 문자열, 신규는 null. */
  initialBody: string | null;
  readOnly?: boolean;
  /** body(HTML) + plainText 를 받아 서버에 저장. */
  onSave: (body: string, plainText: string) => Promise<void> | void;
  /** autosave 디바운스 (ms). 기본 5000. */
  debounceMs?: number;
  /** 즉시 저장 함수를 부모에 노출 (Ctrl+S / 저장 버튼 / 탭 전환). */
  saveRef?: MutableRefObject<(() => Promise<void>) | null>;
  /** 현재 본문 HTML 을 반환 (이메일 발송 / PDF export). */
  htmlRef?: MutableRefObject<(() => Promise<string>) | null>;
  /** heading 목록 변경 콜백 (사이드 TOC). */
  onHeadingsChange?: (items: TocItem[]) => void;
};

// 저장된 본문을 편집기 초기 HTML 로 정규화한다.
// - HTML('<' 시작): 그대로
// - BlockNote JSON('[' / '{' 시작): HTML 로 변환
// - 그 외 평문: 단락으로 감싼다
function toInitialHtml(body: string | null): string {
  if (!body) return "";
  const t = body.trim();
  if (!t) return "";
  if (t.startsWith("<")) return body;
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t);
      return blockNoteJsonToHtml(Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      return `<p>${escapeHtml(body)}</p>`;
    }
  }
  return `<p>${escapeHtml(body)}</p>`;
}

function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (typeof window === "undefined") {
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
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
  const [html, setHtml] = useState<string>(() => toInitialHtml(initialBody));
  const rootRef = useRef<HTMLDivElement>(null);

  // 최신 html 을 ref 로 보관 — saveRef/htmlRef closure 가 항상 최신값을 읽도록.
  const htmlValRef = useRef<string>(html);
  htmlValRef.current = html;

  // autosave 상태. lastSaved 초기값을 현재 html 로 둬서 "편집 없는 단순 열람·탭
  // 전환" 만으로는 서버에 쓰지 않는다 (레거시 JSON 은 실제 편집 시점에 HTML 로 전환).
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string | null>(html);

  const doSave = useCallback(async () => {
    if (readOnly) return;
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const body = htmlValRef.current;
    if (body === lastSaved.current) return;
    const plain = htmlToPlainText(body);
    lastSaved.current = body;
    try {
      await onSave(body, plain);
    } catch {
      // 실패 시 다음 변경 때 재시도하도록 마킹 해제.
      lastSaved.current = null;
    }
  }, [onSave, readOnly]);

  // 부모가 즉시 저장을 호출할 수 있도록 ref 노출.
  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = doSave;
    return () => {
      saveRef.current = null;
    };
  }, [saveRef, doSave]);

  // 부모가 현재 HTML 을 가져갈 수 있도록 ref 노출 (이메일/PDF).
  useEffect(() => {
    if (!htmlRef) return;
    htmlRef.current = async () => htmlValRef.current;
    return () => {
      htmlRef.current = null;
    };
  }, [htmlRef]);

  // 목차(TOC) — 편집기 DOM 의 h1~h3 에 id 를 부여하고 TocItem 을 만든다.
  const recomputeHeadings = useCallback(() => {
    if (!onHeadingsChange) return;
    const root = rootRef.current;
    if (!root) return;
    const els = root.querySelectorAll<HTMLElement>(
      ".tiptap-content h1, .tiptap-content h2, .tiptap-content h3",
    );
    const items: TocItem[] = [];
    els.forEach((el, i) => {
      const id = `mn-h-${i}`;
      el.id = id; // MeetingNoteToc.scrollTo 의 getElementById 와 매칭.
      const level = el.tagName === "H1" ? 1 : el.tagName === "H2" ? 2 : 3;
      items.push({ id, level, text: (el.textContent ?? "").trim() });
    });
    onHeadingsChange(items);
  }, [onHeadingsChange]);

  // 내용 변경 후 목차(heading id) 재계산 — 단, **반드시 디바운스**한다.
  // recomputeHeadings 는 편집기 DOM 의 h1~h3 에 el.id 를 직접 쓰는데, 이는 ProseMirror
  // 가 관리하는 노드라 PM 이 되돌리며(re-render) DOM mutation 폭풍을 일으킨다. 이게
  // 키 입력마다(=IME 조합 중) 일어나면 조합이 깨져 회의록에서만 한글이 중복 입력됐다
  // ("한글"→"ㅎ하한한ㄱ그글글"). delay 0 → setTimeout(clearTimeout) 디바운스로 바꿔,
  // 타이핑이 멈춘 뒤(≈300ms)에만 재계산해 조합 중 편집기 DOM 을 건드리지 않는다.
  // (조합 중 mutation 8→20→8 로 baseline 복귀 확인.)
  useEffect(() => {
    const t = window.setTimeout(recomputeHeadings, 300);
    return () => window.clearTimeout(t);
  }, [html, recomputeHeadings]);

  const handleChange = useCallback(
    (next: string) => {
      htmlValRef.current = next; // 즉시 최신화 (saveRef/htmlRef 가 곧장 읽어도 정확).
      setHtml(next);
      if (readOnly) return;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void doSave();
      }, debounceMs);
    },
    [doSave, debounceMs, readOnly],
  );

  // 언마운트 시 대기 중인 타이머 정리.
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
  }, []);

  return (
    <div ref={rootRef} className="h-full">
      <TipTapEditor
        value={html}
        onChange={handleChange}
        readOnly={readOnly}
        fillHeight
        placeholder="회의 내용을 입력하세요…"
      />
    </div>
  );
}
