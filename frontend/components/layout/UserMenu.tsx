"use client";

import { useEffect, useState } from "react";
import {
  ChevronUp,
  FileText,
  KeyRound,
  MapPin,
  Phone,
  StickyNote,
  Users,
} from "lucide-react";
import clsx from "clsx";
import { ChangePasswordDialog } from "@/components/layout/profile-dialogs/ChangePasswordDialog";
import { ChangePhoneDialog } from "@/components/layout/profile-dialogs/ChangePhoneDialog";
import { ChangeAddressDialog } from "@/components/layout/profile-dialogs/ChangeAddressDialog";
import { ChangeEmergencyContactDialog } from "@/components/layout/profile-dialogs/ChangeEmergencyContactDialog";
import { ChangeResumeDialog } from "@/components/layout/profile-dialogs/ChangeResumeDialog";
import { ChangePassportDialog } from "@/components/layout/profile-dialogs/ChangePassportDialog";

type DialogKey =
  | null
  | "password"
  | "phone"
  | "address"
  | "emergency"
  | "resume"
  | "passport";

export function UserMenu({
  collapsed,
  initial,
  name,
  role,
  developerId,
}: {
  collapsed: boolean;
  initial: string;
  name: string;
  role: string;
  /** null 이면 비밀번호 변경만 노출 (임직원 매핑이 없는 계정). */
  developerId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKey>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function pick(key: Exclude<DialogKey, null>) {
    setOpen(false);
    setDialog(key);
  }

  const hasDeveloper = !!developerId;

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={clsx(
            "group/item relative w-full inline-flex items-center rounded-md transition-colors",
            collapsed
              ? "justify-center h-8 w-8 mx-auto"
              : "gap-2 px-1 py-1 hover:bg-sidebar-accent/60",
          )}
        >
          {collapsed ? (
            <>
              <div className="h-8 w-8 rounded-full bg-sidebar-accent grid place-items-center text-xs font-semibold">
                {initial}
              </div>
              <TooltipBubble label={`${name}${role ? ` · ${role}` : ""}`} />
            </>
          ) : (
            <>
              <div className="h-7 w-7 rounded-full bg-sidebar-accent grid place-items-center text-xs font-semibold">
                {initial}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm text-sidebar-accent-foreground">
                  {name}
                </div>
                <div className="truncate text-[11px] text-sidebar-muted">
                  {role}
                </div>
              </div>
              <ChevronUp
                className={clsx(
                  "h-3.5 w-3.5 text-sidebar-muted transition-transform",
                  !open && "rotate-180",
                )}
              />
            </>
          )}
        </button>

        {open && (
          <>
            <div
              className="fixed inset-0 z-40"
              onMouseDown={() => setOpen(false)}
            />
            <div
              role="menu"
              className={clsx(
                // text-foreground 명시 — 사이드바 부모의 text-sidebar-foreground(흰색)
                // 상속으로 흰 배경 위에 흰 글씨가 되는 문제 차단.
                "absolute z-50 mb-1 w-48 rounded-md border border-border bg-card text-foreground shadow-md py-1",
                collapsed
                  ? "left-full bottom-0 ml-1"
                  : "left-0 right-0 bottom-full",
              )}
            >
              <MenuButton
                icon={<KeyRound className="h-3.5 w-3.5" />}
                label="비밀번호 변경"
                onClick={() => pick("password")}
              />
              {hasDeveloper && (
                <>
                  <MenuButton
                    icon={<Phone className="h-3.5 w-3.5" />}
                    label="전화번호 변경"
                    onClick={() => pick("phone")}
                  />
                  <MenuButton
                    icon={<MapPin className="h-3.5 w-3.5" />}
                    label="주소 변경"
                    onClick={() => pick("address")}
                  />
                  <MenuButton
                    icon={<Users className="h-3.5 w-3.5" />}
                    label="비상연락처 변경"
                    onClick={() => pick("emergency")}
                  />
                  <MenuButton
                    icon={<FileText className="h-3.5 w-3.5" />}
                    label="이력서 변경"
                    onClick={() => pick("resume")}
                  />
                  <MenuButton
                    icon={<StickyNote className="h-3.5 w-3.5" />}
                    label="여권정보 변경"
                    onClick={() => pick("passport")}
                  />
                </>
              )}
            </div>
          </>
        )}
      </div>

      <ChangePasswordDialog
        open={dialog === "password"}
        onClose={() => setDialog(null)}
      />
      {hasDeveloper && (
        <>
          <ChangePhoneDialog
            open={dialog === "phone"}
            onClose={() => setDialog(null)}
          />
          <ChangeAddressDialog
            open={dialog === "address"}
            onClose={() => setDialog(null)}
          />
          <ChangeEmergencyContactDialog
            open={dialog === "emergency"}
            onClose={() => setDialog(null)}
            developerId={developerId}
          />
          <ChangeResumeDialog
            open={dialog === "resume"}
            onClose={() => setDialog(null)}
            developerId={developerId}
          />
          <ChangePassportDialog
            open={dialog === "passport"}
            onClose={() => setDialog(null)}
            developerId={developerId}
          />
        </>
      )}
    </>
  );
}

/** Sidebar.tsx 의 TooltipBubble 과 동일 — 접힌 사이드바에서 hover 즉시 노출. */
function TooltipBubble({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className={clsx(
        "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2",
        "px-2.5 py-1 rounded-md whitespace-nowrap",
        "bg-popover text-popover-foreground",
        "text-sm font-medium",
        "border border-border shadow-md",
        "opacity-0 translate-x-[-2px] transition-all duration-100",
        "group-hover/item:opacity-100 group-hover/item:translate-x-0",
        "group-focus-visible/item:opacity-100 group-focus-visible/item:translate-x-0",
        "z-50",
      )}
    >
      {label}
    </span>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="inline-flex items-center gap-2 w-full px-3 py-2 text-left text-xs hover:bg-muted"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
