"use client";

import { useRef, useState } from "react";
import { Paperclip, Upload } from "lucide-react";

type Props = {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  label?: string;
  disabled?: boolean;
  className?: string;
};

export function FileDropZone({
  onFiles,
  multiple = true,
  label = "파일을 여기로 끌어놓거나 클릭해서 선택",
  disabled,
  className = "",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(list: FileList | File[] | null) {
    if (!list) return;
    const arr = Array.from(list);
    if (arr.length === 0) return;
    onFiles(multiple ? arr : arr.slice(0, 1));
  }

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        if (disabled) return;
        handleFiles(e.dataTransfer?.files ?? null);
      }}
      className={
        "flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 cursor-pointer transition-colors " +
        (disabled
          ? "border-border/50 bg-muted/20 cursor-not-allowed opacity-60"
          : dragging
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/10 hover:bg-muted/30") +
        " " +
        className
      }
      role="button"
      aria-disabled={disabled}
    >
      <Upload
        className={
          "h-5 w-5 " +
          (dragging ? "text-primary" : "text-muted-foreground")
        }
      />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-[10px] text-muted-foreground">
        <Paperclip className="inline h-3 w-3 mr-0.5" />
        {multiple ? "여러 파일 동시 선택 가능" : "1개 파일만"}
      </span>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          handleFiles(e.target.files);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </div>
  );
}
