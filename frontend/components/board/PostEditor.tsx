"use client";

/**
 * 게시판/공지 글 작성 에디터 — 제목·고정·관리자전용 + TipTap 리치 에디터 본문.
 *
 * 본문은 TipTap (HTML 저장). 기존 마크다운 게시글은 뷰어에서 자동 감지해
 * PostMarkdown(legacy) 으로 fallback 렌더 — 마이그레이션 없이 호환 유지.
 */

import { Lock, Pin } from "lucide-react";
import { TipTapEditor } from "@/components/board/TipTapEditor";
import { PostMarkdown } from "@/components/ui/MarkdownInput";

// PostMarkdown 는 기존 import 경로 호환을 위해 re-export.
export { PostMarkdown };

type Props = {
  title: string;
  content: string;
  isPinned: boolean;
  adminOnly?: boolean;
  onTitleChange: (v: string) => void;
  onContentChange: (v: string) => void;
  onPinnedChange: (v: boolean) => void;
  onAdminOnlyChange?: (v: boolean) => void;
};

export function PostEditor({
  title,
  content,
  isPinned,
  adminOnly,
  onTitleChange,
  onContentChange,
  onPinnedChange,
  onAdminOnlyChange,
}: Props) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-center flex-wrap">
        <label className="flex-1 min-w-[240px]">
          <input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="제목"
            className={input + " text-base font-semibold"}
            maxLength={500}
          />
        </label>
        <label className="inline-flex items-center gap-1 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPinned}
            onChange={(e) => onPinnedChange(e.target.checked)}
          />
          <Pin className="h-3.5 w-3.5 text-amber-600" />
          고정 글
        </label>
        {onAdminOnlyChange && (
          <label
            className="inline-flex items-center gap-1 text-sm cursor-pointer select-none"
            title="체크 시 HR · ADMIN 만 볼 수 있습니다"
          >
            <input
              type="checkbox"
              checked={!!adminOnly}
              onChange={(e) => onAdminOnlyChange(e.target.checked)}
            />
            <Lock className="h-3.5 w-3.5 text-purple-600" />
            관리자만 보기
          </label>
        )}
      </div>

      <TipTapEditor
        value={content}
        onChange={onContentChange}
        placeholder="내용을 입력하세요..."
      />
    </div>
  );
}
