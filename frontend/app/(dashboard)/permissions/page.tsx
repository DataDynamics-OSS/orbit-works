"use client";

/**
 * 권한 관리 — 메뉴/기능 권한(역할별 매트릭스) + 사용자별 추가 메뉴/추가 권한
 * + 결재선·보안등급(임직원 picker).
 *
 * 사이드바 그룹: '관리' (설정과 같은 그룹). menu_key: `permissions`.
 * 기본 가시 role: ADMIN / HR (menu_permissions seed).
 *
 * 탭 구성:
 *   1) 메뉴 권한 (역할)   — role × menu 매트릭스. ADMIN 만 편집 (HR 등은 읽기).
 *   2) 기능 권한 (역할)   — role × feature 매트릭스. ADMIN 만 편집.
 *   3) 사용자별 추가 메뉴 — 정규직(FULL_TIME ACTIVE) × menu 일괄 매트릭스. ADMIN/HR.
 *   4) 사용자별 추가 권한 — 정규직 × feature 일괄 매트릭스. ADMIN 만.
 *   5) 결재선·보안등급    — 임직원 picker + 보안등급/연차 승인자/결재선 편집. ADMIN/HR.
 *      임직원 상세에서 옮겨온 세 섹션을 한 화면에서 관리.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { MenuPermissionsCard } from "@/components/permissions/MenuPermissionsCard";
import { FeaturePermissionsCard } from "@/components/permissions/FeaturePermissionsCard";
import { UserMenuGrantsMatrix } from "@/components/permissions/UserMenuGrantsMatrix";
import { UserFeatureGrantsMatrix } from "@/components/permissions/UserFeatureGrantsMatrix";
import { SecurityRoleSection } from "@/components/permissions/SecurityRoleSection";
import { LeaveApproversSection } from "@/components/permissions/LeaveApproversSection";
import { ManagerEditCard } from "@/components/permissions/ManagerEditCard";

type Tab =
  | "menus"
  | "features"
  | "user_menus"
  | "user_features"
  | "approval_security";

type DeveloperRow = {
  id: string;
  name: string;
  manager_id: string | null;
  status: string;
  employment_type: string;
};

export default function PermissionsPage() {
  const [tab, setTab] = useState<Tab>("menus");

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });

  const isAdmin = me?.role === "ADMIN" || me?.role === "SUPER_ADMIN";
  const isHr = me?.role === "HR";

  return (
    <>
      <DashboardHeader title="권한 관리" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto">
        <TabBar>
          {/* role 기반 매트릭스는 ADMIN 전용. HR 은 사용자별 grant 만 보임. */}
          {isAdmin && (
            <TabItem active={tab === "menus"} onClick={() => setTab("menus")}>
              메뉴 권한 (역할)
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "features"} onClick={() => setTab("features")}>
              기능 권한 (역할)
            </TabItem>
          )}
          <TabItem
            active={tab === "user_menus"}
            onClick={() => setTab("user_menus")}
          >
            사용자별 추가 메뉴
          </TabItem>
          {isAdmin && (
            <TabItem
              active={tab === "user_features"}
              onClick={() => setTab("user_features")}
            >
              사용자별 추가 권한
            </TabItem>
          )}
          <TabItem
            active={tab === "approval_security"}
            onClick={() => setTab("approval_security")}
          >
            결재선·보안등급
          </TabItem>
        </TabBar>

        {tab === "menus" && isAdmin && <MenuPermissionsCard />}
        {tab === "features" && isAdmin && <FeaturePermissionsCard />}
        {tab === "user_menus" && (isAdmin || isHr) && <UserMenuGrantsMatrix />}
        {tab === "user_features" && isAdmin && <UserFeatureGrantsMatrix />}
        {tab === "approval_security" && (isAdmin || isHr) && (
          <ApprovalSecurityTab canEdit={isAdmin || isHr} />
        )}
      </div>
    </>
  );
}


// 결재선·보안등급 탭 — 임직원 picker + 3개 섹션 (보안등급 / 연차 승인자 / 결재선).
function ApprovalSecurityTab({ canEdit }: { canEdit: boolean }) {
  const [developerId, setDeveloperId] = useState<string>("");

  const { data: developers = [] } = useQuery<DeveloperRow[]>({
    queryKey: ["developers", "list", "permissions"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: {
            employment_type: "FULL_TIME",
            status_filter: "ACTIVE",
          },
        })
      ).data,
    staleTime: 60_000,
  });

  const sorted = useMemo(
    () =>
      developers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "ko-KR")),
    [developers],
  );

  const selected = sorted.find((d) => d.id === developerId);

  return (
    <div className="space-y-3 max-w-4xl">
      <div className="rounded-md border border-border bg-card p-3 flex items-center gap-3">
        <label htmlFor="approval-sec-picker" className="text-sm font-medium shrink-0">
          임직원
        </label>
        <select
          id="approval-sec-picker"
          value={developerId}
          onChange={(e) => setDeveloperId(e.target.value)}
          className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">선택하세요…</option>
          {sorted.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {!selected ? (
        <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          편집할 임직원을 선택하세요.
        </div>
      ) : (
        <div className="space-y-3">
          <SecurityRoleSection developerId={selected.id} />
          <LeaveApproversSection developerId={selected.id} />
          <ManagerEditCard
            developerId={selected.id}
            currentManagerId={selected.manager_id ?? null}
            canEdit={canEdit}
          />
        </div>
      )}
    </div>
  );
}
