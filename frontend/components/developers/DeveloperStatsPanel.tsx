"use client";

/**
 * 임직원 페이지 — 정규직 지표 패널.
 *
 * sidebar > 임직원 화면의 검색 input 위에 collapsible 카드 묶음.
 * 카드 디자인은 대시보드(`PersonalCards`)의 KpiTile / CardShell 과 동일한
 * 톤(`rounded-lg border bg-card shadow-sm`, 헤더 `text-sm font-semibold` +
 * 아이콘, KPI 값 `text-2xl font-bold`).
 *
 * 7개 지표를 정규직(FULL_TIME, 재직 중) 기준으로 표시 — FULL_TIME_SPECIAL 은
 * 별도 분류라 본 지표에서 제외:
 *
 *   1. 전체 정규직 수 (KPI tile)
 *   2. 성별 비율 (donut PIE)
 *   3. 직급별 인원수 (column BAR)
 *   4. 연봉 분포 (column BAR, 만원 단위, HR/ADMIN 만)
 *   5. 나이 분포 (column BAR)
 *   6. 경력 분포 (column BAR)
 *   7. 근무 기간 분포 (column BAR)
 *
 * 모든 차트는 페이지가 받아 둔 Developer 배열을 useMemo 로 가공 — 별도 API X.
 * 토글 상태(펼침/접힘)는 localStorage 'dev-stats-open' 에 저장. 기본 접힘 —
 * 사용자가 한 번이라도 펼치면 그 이후로는 자동 펼침 상태로 복원.
 *
 * BAR 차트(직급/연봉/나이/경력/근무기간)에는 같은 카테고리에 spline 라인을
 * 함께 그려 분포 추세를 보조 시각화. PIE 는 라인 표현이 의미 없어 단일.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  Briefcase,
  Cake,
  ChevronDown,
  ChevronUp,
  Clock,
  GraduationCap,
  Lock,
  PieChart as PieIcon,
  Users,
  Wallet,
} from "lucide-react";

import {
  ageBuckets,
  careerBuckets,
  genderBuckets,
  rankBuckets,
  salaryBuckets,
  tenureBuckets,
  type Bucket,
  type StatsDeveloper,
} from "@/lib/developer-stats";
import { ageFromRRN } from "@/lib/resident";

// 다른 차트 페이지(budget-calc/cloud-costs/dashboard)와 동일한 dynamic import 패턴.
const HighchartsReact = dynamic(
  () => import("highcharts-react-official").then((m) => m.default),
  { ssr: false },
);

// --------------------------------------------------------------------------
// 색상 — bar 는 단일 brand color, pie 는 카테고리 팔레트.
// --------------------------------------------------------------------------

const BAR_COLOR  = "#3b82f6"; // column 시리즈 — primary blue.
const LINE_COLOR = "#f97316"; // overlay spline — orange (대비).
const PIE_COLORS = [
  "#3b82f6", // 남자 (blue)
  "#ec4899", // 여자 (pink)
  "#94a3b8", // 미상 (slate)
];

// --------------------------------------------------------------------------
// 컨테이너
// --------------------------------------------------------------------------

type Props = {
  /** 임직원 페이지의 전체 directory (정규직 + 비정규직 + 퇴사자 모두 포함). */
  devs: StatsDeveloper[] & {
    employment_type?: string;
    status?: string;
  }[];
  /** 직급 id → 이름 매핑 — 페이지의 rankMap 을 그대로 주입. */
  rankMap: Map<string, string>;
  /** 직급 표시 순서 (운영팀이 정의한 직급 마스터 순서). */
  rankOrder?: string[];
  /** 연봉 차트 노출 여부 — HR/ADMIN 만 true. */
  canSeeSalary: boolean;
};

export function DeveloperStatsPanel({
  devs,
  rankMap,
  rankOrder,
  canSeeSalary,
}: Props) {
  // 기본 접힘. 사용자가 한 번 펼친 적이 있으면 localStorage 가 '1' 이라
  // 다음 방문부터는 자동 펼침.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const saved = window.localStorage.getItem("dev-stats-open");
    if (saved === "1") setOpen(true);
  }, []);
  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem("dev-stats-open", next ? "1" : "0");
      return next;
    });
  }

  // 정규직(FULL_TIME) + ACTIVE 만. INACTIVE(비활성) 직원은 지표에서 제외.
  // FULL_TIME_SPECIAL 도 본 지표 대상이 아님.
  const fulltime = useMemo(
    () =>
      (devs as any[]).filter(
        (d) => d.employment_type === "FULL_TIME" && d.status === "ACTIVE",
      ),
    [devs],
  );
  const total = fulltime.length;
  // 평균 연령 — RRN 으로 만 나이 산출이 가능한 인원만 분모. 한 명도 없으면 null.
  const avgAge = useMemo(() => {
    const ages: number[] = [];
    for (const d of fulltime as any[]) {
      const a = ageFromRRN(d.resident_number ?? null);
      if (a != null) ages.push(a);
    }
    if (ages.length === 0) return null;
    const sum = ages.reduce((acc, v) => acc + v, 0);
    return sum / ages.length;
  }, [fulltime]);

  const gender = useMemo(() => genderBuckets(fulltime), [fulltime]);
  const rank = useMemo(
    () => rankBuckets(fulltime, rankMap, rankOrder),
    [fulltime, rankMap, rankOrder],
  );
  const salary = useMemo(
    () => (canSeeSalary ? salaryBuckets(fulltime) : []),
    [fulltime, canSeeSalary],
  );
  const age = useMemo(() => ageBuckets(fulltime), [fulltime]);
  const career = useMemo(() => careerBuckets(fulltime), [fulltime]);
  const tenure = useMemo(() => tenureBuckets(fulltime), [fulltime]);

  return (
    <div className="flex flex-col gap-3">
      {/* 토글 헤더 — 카드 외부에 있는 가벼운 섹션 라벨. */}
      <button
        type="button"
        onClick={toggle}
        className="flex items-center justify-between text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <span className="inline-flex items-center gap-2">
          <Users className="h-4 w-4" />
          정규직 지표
          <span className="text-xs font-normal">({total}명)</span>
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-3">
          {/* 1행: KPI(1) + 성별 PIE(1) + 직급 BAR(3) — 5칸 grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <HeadcountTile total={total} avgAge={avgAge} />
            <ChartCard
              title="성별 비율"
              icon={<PieIcon className="h-4 w-4 text-pink-600" />}
            >
              {gender.length > 0 ? (
                <PieChart data={gender} total={total} />
              ) : (
                <Empty />
              )}
            </ChartCard>
            <div className="lg:col-span-3 h-full">
              <ChartCard
                title="직급별 인원수"
                icon={<Briefcase className="h-4 w-4 text-blue-600" />}
              >
                {rank.length > 0 ? <BarChart data={rank} /> : <Empty />}
              </ChartCard>
            </div>
          </div>

          {/* 2행: 연봉/나이/경력/근무기간 BAR — 4칸 grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <ChartCard
              title="연봉 분포 (만원)"
              icon={<Wallet className="h-4 w-4 text-emerald-600" />}
            >
              {canSeeSalary ? (
                hasAny(salary) ? <BarChart data={salary} /> : <Empty />
              ) : (
                <SalaryGated />
              )}
            </ChartCard>
            <ChartCard
              title="나이 분포"
              icon={<Cake className="h-4 w-4 text-amber-600" />}
            >
              {hasAny(age) ? <BarChart data={age} /> : <Empty />}
            </ChartCard>
            <ChartCard
              title="경력 분포"
              icon={<GraduationCap className="h-4 w-4 text-violet-600" />}
            >
              {hasAny(career) ? <BarChart data={career} /> : <Empty />}
            </ChartCard>
            <ChartCard
              title="근무 기간 분포"
              icon={<Clock className="h-4 w-4 text-slate-600" />}
            >
              {hasAny(tenure) ? <BarChart data={tenure} /> : <Empty />}
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// 작은 building block 들
// --------------------------------------------------------------------------

// 동일 패널 안의 다른 차트 카드와 헤더 폰트/크기를 통일하기 위해 KPI 도
// ChartCard 셸을 그대로 사용 (text-sm font-semibold + 아이콘).
function HeadcountTile({
  total,
  avgAge,
}: {
  total: number;
  avgAge: number | null;
}) {
  return (
    <ChartCard
      title="전체 정규직"
      icon={<Users className="h-4 w-4 text-blue-600" />}
    >
      <div className="flex h-full flex-col">
        <div className="text-3xl font-bold tabular-nums text-foreground">
          {total}명
        </div>
        <div className="mt-auto pt-1 text-[11px] text-muted-foreground tabular-nums">
          평균 연령 {avgAge != null ? `${avgAge.toFixed(1)}세` : "-"}
        </div>
      </div>
    </ChartCard>
  );
}

// CardShell (대시보드) 와 동일 스펙: rounded-lg / p-4 / shadow-sm,
// 헤더는 inline-flex items-center gap-2 text-sm font-semibold + 아이콘.
function ChartCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm flex flex-col h-full min-h-[220px]">
      <div className="inline-flex items-center gap-2 text-sm font-semibold mb-2">
        {icon}
        {title}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      데이터 없음
    </div>
  );
}

function SalaryGated() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
      <Lock className="h-4 w-4" />
      <span>HR/ADMIN 만 열람 가능</span>
    </div>
  );
}

function hasAny(buckets: Bucket[]): boolean {
  return buckets.some((b) => b.value > 0);
}

// --------------------------------------------------------------------------
// 차트 — Highcharts 옵션 빌드
// --------------------------------------------------------------------------

function useHighcharts() {
  const [HC, setHC] = useState<any>(null);
  useEffect(() => {
    import("@/lib/highcharts-init").then((m) => setHC(m.default));
  }, []);
  return HC;
}

/**
 * 분포 차트 — column + spline 조합.
 *
 * 각 bin 의 인원수를 column 으로 표시하고, 같은 데이터 위에 spline 을
 * 덧입혀 추세를 강조. 두 시리즈 모두 같은 (단일) yAxis 를 사용 — 단위가
 * '인원' 으로 동일하므로 보조축 분리 불필요.
 */
function BarChart({ data }: { data: Bucket[] }) {
  const HC = useHighcharts();
  if (!HC) return <Loading />;
  const values = data.map((d) => d.value);
  const options = {
    chart: { type: "column", height: 180, backgroundColor: "transparent" },
    title: { text: "" },
    credits: { enabled: false },
    legend: { enabled: false },
    xAxis: {
      categories: data.map((d) => d.name),
      labels: { style: { fontSize: "10px" } },
    },
    yAxis: {
      title: { text: "" },
      allowDecimals: false,
      gridLineColor: "#f1f5f9",
    },
    tooltip: {
      shared: true,
      pointFormat:
        "<span style=\"color:{series.color}\">●</span> {series.name}: <b>{point.y}명</b><br/>",
    },
    plotOptions: {
      column: {
        borderRadius: 3,
        color: BAR_COLOR,
        dataLabels: {
          enabled: true,
          format: "{y}",
          style: { fontSize: "10px", fontWeight: "600", textOutline: "none" },
        },
      },
      spline: {
        color: LINE_COLOR,
        lineWidth: 2,
        marker: { enabled: true, radius: 3, fillColor: LINE_COLOR },
      },
    },
    series: [
      { type: "column", name: "인원",  data: values },
      { type: "spline", name: "추세",  data: values, enableMouseTracking: true },
    ],
  };
  return <HighchartsReact highcharts={HC} options={options} />;
}

function PieChart({ data, total }: { data: Bucket[]; total: number }) {
  const HC = useHighcharts();
  if (!HC) return <Loading />;
  const options = {
    chart: { type: "pie", height: 180, backgroundColor: "transparent" },
    title: { text: "" },
    credits: { enabled: false },
    tooltip: {
      pointFormatter() {
        // @ts-ignore — Highcharts callback context.
        const v = (this as any).y as number;
        const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
        return `<b>${v}명</b> (${pct}%)`;
      },
    },
    plotOptions: {
      pie: {
        innerSize: "60%",
        borderWidth: 0,
        dataLabels: {
          enabled: true,
          format: "{point.name}: {point.percentage:.0f}%",
          style: { fontSize: "10px", fontWeight: "600", textOutline: "none" },
        },
      },
    },
    series: [
      {
        type: "pie",
        name: "성별",
        data: data.map((d, i) => ({
          name: d.name,
          y: d.value,
          color: PIE_COLORS[i] ?? "#94a3b8",
        })),
      },
    ],
  };
  return <HighchartsReact highcharts={HC} options={options} />;
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      차트 로딩…
    </div>
  );
}
