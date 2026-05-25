"use client";

/**
 * 주간보고 — Settings 탭. 두 영역으로 나뉨:
 *
 *   1) 양식(Templates) — 매니저용 / 일반용 본문 템플릿. ADMIN 이 TipTap 으로
 *      편집 후 저장. 신규 보고서 lazy create 시 작성자의 매니저 여부에 따라
 *      자동 선택.
 *   2) 지정자(Assignments) — 매주 작성 의무 대상 임직원. 추가/활성·비활성·
 *      종료 주 설정/삭제.
 *
 * 권한: ADMIN/HR (HR 도 지정자 관리는 가능, 양식 수정은 ADMIN 만).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";

import { api } from "@/lib/api";
import { TipTapEditor } from "@/components/board/TipTapEditor";
import { useDialog } from "@/components/ui/DialogProvider";

type TemplateOut = { kind: "MANAGER" | "GENERAL"; body: string };
type TemplatesAll = { manager: TemplateOut; general: TemplateOut };

export function WeeklyReportsSettingsTab() {
  return (
    <div className="space-y-4">
      <TemplatesPanel />
      <AssignmentsPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1) 양식 패널 — 매니저 / 일반 두 개 TipTap.
// ---------------------------------------------------------------------------

function TemplatesPanel() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data } = useQuery<TemplatesAll>({
    queryKey: ["weekly-reports-templates"],
    queryFn: async () => (await api.get("/weekly-reports/templates")).data,
  });

  const [mgrDraft, setMgrDraft] = useState<string>("");
  const [genDraft, setGenDraft] = useState<string>("");
  // 초기 로드 1회 동기화.
  useEffect(() => {
    if (!data) return;
    setMgrDraft(data.manager.body);
    setGenDraft(data.general.body);
  }, [data?.manager.body, data?.general.body]);

  const saveM = useMutation({
    mutationFn: async (input: { kind: "MANAGER" | "GENERAL"; body: string }) =>
      (
        await api.patch(`/weekly-reports/templates/${input.kind}`, {
          body: input.body,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["weekly-reports-templates"] });
      dialog.alert("저장되었습니다.", { title: "양식" });
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <header>
        <h2 className="text-sm font-semibold">주간보고 양식</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          신규 보고서 lazy create 시 자동 선택 — 직속 부하가 1명 이상인 임직원
          은 매니저용, 그 외는 일반용. DB 미설정이면 코드 기본값 fallback.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold">매니저용</h3>
            <button
              type="button"
              onClick={() =>
                saveM.mutate({ kind: "MANAGER", body: mgrDraft })
              }
              disabled={saveM.isPending}
              className="h-7 inline-flex items-center gap-1 rounded-md bg-primary px-2 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              저장
            </button>
          </div>
          <TipTapEditor value={mgrDraft} onChange={setMgrDraft} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold">일반용</h3>
            <button
              type="button"
              onClick={() =>
                saveM.mutate({ kind: "GENERAL", body: genDraft })
              }
              disabled={saveM.isPending}
              className="h-7 inline-flex items-center gap-1 rounded-md bg-primary px-2 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              저장
            </button>
          </div>
          <TipTapEditor value={genDraft} onChange={setGenDraft} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2) 지정자 패널 — 전체 정규직 직원 grid + 등록 토글 (체크박스 1개).
//
// /developers/org-chart 가 ACTIVE FULL_TIME 직원 + rank_name / position_name
// + report_count (직속 부하 수) 를 한 번에 반환 — manager 여부는 report_count
// > 0. 페이징 없이 전체 표시.
// ---------------------------------------------------------------------------

type OrgRow = {
  id: string;
  name: string;
  title: string | null;
  rank_name: string | null;
  position_name: string | null;
  manager_id: string | null;
  report_count: number;
};

function AssignmentsPanel() {
  const { data: devs = [] } = useQuery<OrgRow[]>({
    queryKey: ["developers-org-chart"],
    queryFn: async () => (await api.get("/developers/org-chart")).data,
    staleTime: 5 * 60_000,
  });

  // 표시 정렬: 매니저(부하 1명+) 우선 → 부하 수 내림차순 → 이름 가나다.
  const sortedDevs = useMemo(() => {
    return [...devs].sort((a, b) => {
      const am = a.report_count > 0 ? 0 : 1;
      const bm = b.report_count > 0 ? 0 : 1;
      if (am !== bm) return am - bm;
      if (a.report_count !== b.report_count) return b.report_count - a.report_count;
      return a.name.localeCompare(b.name, "ko-KR");
    });
  }, [devs]);

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <header>
        <h2 className="text-sm font-semibold">
          지정자 (매주 작성 의무)
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {sortedDevs.length} 명
          </span>
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          정규직(FULL_TIME, 재직 중) 전원이 매주 보고서를 작성합니다. 매니저
          여부는 직속 부하(직원의 manager_id 가 본인인 ACTIVE FULL_TIME)
          가 1명 이상인지로 자동 판정.
        </p>
      </header>

      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 sticky top-0 z-10">
            <tr className="text-muted-foreground">
              <th className="text-left px-2 py-1.5 font-medium">이름</th>
              <th className="text-left px-2 py-1.5 font-medium">직위</th>
              <th className="text-left px-2 py-1.5 font-medium">직책</th>
              <th className="text-center px-2 py-1.5 font-medium w-32">관리 대상 임직원수</th>
              <th className="text-center px-2 py-1.5 font-medium w-20">매니저</th>
            </tr>
          </thead>
          <tbody>
            {sortedDevs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground italic">
                  정규직 임직원이 없습니다.
                </td>
              </tr>
            ) : (
              sortedDevs.map((d) => {
                const isManager = d.report_count > 0;
                return (
                  <tr key={d.id} className="border-t border-border/50 hover:bg-muted/20">
                    <td className="px-2 py-1.5 font-medium">{d.name}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {d.rank_name ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {d.position_name ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums">
                      {d.report_count > 0 ? (
                        <span className="font-semibold">{d.report_count}명</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {isManager ? (
                        <span
                          className="inline-flex items-center rounded-full border border-blue-300 bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[10px] font-semibold"
                        >
                          매니저
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
