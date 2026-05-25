"use client";

import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${width} max-h-[90vh] flex flex-col rounded-lg border border-border bg-card text-foreground shadow-lg`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* 본문만 세로 스크롤 — 헤더/푸터는 항상 보이도록 고정. overflow-x-hidden 은
            세로 스크롤바가 차지하는 폭 때문에 자식이 가로로 밀려 의도치 않은
            가로 스크롤이 생기는 현상 방지. 콘텐츠는 늘 width 에 맞춰 설계됨. */}
        <div className="p-4 space-y-2 overflow-y-auto overflow-x-hidden">
          {children}
        </div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 shrink-0">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
