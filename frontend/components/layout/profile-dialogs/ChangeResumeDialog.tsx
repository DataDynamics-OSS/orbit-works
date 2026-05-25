"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { AttachmentsSection } from "@/components/developer/AttachmentsSection";
import { ResumeSection } from "@/components/developer/ResumeSection";

type Tab = "structured" | "files";

export function ChangeResumeDialog({
  open,
  onClose,
  developerId,
}: {
  open: boolean;
  onClose: () => void;
  developerId: string;
}) {
  const [tab, setTab] = useState<Tab>("structured");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="이력서 변경"
      width="max-w-4xl"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
        >
          닫기
        </button>
      }
    >
      <TabBar>
        <TabItem
          active={tab === "structured"}
          onClick={() => setTab("structured")}
        >
          구조화 이력서
        </TabItem>
        <TabItem active={tab === "files"} onClick={() => setTab("files")}>
          첨부 파일
        </TabItem>
      </TabBar>
      <div className="pt-3">
        {tab === "structured" ? (
          <ResumeSection developerId={developerId} />
        ) : (
          <AttachmentsSection developerId={developerId} />
        )}
      </div>
    </Dialog>
  );
}
