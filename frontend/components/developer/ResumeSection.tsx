"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { DateInput } from "@/components/ui/DateInput";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { useDialog } from "@/components/ui/DialogProvider";
import { SavedAtLabel } from "@/components/ui/SavedAtLabel";
import {
  type ResumeBundle,
  type ResumeCertification,
  type ResumeExperience,
  downloadResumePdf,
  downloadResumeXlsx,
} from "@/lib/resume-export";

export function ResumeSection({ developerId }: { developerId: string }) {
  const { data: bundle, isLoading } = useQuery<ResumeBundle>({
    queryKey: ["developer-resume", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/resume`)).data,
  });

  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (isLoading || !bundle) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">
        이력서 로딩 중...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">이력서</h2>
        <ExportMenu
          disabled={exporting}
          exporting={exporting}
          open={exportOpen}
          onOpenChange={setExportOpen}
          label="이력서 다운로드"
          onPDF={async () => {
            setExportOpen(false);
            setExporting(true);
            try {
              await downloadResumePdf(bundle);
            } finally {
              setExporting(false);
            }
          }}
          onExcel={() => {
            setExportOpen(false);
            downloadResumeXlsx(bundle);
          }}
        />
      </div>

      <ProfileCard developerId={developerId} bundle={bundle} />
      <CertificationsCard developerId={developerId} bundle={bundle} />
      <ExperiencesCard developerId={developerId} bundle={bundle} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 기본정보 (profile)
// ---------------------------------------------------------------------------

function ProfileCard({
  developerId,
  bundle,
}: {
  developerId: string;
  bundle: ResumeBundle;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const p = bundle.profile;
  const [form, setForm] = useState({
    birth_date: p?.birth_date ?? "",
    school: p?.school ?? "",
    major: p?.major ?? "",
    graduation_year:
      p?.graduation_year != null ? String(p.graduation_year) : "",
  });

  useEffect(() => {
    setForm({
      birth_date: p?.birth_date ?? "",
      school: p?.school ?? "",
      major: p?.major ?? "",
      graduation_year:
        p?.graduation_year != null ? String(p.graduation_year) : "",
    });
  }, [p?.birth_date, p?.school, p?.major, p?.graduation_year]);

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        birth_date: form.birth_date || null,
        school: form.school.trim() || null,
        major: form.major.trim() || null,
        graduation_year: form.graduation_year
          ? Number(form.graduation_year)
          : null,
      };
      return (
        await api.put(`/developers/${developerId}/resume/profile`, payload)
      ).data;
    },
    onSuccess: () => {
      setSavedAt(new Date());
      qc.invalidateQueries({ queryKey: ["developer-resume", developerId] });
    },
    onError: (e: any) =>
      dialog.alert(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "저장 실패",
      ),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">기본정보</h3>
        <div className="flex items-center gap-2">
          <SavedAtLabel at={savedAt} />
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={saveM.isPending}
            className="h-7 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
          >
            {saveM.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Row label="이름">
          <span className="font-semibold">{bundle.name}</span>
        </Row>
        <Row label="생년월일">
          <DateInput
            value={form.birth_date}
            onChange={(v) => setForm((p) => ({ ...p, birth_date: v }))}
          />
        </Row>
        <Row label="학교">
          <input
            type="text"
            value={form.school}
            onChange={(e) => setForm((p) => ({ ...p, school: e.target.value }))}
            placeholder="예: 서울대학교"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </Row>
        <Row label="학과">
          <input
            type="text"
            value={form.major}
            onChange={(e) => setForm((p) => ({ ...p, major: e.target.value }))}
            placeholder="예: 컴퓨터공학"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </Row>
        <Row label="졸업년도">
          <input
            type="number"
            value={form.graduation_year}
            onChange={(e) =>
              setForm((p) => ({ ...p, graduation_year: e.target.value }))
            }
            min={1900}
            max={2100}
            placeholder="예: 2014"
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </Row>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 자격증 (certifications) — 전체 교체
// ---------------------------------------------------------------------------

type CertDraft = {
  key: string; // 로컬 식별자 (id 있으면 id, 없으면 임시)
  name: string;
  issuer: string;
  acquired_on: string;
};

function toDraft(c: ResumeCertification | null): CertDraft {
  return {
    key: c ? c.id : `new-${Math.random().toString(36).slice(2)}`,
    name: c?.name ?? "",
    issuer: c?.issuer ?? "",
    acquired_on: c?.acquired_on ?? "",
  };
}

function CertificationsCard({
  developerId,
  bundle,
}: {
  developerId: string;
  bundle: ResumeBundle;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [drafts, setDrafts] = useState<CertDraft[]>(() =>
    bundle.certifications.map((c) => toDraft(c)),
  );

  useEffect(() => {
    setDrafts(bundle.certifications.map((c) => toDraft(c)));
  }, [bundle.certifications]);

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saveM = useMutation({
    mutationFn: async () => {
      const payload = drafts
        .filter((d) => d.name.trim())
        .map((d) => ({
          name: d.name.trim(),
          issuer: d.issuer.trim() || null,
          acquired_on: d.acquired_on || null,
        }));
      return (
        await api.put(
          `/developers/${developerId}/resume/certifications`,
          payload,
        )
      ).data;
    },
    onSuccess: () => {
      setSavedAt(new Date());
      qc.invalidateQueries({ queryKey: ["developer-resume", developerId] });
    },
    onError: (e: any) =>
      dialog.alert(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "저장 실패",
      ),
  });

  function updateAt(i: number, patch: Partial<CertDraft>) {
    setDrafts((arr) =>
      arr.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );
  }

  function add() {
    setDrafts((arr) => [...arr, toDraft(null)]);
  }

  function removeAt(i: number) {
    setDrafts((arr) => arr.filter((_, idx) => idx !== i));
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">자격증</h3>
        <div className="flex items-center gap-2">
          <SavedAtLabel at={savedAt} />
          <button
            type="button"
            onClick={add}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" />행 추가
          </button>
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={saveM.isPending}
            className="h-7 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
          >
            {saveM.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>

      {drafts.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted-foreground">
          자격증이 없습니다. 우측 상단의 '행 추가' 로 입력하세요.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">자격증명</th>
              <th className="py-2 font-medium">발급기관</th>
              <th className="py-2 font-medium w-36">취득일</th>
              <th className="py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => (
              <tr key={d.key} className="border-b border-border/60">
                <td className="py-1.5 pr-2">
                  <input
                    type="text"
                    value={d.name}
                    onChange={(e) => updateAt(i, { name: e.target.value })}
                    placeholder="예: 정보처리기사"
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  />
                </td>
                <td className="py-1.5 pr-2">
                  <input
                    type="text"
                    value={d.issuer}
                    onChange={(e) => updateAt(i, { issuer: e.target.value })}
                    placeholder="예: 한국산업인력공단"
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  />
                </td>
                <td className="py-1.5 pr-2">
                  <DateInput
                    value={d.acquired_on}
                    onChange={(v) => updateAt(i, { acquired_on: v })}
                  />
                </td>
                <td className="py-1.5">
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted text-destructive"
                    title="삭제"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 이력 (experiences) — 개별 CRUD
// ---------------------------------------------------------------------------

function ExperiencesCard({
  developerId,
  bundle,
}: {
  developerId: string;
  bundle: ResumeBundle;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const createM = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/developers/${developerId}/resume/experiences`, {
          start_date: new Date().toISOString().slice(0, 10),
          end_date: null,
          company: "신규 이력",
          role: "역할",
          description: null,
        })
      ).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["developer-resume", developerId] }),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">이력</h3>
        <button
          type="button"
          onClick={() => createM.mutate()}
          disabled={createM.isPending}
          className="h-7 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />이력 추가
        </button>
      </div>

      {bundle.experiences.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          이력이 없습니다. '이력 추가' 로 새로 생성하세요.
        </div>
      ) : (
        <div className="space-y-3">
          {bundle.experiences.map((e) => (
            <ExperienceCard
              key={e.id}
              developerId={developerId}
              exp={e}
              onRemove={async () => {
                if (
                  await dialog.confirm(
                    `이력 "${e.company}" 을(를) 삭제할까요?`,
                  )
                ) {
                  await api.delete(`/developers/resume/experiences/${e.id}`);
                  qc.invalidateQueries({
                    queryKey: ["developer-resume", developerId],
                  });
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExperienceCard({
  developerId,
  exp,
  onRemove,
}: {
  developerId: string;
  exp: ResumeExperience;
  onRemove: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [form, setForm] = useState({
    start_date: exp.start_date,
    end_date: exp.end_date ?? "",
    company: exp.company,
    role: exp.role,
    description: exp.description ?? "",
  });

  useEffect(() => {
    setForm({
      start_date: exp.start_date,
      end_date: exp.end_date ?? "",
      company: exp.company,
      role: exp.role,
      description: exp.description ?? "",
    });
  }, [exp.start_date, exp.end_date, exp.company, exp.role, exp.description]);

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saveM = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/developers/resume/experiences/${exp.id}`, {
          start_date: form.start_date,
          end_date: form.end_date || null,
          company: form.company.trim(),
          role: form.role.trim(),
          description: form.description.trim() || null,
        })
      ).data,
    onSuccess: () => {
      setSavedAt(new Date());
      qc.invalidateQueries({ queryKey: ["developer-resume", developerId] });
    },
    onError: (e: any) =>
      dialog.alert(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "저장 실패",
      ),
  });

  return (
    <div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 grid grid-cols-2 gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">시작일</span>
            <DateInput
              value={form.start_date}
              onChange={(v) => setForm((p) => ({ ...p, start_date: v }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              종료일 (비우면 '현재')
            </span>
            <DateInput
              value={form.end_date}
              onChange={(v) => setForm((p) => ({ ...p, end_date: v }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">기업/프로젝트</span>
            <input
              type="text"
              value={form.company}
              onChange={(e) =>
                setForm((p) => ({ ...p, company: e.target.value }))
              }
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">역할</span>
            <input
              type="text"
              value={form.role}
              onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-xs text-muted-foreground">설명 (선택)</span>
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              rows={2}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted text-destructive shrink-0"
          title="삭제"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <SavedAtLabel at={savedAt} />
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={saveM.isPending}
          className="h-7 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
        >
          {saveM.isPending ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  );
}
