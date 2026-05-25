"use client";

/**
 * 출장 상세 — FullCalendar timeGridWeek 기반 일정 화면.
 *
 * - timeZone = 도착지 TZ (이벤트 위치는 도착지 wall-clock 기준).
 * - slotLabelContent 로 좌측 시간축에 도착지/출발지 시각을 dual 로 표시.
 * - 비행 이벤트는 출발 공항 현지 시각·도착 공항 현지 시각 두 입력을 IATA TZ
 *   로 UTC 변환 후 단일 row 로 저장 (event_tz = 도착 공항 TZ).
 * - 캘린더 빈 슬롯 드래그 → '기타' 일정 빠르게 생성 (kind=OTHER).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import luxonPlugin from "@fullcalendar/luxon3";
import { DateTime } from "luxon";
import { ChevronLeft, ChevronRight, HelpCircle, MapPin, Trash2 } from "lucide-react";

import { Tooltip } from "@/components/ui/Tooltip";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { AirportPicker } from "@/components/trips/AirportPicker";
import { findAirport } from "@/lib/airports";

// BlockNote 에디터는 브라우저 전용 — SSR 회피.
const MeetingNoteEditor = dynamic(
  () =>
    import("@/components/meeting-notes/MeetingNoteEditor").then(
      (m) => m.MeetingNoteEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="text-xs text-muted-foreground">에디터 로드 중…</div>
    ),
  },
);

type TripEvent = {
  id: string;
  trip_id: string;
  kind:
    | "FLIGHT"
    | "HOTEL"
    | "MEETING"
    | "TRANSIT"
    | "TOURISM"
    | "CONFERENCE"
    | "OTHER";
  title: string;
  start_at: string; // UTC ISO
  end_at: string;
  event_tz: string;
  from_iata: string | null;
  to_iata: string | null;
  flight_no: string | null;
  location: string | null;
  notes: string | null;
};

type Trip = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  origin_tz: string;
  destination_tz: string;
  notes: string | null;
  prep_notes: string | null;
  events: TripEvent[];
};

type EventForm = {
  id: string | null;
  kind: TripEvent["kind"];
  title: string;
  // 비-FLIGHT: 단일 슬롯
  start_local: string; // datetime-local "YYYY-MM-DDTHH:mm"
  end_local: string;
  tz: string;
  // FLIGHT 전용
  from_iata: string;
  to_iata: string;
  departure_local: string; // 출발공항 현지 시각
  arrival_local: string; // 도착공항 현지 시각
  flight_no: string;
  location: string;
  notes: string;
};

const KIND_LABEL: Record<TripEvent["kind"], string> = {
  FLIGHT: "비행",
  HOTEL: "숙박",
  MEETING: "미팅",
  TRANSIT: "이동",
  TOURISM: "관광",
  CONFERENCE: "컨퍼런스",
  OTHER: "기타",
};
const KIND_COLOR: Record<TripEvent["kind"], string> = {
  FLIGHT: "#0ea5e9", // sky
  HOTEL: "#a855f7", // purple
  MEETING: "#10b981", // emerald
  TRANSIT: "#f97316", // orange
  TOURISM: "#ec4899", // pink
  CONFERENCE: "#6366f1", // indigo
  OTHER: "#64748b", // slate
};
// 이벤트 fill — 같은 색상 hue 의 alpha 0.22. 테두리는 KIND_COLOR (solid) 라
// 종류 구분은 또렷하게, 본문 영역은 투명도가 있어 뒤의 horizontal line 도 보임.
const KIND_BG: Record<TripEvent["kind"], string> = {
  FLIGHT: "rgba(14, 165, 233, 0.22)",
  HOTEL: "rgba(168, 85, 247, 0.22)",
  MEETING: "rgba(16, 185, 129, 0.22)",
  TRANSIT: "rgba(249, 115, 22, 0.22)",
  TOURISM: "rgba(236, 72, 153, 0.22)",
  CONFERENCE: "rgba(99, 102, 241, 0.22)",
  OTHER: "rgba(100, 116, 139, 0.22)",
};
const KIND_ICON: Record<TripEvent["kind"], string> = {
  FLIGHT: "✈",
  HOTEL: "🏨",
  MEETING: "🤝",
  TRANSIT: "🚗",
  TOURISM: "📷",
  CONFERENCE: "🎤",
  OTHER: "•",
};

function utcToLocalInput(utcIso: string, tz: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(tz)
    .toFormat("yyyy-LL-dd'T'HH:mm");
}

function localInputToUtcIso(local: string, tz: string): string {
  return DateTime.fromFormat(local, "yyyy-LL-dd'T'HH:mm", { zone: tz })
    .toUTC()
    .toISO()!;
}

function blankForm(tz: string): EventForm {
  return {
    id: null,
    kind: "MEETING",
    title: "",
    start_local: "",
    end_local: "",
    tz,
    from_iata: "",
    to_iata: "",
    departure_local: "",
    arrival_local: "",
    flight_no: "",
    location: "",
    notes: "",
  };
}

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const dialog = useDialog();
  const qc = useQueryClient();
  const calRef = useRef<FullCalendar | null>(null);

  const { data: trip } = useQuery<Trip>({
    queryKey: ["trip", params.id],
    queryFn: async () => (await api.get(`/trips/${params.id}`)).data,
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EventForm>(blankForm("UTC"));

  // 준비물 패널 접힘 상태 — localStorage 에 persistent.
  const PREP_COLLAPSED_KEY = "orbit-trips-prep-collapsed";
  const [prepCollapsed, setPrepCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setPrepCollapsed(window.localStorage.getItem(PREP_COLLAPSED_KEY) === "1");
    } catch {
      /* localStorage 미허용 환경 무시 */
    }
  }, []);
  function togglePrep() {
    setPrepCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(PREP_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // FullCalendar `scrollTime` 은 인스턴스 초기화 시 1회만 반영 — dev HMR 이나
  // 같은 인스턴스가 재렌더되는 경우 이전 스크롤 위치가 남는다. trip 이 로드되면
  // 강제로 00:00 으로 스크롤해 첫 시간이 항상 00:00 이 되도록.
  useEffect(() => {
    if (!trip) return;
    const id = setTimeout(() => {
      calRef.current?.getApi()?.scrollToTime("00:00:00");
    }, 0);
    return () => clearTimeout(id);
  }, [trip?.id]);

  // FullCalendar 이벤트 매핑 — start/end 는 UTC ISO 그대로 전달, 색은 kind 별.
  const fcEvents = useMemo(() => {
    if (!trip) return [];
    return trip.events.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start_at,
      end: e.end_at,
      backgroundColor: KIND_BG[e.kind],
      borderColor: KIND_COLOR[e.kind],
      textColor: "#000",
      extendedProps: { kind: e.kind, raw: e },
    }));
  }, [trip]);

  // 출발지(origin) wall-clock 의 destination wall-clock 좌표(분) — Intl 로만
  // 계산해 brower tzdata 만 신뢰. FC 의 event placement 가 1h 어긋나는 환경
  // 회피용으로 slotLaneClassNames 에서 슬롯 위치를 매칭하기 위해 사용.
  const slotMarkers = useMemo(() => {
    if (!trip) return null;
    // 어떤 UTC 순간에 대한 zone 의 UTC offset(분) 를 Intl 로 추출.
    function offsetMin(tz: string, at: Date): number {
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const p = f.formatToParts(at);
      const get = (t: string) => +(p.find((x) => x.type === t)?.value ?? 0);
      const wall = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
      );
      return Math.round((wall - at.getTime()) / 60000);
    }
    // 기준 instant — 출장 시작일 정오 UTC 로 잡으면 DST 경계와 충돌 없음.
    const [y, mo, d] = trip.start_date.split("-").map(Number);
    const ref = new Date(Date.UTC(y, mo - 1, d, 12, 0));
    const diff =
      offsetMin(trip.destination_tz, ref) - offsetMin(trip.origin_tz, ref);
    const wrap = (m: number) => ((m % 1440) + 1440) % 1440;
    return {
      midnightMin: wrap(0 + diff), // origin 00:00 → dest 분
      bizStartMin: wrap(9 * 60 + diff), // origin 09:00
      bizEndMin: wrap(18 * 60 + diff), // origin 18:00
      // 슬롯 라벨용 — primary(=dest) 분에 더하면 secondary(=origin) 분.
      // diff 는 dest_offset − origin_offset 이므로 라벨에는 부호 반전.
      originFromDestDiff: -diff,
    };
  }, [trip]);

  // 시차 + 여름시간(DST) 적용 여부 — 캘린더 위 배너에 표시.
  const tzInfo = useMemo(() => {
    if (!trip) return null;
    function offsetMin(tz: string, at: Date): number {
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const p = f.formatToParts(at);
      const get = (t: string) => +(p.find((x) => x.type === t)?.value ?? 0);
      const wall = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
      );
      return Math.round((wall - at.getTime()) / 60000);
    }
    function tzAbbr(tz: string, at: Date): string {
      // "PDT" / "PST" / "KST" 식 약자.
      const p = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "short",
      }).formatToParts(at);
      return p.find((x) => x.type === "timeZoneName")?.value ?? "";
    }
    function isDst(tz: string, at: Date): boolean {
      // 1월(보통 표준시) 과 7월(서머타임 가능) 의 offset 비교 — 둘이 다르면
      // 그 zone 은 DST 를 사용하는 zone. at 의 offset 이 1월 offset 과 다르면
      // DST 적용 중.
      const jan = new Date(Date.UTC(at.getUTCFullYear(), 0, 15, 12, 0));
      const jul = new Date(Date.UTC(at.getUTCFullYear(), 6, 15, 12, 0));
      const offJan = offsetMin(tz, jan);
      const offJul = offsetMin(tz, jul);
      if (offJan === offJul) return false; // DST 미사용 zone.
      const offNow = offsetMin(tz, at);
      // 보통 DST 시 offset 이 1시간 더 (지구 동측). 양쪽 다 비교.
      return offNow !== offJan;
    }
    const [y, mo, d] = trip.start_date.split("-").map(Number);
    const ref = new Date(Date.UTC(y, mo - 1, d, 12, 0));
    const oOff = offsetMin(trip.origin_tz, ref);
    const dOff = offsetMin(trip.destination_tz, ref);
    const diffMin = dOff - oOff;
    const sign = diffMin >= 0 ? "+" : "-";
    const absH = Math.floor(Math.abs(diffMin) / 60);
    const absM = Math.abs(diffMin) % 60;
    const diffStr = absM === 0 ? `${sign}${absH}h` : `${sign}${absH}h${absM}m`;
    const dstParts: string[] = [];
    if (isDst(trip.origin_tz, ref)) dstParts.push(`출발지(${tzAbbr(trip.origin_tz, ref)}) 서머타임`);
    if (isDst(trip.destination_tz, ref)) dstParts.push(`도착지(${tzAbbr(trip.destination_tz, ref)}) 서머타임`);
    return {
      originAbbr: tzAbbr(trip.origin_tz, ref),
      destAbbr: tzAbbr(trip.destination_tz, ref),
      diffStr,
      dstActive: dstParts.length > 0,
      dstNote: dstParts.length === 0 ? "서머타임 미적용" : dstParts.join(" / "),
    };
  }, [trip]);

  function openCreate(prefillStart?: Date, prefillEnd?: Date) {
    if (!trip) return;
    const f = blankForm(trip.destination_tz);
    if (prefillStart) {
      f.start_local = DateTime.fromJSDate(prefillStart)
        .setZone(trip.destination_tz)
        .toFormat("yyyy-LL-dd'T'HH:mm");
    }
    if (prefillEnd) {
      f.end_local = DateTime.fromJSDate(prefillEnd)
        .setZone(trip.destination_tz)
        .toFormat("yyyy-LL-dd'T'HH:mm");
    }
    setForm(f);
    setOpen(true);
  }

  function openEdit(ev: TripEvent) {
    const f: EventForm = {
      id: ev.id,
      kind: ev.kind,
      title: ev.title,
      tz: ev.event_tz,
      start_local: utcToLocalInput(ev.start_at, ev.event_tz),
      end_local: utcToLocalInput(ev.end_at, ev.event_tz),
      from_iata: ev.from_iata ?? "",
      to_iata: ev.to_iata ?? "",
      departure_local:
        ev.kind === "FLIGHT" && ev.from_iata
          ? utcToLocalInput(
              ev.start_at,
              findAirport(ev.from_iata)?.tz ?? ev.event_tz,
            )
          : "",
      arrival_local:
        ev.kind === "FLIGHT" && ev.to_iata
          ? utcToLocalInput(
              ev.end_at,
              findAirport(ev.to_iata)?.tz ?? ev.event_tz,
            )
          : "",
      flight_no: ev.flight_no ?? "",
      location: ev.location ?? "",
      notes: ev.notes ?? "",
    };
    setForm(f);
    setOpen(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!trip) throw new Error("no trip");
      let payload: any;
      if (form.kind === "FLIGHT") {
        const fa = findAirport(form.from_iata);
        const ta = findAirport(form.to_iata);
        if (!fa || !ta) throw new Error("출발/도착 공항 IATA 가 올바르지 않습니다.");
        if (!form.departure_local || !form.arrival_local)
          throw new Error("출발/도착 시각을 입력하세요.");
        const start_at = localInputToUtcIso(form.departure_local, fa.tz);
        const end_at = localInputToUtcIso(form.arrival_local, ta.tz);
        payload = {
          kind: "FLIGHT",
          title: form.title.trim() || `${fa.iata} → ${ta.iata}`,
          start_at,
          end_at,
          event_tz: ta.tz, // 도착 공항 TZ — 캘린더 표시 정렬에 사용
          from_iata: fa.iata,
          to_iata: ta.iata,
          flight_no: form.flight_no || null,
          location: null,
          notes: form.notes || null,
        };
      } else {
        if (!form.title.trim()) throw new Error("제목을 입력하세요.");
        if (!form.start_local || !form.end_local)
          throw new Error("시작/종료 시각을 입력하세요.");
        const tz = form.tz || trip.destination_tz;
        payload = {
          kind: form.kind,
          title: form.title.trim(),
          start_at: localInputToUtcIso(form.start_local, tz),
          end_at: localInputToUtcIso(form.end_local, tz),
          event_tz: tz,
          from_iata: null,
          to_iata: null,
          flight_no: null,
          location: form.location || null,
          notes: form.notes || null,
        };
      }
      if (form.id) {
        return (
          await api.patch(`/trips/${trip.id}/events/${form.id}`, payload)
        ).data;
      }
      return (await api.post(`/trips/${trip.id}/events`, payload)).data;
    },
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["trip", params.id] });
    },
    onError: (e: any) =>
      alert(e?.response?.data?.detail || e?.message || "저장 실패"),
  });

  const deleteEventMut = useMutation({
    mutationFn: async (eid: string) => {
      if (!trip) return;
      await api.delete(`/trips/${trip.id}/events/${eid}`);
    },
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["trip", params.id] });
    },
  });

  const moveMut = useMutation({
    mutationFn: async (args: { id: string; start_at: string; end_at: string }) => {
      if (!trip) return;
      await api.patch(`/trips/${trip.id}/events/${args.id}`, {
        start_at: args.start_at,
        end_at: args.end_at,
      });
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["trip", params.id] }),
  });

  const deleteTripMut = useMutation({
    mutationFn: async () => {
      if (!trip) return;
      await api.delete(`/trips/${trip.id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      router.push("/trips");
    },
  });

  // 준비물(BlockNote JSON) — 우측 패널 에디터의 autosave 콜백. PATCH 후
  // invalidate 는 안 한다 — 에디터가 자체 상태 보존 중인데 refetch 로 inputs
  // 갱신되면 cursor/focus 가 흔들릴 수 있음.
  async function savePrepNotes(body: string, _plain: string): Promise<void> {
    if (!trip) return;
    await api.patch(`/trips/${trip.id}`, { prep_notes: body });
  }

  // 캘린더 폭(일수) 계산. 7일 초과 시에도 7일 grid 유지 + 페이지네이션.
  const dayCount = useMemo(() => {
    if (!trip) return 7;
    const s = DateTime.fromISO(trip.start_date);
    const e = DateTime.fromISO(trip.end_date);
    const n = Math.round(e.diff(s, "days").days) + 1;
    return Math.min(Math.max(n, 1), 7);
  }, [trip]);

  if (!trip) {
    return (
      <>
        <DashboardHeader title="출장" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title={
          <span className="flex items-baseline gap-2">
            <span>{trip.name}</span>
            <span className="text-sm font-normal text-muted-foreground">
              {trip.start_date} – {trip.end_date} · {trip.origin_tz} →{" "}
              {trip.destination_tz}
            </span>
          </span>
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => router.push("/trips")}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
            >
              ← 목록
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await dialog.confirm("이 출장을 삭제할까요? 일정이 모두 사라집니다.")) {
                  deleteTripMut.mutate();
                }
              }}
              className="h-8 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
            >
              출장 삭제
            </button>
          </>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-2 p-4">
        {tzInfo && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="font-medium">시차</span>
            <span className="font-mono">
              {tzInfo.originAbbr} → {tzInfo.destAbbr} {tzInfo.diffStr}
            </span>
            <span
              className={
                tzInfo.dstActive
                  ? "inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-800"
                  : "inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600"
              }
            >
              {tzInfo.dstActive ? "☀ " : ""}
              {tzInfo.dstNote}
            </span>
            <Tooltip
              label={
                <span className="block max-w-sm whitespace-normal text-left leading-relaxed">
                  서머타임(Daylight Saving Time) — 봄~가을 동안 표준시를 1시간 앞당기는 제도. 도착지가 서머타임 중이면 한국과의 시차가 평소보다 1시간 줄어듭니다 (예: LA 표준시 17h → 서머타임 16h).
                  <br />
                  <br />
                  <b>적용 지역과 시기</b>
                  <br />
                  · 미국 본토·캐나다 대부분: 3월 둘째 일요일 ~ 11월 첫째 일요일 (애리조나·하와이 제외).
                  <br />
                  · 멕시코: 2022 년부터 미적용 (Baja California 일부만 미국과 동일).
                  <br />
                  · EU·영국: 3월 마지막 일요일 ~ 10월 마지막 일요일.
                  <br />
                  · 호주 남동부·뉴질랜드: 남반구라 반대 — 10월 첫째 일요일(NZ 는 9월 마지막) ~ 4월 첫째 일요일.
                  <br />
                  · 한국·일본·중국·인도·동남아·중동·아프리카 대부분: 미사용.
                  {tzInfo.dstActive ? (
                    <>
                      <br />
                      <br />
                      현재 도착지({tzInfo.destAbbr})는 서머타임 적용 중이라 라인·띠 위치도 1시간 앞당겨진 상태입니다.
                    </>
                  ) : (
                    <>
                      <br />
                      <br />
                      현재는 미적용 — 표시된 위치가 표준시 기준입니다.
                    </>
                  )}
                </span>
              }
              side="bottom"
            >
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="서머타임 설명"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <span className="ml-auto text-muted-foreground">
              KST 자정·09–18 띠는 도착지({tzInfo.destAbbr}) 시각 기준으로 표시
            </span>
          </div>
        )}
        <div className="flex flex-1 min-h-0 gap-2">
        <div className="flex flex-1 min-w-0 min-h-0 flex-col gap-2">
        <div className="flex flex-1 min-h-0 flex-col rounded-md border border-border bg-card p-2">
          <FullCalendar
            ref={calRef as any}
            plugins={[timeGridPlugin, interactionPlugin, luxonPlugin]}
            initialView="timeGrid"
            duration={{ days: dayCount }}
            initialDate={trip.start_date}
            timeZone={trip.destination_tz}
            validRange={{ start: trip.start_date, end: addDay(trip.end_date) }}
            firstDay={DateTime.fromISO(trip.start_date).weekday % 7}
            // today / prev / next 버튼 제거 — validRange 가 출장 기간만이라 네비
            // 불필요. title 만 유지.
            headerToolbar={{ left: "title", center: "", right: "" }}
            titleFormat={(arg: any) => {
              const fmt = (d: Date) => {
                const mNum = d.getUTCMonth() + 1;
                const day = d.getUTCDate();
                const monthEng = new Intl.DateTimeFormat("en-US", {
                  month: "long",
                  timeZone: "UTC",
                }).format(d);
                return `${monthEng} (${mNum}월) ${day}`;
              };
              if (arg.end) {
                const yr = arg.end.marker.getUTCFullYear();
                return `${fmt(arg.start.marker)} – ${fmt(arg.end.marker)}, ${yr}`;
              }
              return `${fmt(arg.date.marker)}, ${arg.date.marker.getUTCFullYear()}`;
            }}
            allDaySlot={false}
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
            slotDuration="00:30:00"
            // 부모 flex-1 min-h-0 영역을 가득 채워 내부 timegrid 가 스크롤.
            // 초기 스크롤 위치는 00:00 — 출발지 자정 horizontal line 등 새벽 시간대
            // 표식을 처음부터 볼 수 있게.
            height="100%"
            scrollTime="00:00:00"
            // 뷰 마운트 직후 한 번 더 강제 — `scrollTime` 만으로는 컨테이너 높이가
            // 늦게 결정되거나 HMR 시 이전 스크롤이 남는 케이스가 있어 안전망.
            viewDidMount={(arg) => {
              arg.view.calendar.scrollToTime("00:00:00");
              requestAnimationFrame(() =>
                arg.view.calendar.scrollToTime("00:00:00"),
              );
            }}
            nowIndicator
            selectable
            selectMirror
            editable
            events={fcEvents}
            // 이벤트 본문 — 종류 아이콘 + 제목 (중앙), 위치가 있으면 그 아래.
            eventContent={(arg) => {
              const raw = (arg.event.extendedProps as any)?.raw as
                | TripEvent
                | undefined;
              const kind = (raw?.kind ?? "OTHER") as TripEvent["kind"];
              const icon = KIND_ICON[kind] ?? "";
              const loc = raw?.location?.trim();
              const titleLine = `
                <div class="flex items-center justify-center gap-1">
                  <span aria-hidden>${icon}</span>
                  <span class="font-medium">${escapeHtml(arg.event.title)}</span>
                </div>`;
              const locLine = loc
                ? `<div class="text-[10px] text-black/60 truncate">(${escapeHtml(loc)})</div>`
                : "";
              return {
                html: `
                  <div class="flex h-full w-full flex-col items-center justify-center px-1 text-center text-[12px] leading-tight gap-0.5">
                    ${titleLine}
                    ${locLine}
                  </div>`,
              };
            }}
            // origin TZ 자정 / 근무시간 표식 — slot lane 에 직접 클래스 부여.
            // FC event placement 가 1h 어긋나는 환경 회피.
            slotLaneClassNames={(arg: any) => {
              if (!slotMarkers) return [];
              // FC Duration 은 ms 단위만 보장. 슬롯의 자정 기준 분.
              const slotMin = Math.round((arg.time?.milliseconds ?? 0) / 60000);
              const cls: string[] = [];
              if (slotMin === slotMarkers.midnightMin) {
                cls.push("origin-tz-dateline-row");
              }
              const inBiz =
                slotMarkers.bizStartMin < slotMarkers.bizEndMin
                  ? slotMin >= slotMarkers.bizStartMin &&
                    slotMin < slotMarkers.bizEndMin
                  : slotMin >= slotMarkers.bizStartMin ||
                    slotMin < slotMarkers.bizEndMin;
              if (inBiz) cls.push("origin-tz-business-row");
              return cls;
            }}
            select={(arg) => {
              openCreate(arg.start, arg.end);
            }}
            eventClick={(arg) => {
              const raw = (arg.event.extendedProps as any).raw as TripEvent;
              if (raw) openEdit(raw);
            }}
            eventDrop={(arg) => {
              moveMut.mutate({
                id: arg.event.id,
                start_at: arg.event.start!.toISOString(),
                end_at: arg.event.end!.toISOString(),
              });
            }}
            eventResize={(arg) => {
              moveMut.mutate({
                id: arg.event.id,
                start_at: arg.event.start!.toISOString(),
                end_at: arg.event.end!.toISOString(),
              });
            }}
            slotLabelContent={(arg: any) => {
              // FC slot 의 자정 기준 분 — slotMinTime="00:00" 이라 곧 primary
              // wall-clock 분. arg.date 의미가 환경마다 흔들리는 문제 회피.
              const slotMin = Math.round((arg.time?.milliseconds ?? 0) / 60000);
              const diff = slotMarkers?.originFromDestDiff ?? 0;
              const secMin = (((slotMin + diff) % 1440) + 1440) % 1440;
              const fmt = (m: number) =>
                `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(
                  m % 60,
                ).padStart(2, "0")}`;
              return {
                html: `
                  <div class="flex items-center justify-end gap-1.5 leading-tight pr-1 whitespace-nowrap">
                    <span class="text-[11px] font-medium">${fmt(slotMin)}</span>
                    <span class="text-[10px] text-muted-foreground">${fmt(secMin)}</span>
                  </div>`,
              };
            }}
            eventTimeFormat={{
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }}
            slotLabelFormat={{
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-6 align-middle"
              style={{ borderTop: "1.5px dashed #ef4444" }}
            />
            {trip.origin_tz} 자정
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-6 rounded-sm align-middle"
              style={{ backgroundColor: "rgba(245, 158, 11, 0.45)" }}
            />
            {trip.origin_tz} 09:00–18:00
          </span>
          <span className="text-border" aria-hidden>
            |
          </span>
          {(
            [
              "FLIGHT",
              "HOTEL",
              "MEETING",
              "TRANSIT",
              "TOURISM",
              "CONFERENCE",
              "OTHER",
            ] as const
          ).map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-sm align-middle"
                style={{
                  backgroundColor: KIND_BG[k],
                  border: `1px solid ${KIND_COLOR[k]}`,
                }}
              />
              <span>
                {KIND_ICON[k]} {KIND_LABEL[k]}
              </span>
            </span>
          ))}
        </div>
        </div>
        {/* 우측 준비물 패널 — 펼치면 300px, 접으면 32px(toggle 만). */}
        {prepCollapsed ? (
          <aside className="flex w-8 shrink-0 flex-col items-center rounded-md border border-border bg-card py-2">
            <button
              type="button"
              onClick={togglePrep}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="준비물 펼치기"
              aria-label="준비물 펼치기"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span
              className="mt-2 text-xs font-medium text-muted-foreground"
              style={{ writingMode: "vertical-rl" }}
            >
              준비물
            </span>
          </aside>
        ) : (
          <aside className="flex w-[300px] shrink-0 flex-col rounded-md border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h3 className="text-sm font-semibold">준비물</h3>
              <button
                type="button"
                onClick={togglePrep}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="준비물 접기"
                aria-label="준비물 접기"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2">
              <MeetingNoteEditor
                initialBody={trip.prep_notes}
                onSave={savePrepNotes}
              />
            </div>
          </aside>
        )}
        </div>
      </div>

      {/* 이벤트 모달 */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? "일정 편집" : "새 일정"}
        width="max-w-2xl"
        footer={
          <div className="flex items-center justify-between gap-2">
            <div>
              {form.id && (
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm("이 일정을 삭제할까요?", {
                        confirmText: "삭제",
                      })
                    ) {
                      deleteEventMut.mutate(form.id!);
                    }
                  }}
                  className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 삭제
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
              >
                취소
              </button>
              <button
                type="button"
                disabled={saveMut.isPending}
                onClick={() => saveMut.mutate()}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                저장
              </button>
            </div>
          </div>
        }
      >
        <EventForm form={form} setForm={setForm} trip={trip} />
      </Dialog>
    </>
  );
}

function addDay(yyyymmdd: string): string {
  return DateTime.fromISO(yyyymmdd).plus({ days: 1 }).toISODate()!;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function EventForm({
  form,
  setForm,
  trip,
}: {
  form: EventForm;
  setForm: (f: EventForm) => void;
  trip: Trip;
}) {
  const isFlight = form.kind === "FLIGHT";
  return (
    <div className="grid grid-cols-2 gap-3 p-4">
      {/* 제목 + 종류 — 4:1 비율 한 줄. 비행은 제목이 자동 채워지므로 placeholder 만 다름. */}
      <div className="col-span-2 grid grid-cols-5 gap-3">
        <label className="col-span-4 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">제목</span>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            placeholder={
              isFlight
                ? "비워두면 IATA → IATA 자동"
                : form.kind === "HOTEL"
                  ? "예: 매리어트 SF"
                  : "일정 제목"
            }
          />
        </label>
        <label className="col-span-1 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">종류</span>
          <select
            value={form.kind}
            onChange={(e) =>
              setForm({ ...form, kind: e.target.value as TripEvent["kind"] })
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {(
              [
                "FLIGHT",
                "HOTEL",
                "MEETING",
                "TRANSIT",
                "TOURISM",
                "CONFERENCE",
                "OTHER",
              ] as const
            ).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!isFlight && (
        <>
          {/* 시간대 | 시작 | 종료 — 3 컬럼 한 줄. */}
          <div className="col-span-2 grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">
                시간대{" "}
                <span className="text-xs text-muted-foreground/70">(IANA)</span>
              </span>
              <input
                value={form.tz}
                readOnly
                className="h-9 rounded-md border border-input bg-muted/40 px-2 text-sm font-mono text-muted-foreground"
                placeholder={trip.destination_tz}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">시작 ({form.tz})</span>
              <input
                type="datetime-local"
                value={form.start_local}
                onChange={(e) =>
                  setForm({ ...form, start_local: e.target.value })
                }
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">종료 ({form.tz})</span>
              <input
                type="datetime-local"
                value={form.end_local}
                onChange={(e) =>
                  setForm({ ...form, end_local: e.target.value })
                }
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              />
            </label>
          </div>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">위치</span>
            <div className="flex gap-2">
              <input
                value={form.location}
                onChange={(e) =>
                  setForm({ ...form, location: e.target.value })
                }
                className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                placeholder="호텔/주소 등"
              />
              <button
                type="button"
                disabled={!form.location.trim()}
                onClick={() =>
                  window.open(
                    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(form.location)}`,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
                title="Google 지도에서 보기"
                aria-label="Google 지도에서 보기"
                className="h-9 inline-flex items-center justify-center rounded-md border border-input bg-background px-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <MapPin className="h-4 w-4" />
              </button>
            </div>
          </label>
        </>
      )}

      {isFlight && (
        <>
          <div>
            <span className="text-xs text-muted-foreground">출발 공항</span>
            <AirportPicker
              value={form.from_iata}
              onChange={(iata) => setForm({ ...form, from_iata: iata })}
            />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">도착 공항</span>
            <AirportPicker
              value={form.to_iata}
              onChange={(iata) => setForm({ ...form, to_iata: iata })}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              출발 시각 (
              {findAirport(form.from_iata)?.tz ?? "출발지 TZ"})
            </span>
            <input
              type="datetime-local"
              value={form.departure_local}
              onChange={(e) =>
                setForm({ ...form, departure_local: e.target.value })
              }
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              도착 시각 ({findAirport(form.to_iata)?.tz ?? "도착지 TZ"})
            </span>
            <input
              type="datetime-local"
              value={form.arrival_local}
              onChange={(e) =>
                setForm({ ...form, arrival_local: e.target.value })
              }
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">항공편</span>
            <input
              value={form.flight_no}
              onChange={(e) =>
                setForm({ ...form, flight_no: e.target.value })
              }
              placeholder="예: KE023"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
        </>
      )}

      <label className="col-span-2 flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">메모</span>
        <textarea
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          className="rounded-md border border-input bg-background p-2 text-sm"
        />
      </label>
    </div>
  );
}
