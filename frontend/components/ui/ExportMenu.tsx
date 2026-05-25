"use client";

import { useEffect, useRef } from "react";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";

export function ExportMenu({
  disabled,
  exporting,
  open,
  onOpenChange,
  onPDF,
  onExcel,
  label = "현황 다운로드",
  title,
}: {
  disabled: boolean;
  exporting: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPDF: () => void;
  onExcel: () => void;
  label?: string;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={ref}>
      <Tooltip label={title} side="bottom">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
          className="h-8 rounded-md border border-border bg-card shadow-sm px-3 text-xs hover:bg-muted disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Download className="h-3.5 w-3.5" />
          {exporting ? "생성 중..." : label}
          <span className="text-muted-foreground">▾</span>
        </button>
      </Tooltip>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onMouseDown={() => onOpenChange(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-40 rounded-md border border-border bg-card shadow-md">
            <button
              type="button"
              onClick={onPDF}
              className="inline-flex items-center gap-1 w-full px-3 py-2 text-left text-xs hover:bg-muted"
            >
              <FileText className="h-3.5 w-3.5" />
              PDF
            </button>
            <button
              type="button"
              onClick={onExcel}
              className="inline-flex items-center gap-1 w-full px-3 py-2 text-left text-xs hover:bg-muted"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Excel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
