"use client";

/**
 * Kakao Map 미리보기 다이얼로그.
 *
 * Kakao Maps SDK 동적 로딩 패턴:
 *   <script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=KEY&autoload=false">
 *   kakao.maps.load(function() {
 *     var map = new kakao.maps.Map(container, {center, level});
 *   });
 *
 * `autoload=false` 가 핵심 — 가이드의 단순 `?appkey=KEY` 형식은 HTML <script>
 * 태그로 동기 로드 시에만 안전하다. JS 로 동적으로 삽입(SPA) 할 때는 SDK 내부
 * 의존 스크립트들이 비동기라서 `script.onload` 시점에 `kakao.maps.Map` 이 아직
 * 정의돼 있지 않을 수 있다. `autoload=false` 로 받고 `kakao.maps.load(cb)` 를
 * 호출하면 콜백 시점에 모든 API 가 준비됨이 보장된다.
 *
 * 호출 측이 lat/lng 를 직접 넘겨야 한다 (Geocoder 미사용 — services 라이브러리
 * 미로드). 주소만 있는 케이스는 호출 측에서 https://map.kakao.com/?q=… 외부
 * 링크로 폴백하는 것이 권장.
 *
 * 참조: KakaoMapLoader 가 이미 javascript_key 를 캐시한 useQuery 를 들고 있어
 * 같은 queryKey 로 재사용한다.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";

import { api } from "@/lib/api";

declare global {
  interface Window {
    // Kakao Maps SDK 네임스페이스 (소문자) — JS SDK 의 `window.Kakao` (대문자) 와 별개.
    kakao?: any;
  }
}

type KakaoMapPublic = {
  enabled: boolean;
  javascript_key: string;
  sdk_version: string;
  integrity: string;
};

const MAPS_SCRIPT_MARKER = "data-kakao-maps-sdk";

function loadMapsSdk(javascriptKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("window unavailable"));
      return;
    }

    // SDK 가 완전히 준비됐는지 — kakao.maps.Map 같은 실제 생성자 존재 확인.
    const ready = () =>
      !!(window.kakao && window.kakao.maps && window.kakao.maps.Map);
    if (ready()) {
      resolve();
      return;
    }

    // 스크립트 다운로드 후 kakao.maps.load(cb) 콜백 시점에 API 준비 완료.
    const finishWhenLoaded = () => {
      if (!window.kakao || !window.kakao.maps) {
        reject(new Error("Kakao Maps SDK 네임스페이스 누락 (도메인 등록 확인 필요)"));
        return;
      }
      // autoload=false 로 받았으므로 명시적 load(cb) 필요.
      try {
        window.kakao.maps.load(() => {
          if (ready()) resolve();
          else reject(new Error("Kakao Maps SDK 초기화 실패"));
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

    const existing = document.querySelector(
      `script[${MAPS_SCRIPT_MARKER}]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      // 다른 다이얼로그가 먼저 삽입했을 수도. readyState 확인.
      if (window.kakao?.maps) {
        finishWhenLoaded();
      } else {
        existing.addEventListener("load", finishWhenLoaded, { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("Kakao Maps SDK 스크립트 로드 실패")),
          { once: true },
        );
      }
      return;
    }

    const script = document.createElement("script");
    script.src =
      `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(javascriptKey)}&autoload=false`;
    script.async = true;
    script.setAttribute(MAPS_SCRIPT_MARKER, "true");
    script.onload = finishWhenLoaded;
    script.onerror = () =>
      reject(
        new Error(
          "Kakao Maps SDK 스크립트 로드 실패 (네트워크/CSP/도메인 등록 확인)",
        ),
      );
    // eslint-disable-next-line no-console
    console.log("[Kakao Maps] SDK 로드 시작:", script.src);
    document.head.appendChild(script);

    // 타임아웃 안전장치 — 10초 내 onload 안 오면 reject.
    setTimeout(() => {
      if (!ready()) {
        reject(
          new Error(
            "Kakao Maps SDK 로드 타임아웃 (10s) — 네트워크 또는 도메인 등록 상태 확인",
          ),
        );
      }
    }, 10_000);
  });
}

export function KakaoMapDialog({
  latitude,
  longitude,
  level = 3,
  radiusMeters,
  title,
  address,
  onClose,
}: {
  latitude: number;
  longitude: number;
  level?: number;
  /** 양수일 때 마커 주위에 반경 원을 그리고 지도 영역을 원에 맞춤. */
  radiusMeters?: number;
  title?: string;
  address?: string;
  onClose: () => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { data: cfg } = useQuery<KakaoMapPublic>({
    queryKey: ["kakao-map-config"],
    queryFn: async () =>
      (await api.get("/integrations/kakao-map")).data,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!cfg) return;
    if (!cfg.enabled || !cfg.javascript_key) {
      setError(
        "Kakao Map 이 활성화되지 않았습니다.\nSettings > 외부 연동 > Kakao Map API 에서 키를 등록·활성화하세요.",
      );
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadMapsSdk(cfg.javascript_key)
      .then(() => {
        if (cancelled || !mapRef.current) {
          // eslint-disable-next-line no-console
          console.log(
            "[Kakao Maps] dialog cancelled or mapRef missing — skip render",
          );
          return;
        }
        // 다이얼로그 첫 paint 가 끝난 다음 frame 에 Map 생성 — 그렇지 않으면
        // container.clientHeight 가 0 인 채로 Map 이 만들어져 빈 화면이 된다.
        requestAnimationFrame(() => {
          if (cancelled || !mapRef.current) return;
          const kakao = window.kakao!;
          const container = mapRef.current;
          // eslint-disable-next-line no-console
          console.log("[Kakao Maps] container size:", container.clientWidth, "x", container.clientHeight);

          const center = new kakao.maps.LatLng(latitude, longitude);
          const map = new kakao.maps.Map(container, { center, level });
          new kakao.maps.Marker({ map, position: center });

          // 반경 원 — radiusMeters > 0 일 때 마커 주위에 Circle.
          if (radiusMeters && radiusMeters > 0) {
            new kakao.maps.Circle({
              map,
              center,
              radius: radiusMeters,
              strokeWeight: 2,
              strokeColor: "#3B82F6",
              strokeOpacity: 0.85,
              strokeStyle: "solid",
              fillColor: "#3B82F6",
              fillOpacity: 0.15,
            });
            // 원 영역에 맞춰 자동 줌. 위도 1° ≈ 111km, 경도는 cos 보정.
            const dLat = radiusMeters / 111_000;
            const dLng =
              radiusMeters /
              (111_000 * Math.cos((latitude * Math.PI) / 180));
            const bounds = new kakao.maps.LatLngBounds(
              new kakao.maps.LatLng(latitude - dLat, longitude - dLng),
              new kakao.maps.LatLng(latitude + dLat, longitude + dLng),
            );
            map.setBounds(bounds);
          }
          setLoading(false);
          // 마지막 안전망 — 생성 직후 한 번 더 relayout (DevTools 열림 등으로
          // 사이즈가 한 박자 늦게 잡히는 경우 대비).
          requestAnimationFrame(() => {
            try {
              map.relayout();
              if (radiusMeters && radiusMeters > 0) {
                map.setLevel(map.getLevel()); // 줌 보존하며 재계산
              } else {
                map.setCenter(center);
              }
            } catch {
              // ignore
            }
          });
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = (e as Error).message ?? "지도 로드 실패";
        // eslint-disable-next-line no-console
        console.error("[Kakao Maps] load failed:", e);
        setError(msg);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [latitude, longitude, level, radiusMeters, cfg]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card rounded-lg shadow-xl w-[640px] max-w-[90vw] flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold truncate">{title ?? "지도"}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {(address || true) && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border shrink-0 flex items-center gap-2 flex-wrap">
            {address && <span className="truncate">{address}</span>}
            <a
              href={`https://map.kakao.com/?map_type=TYPE_MAP&urlLevel=${level}&urlX=${longitude}&urlY=${latitude}${address ? `&q=${encodeURIComponent(address)}` : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
            >
              카카오맵에서 열기
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
        {/* 고정 480px 높이 — flex/min-h 조합은 첫 프레임에 0 으로 잡혀 SDK 가
            컨테이너 0×0 으로 Map 을 만들고 타일 fetch 를 건너뛰는 케이스가 있다
            (이미지 4개만 로드되고 화면 빈 증상). 명시 픽셀로 결정해 회피. */}
        <div className="relative h-[480px] w-full">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              지도 불러오는 중…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-destructive whitespace-pre-wrap p-4 text-center">
              {error}
            </div>
          )}
          <div ref={mapRef} className="absolute inset-0" />
        </div>
      </div>
    </div>
  );
}
