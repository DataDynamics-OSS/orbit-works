"use client";

/**
 * 주소 → 지도 미리보기 — 카카오맵·구글맵 토글.
 *
 * 두 SDK 를 lazy load (탭 클릭 시점에만). 자격증명이 없거나 비활성된 provider 는
 * 버튼이 disabled. 같은 주소가 반복되어 들어와도 지오코딩 1회만 실행되도록
 * useEffect 안에서 guard.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

declare global {
  interface Window {
    kakao?: any;
    google?: any;
    __orbitGoogleMapsCallback?: () => void;
  }
}

type KakaoSettings = {
  enabled: boolean;
  javascript_key: string;
  sdk_version: string;
  integrity: string;
};
type GoogleSettings = {
  enabled: boolean;
  javascript_key: string;
};

let kakaoLoadPromise: Promise<void> | null = null;
let googleLoadPromise: Promise<void> | null = null;

function loadKakaoSDK(cfg: KakaoSettings): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.kakao?.maps) {
    return new Promise((resolve) => window.kakao.maps.load(() => resolve()));
  }
  if (kakaoLoadPromise) return kakaoLoadPromise;
  kakaoLoadPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    // Kakao **Maps** SDK — `kakao.min.js` (kakaocdn) 는 로그인/공유용 일반 JS SDK 로
    // `kakao.maps` 네임스페이스를 포함하지 않는다. 지도용 전용 엔드포인트를 사용.
    // autoload=false → onload 후 명시적으로 kakao.maps.load(cb) 호출.
    // libraries=services → addressSearch (Geocoder) 가 포함된 라이브러리.
    s.src =
      `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(cfg.javascript_key)}` +
      `&autoload=false&libraries=services`;
    s.async = true;
    s.onload = () => {
      try {
        window.kakao!.maps.load(() => resolve());
      } catch (e) {
        reject(e);
      }
    };
    s.onerror = () => reject(new Error("kakao Maps SDK 로드 실패"));
    document.head.appendChild(s);
  });
  return kakaoLoadPromise;
}

function loadGoogleSDK(cfg: GoogleSettings): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.google?.maps) return Promise.resolve();
  if (googleLoadPromise) return googleLoadPromise;
  googleLoadPromise = new Promise<void>((resolve, reject) => {
    window.__orbitGoogleMapsCallback = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.javascript_key)}&libraries=geocoding&callback=__orbitGoogleMapsCallback`;
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error("google maps 로드 실패"));
    document.head.appendChild(s);
  });
  return googleLoadPromise;
}

/**
 * 주소→지도 상태/렌더링 훅.
 *
 * 부모 레이아웃이 입력 필드 ↔ 토글 버튼 ↔ 지도를 자유롭게 배치할 수 있도록
 * `<AddressMapButtons />` (토글) 와 `<AddressMapDisplay />` (지도 컨테이너) 를
 * 별개로 노출. 단순 사용 케이스는 기존 `<AddressMap />` 래퍼로 그대로 가능.
 */
export type AddressMapState = ReturnType<typeof useAddressMapState>;

export function useAddressMapState(address: string | null | undefined) {
  const [provider, setProvider] = useState<"kakao" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: km } = useQuery<KakaoSettings>({
    queryKey: ["settings", "kakao_map"],
    queryFn: async () => (await api.get("/settings/kakao_map")).data,
    staleTime: 60_000,
  });
  const { data: gm } = useQuery<GoogleSettings>({
    queryKey: ["settings", "google_map"],
    queryFn: async () => (await api.get("/settings/google_map")).data,
    staleTime: 60_000,
  });

  const kakaoUsable = !!(km && km.enabled && km.javascript_key);
  const googleUsable = !!(gm && gm.enabled && gm.javascript_key);

  // 지도 렌더링 — provider 또는 address 변경 시 재실행.
  useEffect(() => {
    setError(null);
    if (!provider) return;
    if (!address || !address.trim()) {
      setError("주소를 먼저 입력하세요.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (provider === "kakao") {
          if (!kakaoUsable) {
            setError("Kakao Map 자격증명 미설정 (설정 > 외부 연동).");
            return;
          }
          await loadKakaoSDK(km!);
          if (cancelled || !containerRef.current) return;
          const kakao = window.kakao!;
          // SDK 가 로드 후 kakao.maps.load() 안에서만 안전 — 위 helper 가 처리.
          if (!kakao.maps?.services) {
            // services 라이브러리가 별도 — 보통 main bundle 에 포함되지만 보호적 reload.
            await new Promise<void>((res) =>
              kakao.maps.load(() => res()),
            );
          }
          const geocoder = new kakao.maps.services.Geocoder();
          geocoder.addressSearch(address, (results: any[], status: string) => {
            if (cancelled) return;
            if (status !== kakao.maps.services.Status.OK || !results.length) {
              setError("주소를 찾을 수 없습니다.");
              return;
            }
            const r = results[0];
            const coord = new kakao.maps.LatLng(r.y, r.x);
            const map = new kakao.maps.Map(containerRef.current, {
              center: coord,
              level: 4,
            });
            new kakao.maps.Marker({ position: coord, map });
          });
        } else if (provider === "google") {
          if (!googleUsable) {
            setError("Google Map 자격증명 미설정 (설정 > 외부 연동).");
            return;
          }
          await loadGoogleSDK(gm!);
          if (cancelled || !containerRef.current) return;
          const google = window.google!;
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode({ address }, (results: any[], status: string) => {
            if (cancelled) return;
            if (status !== "OK" || !results?.length) {
              setError("주소를 찾을 수 없습니다.");
              return;
            }
            const loc = results[0].geometry.location;
            const map = new google.maps.Map(containerRef.current, {
              center: loc,
              zoom: 15,
            });
            new google.maps.Marker({ position: loc, map });
          });
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "지도 로드 실패");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, address, kakaoUsable, googleUsable, km, gm]);

  return { provider, setProvider, error, containerRef, kakaoUsable, googleUsable };
}

export function AddressMapButtons({ state }: { state: AddressMapState }) {
  const { provider, setProvider, error, kakaoUsable, googleUsable } = state;
  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={() => setProvider(provider === "kakao" ? null : "kakao")}
        disabled={!kakaoUsable}
        className={
          "h-9 px-3 rounded-md border text-xs whitespace-nowrap " +
          (provider === "kakao"
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-background hover:bg-muted disabled:opacity-50")
        }
        title={kakaoUsable ? "" : "Kakao Map 비활성"}
      >
        카카오맵
      </button>
      <button
        type="button"
        onClick={() => setProvider(provider === "google" ? null : "google")}
        disabled={!googleUsable}
        className={
          "h-9 px-3 rounded-md border text-xs whitespace-nowrap " +
          (provider === "google"
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-background hover:bg-muted disabled:opacity-50")
        }
        title={googleUsable ? "" : "Google Map 비활성"}
      >
        구글맵
      </button>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  );
}

export function AddressMapDisplay({ state }: { state: AddressMapState }) {
  const { provider, containerRef } = state;
  if (!provider) return null;
  return (
    <div
      ref={containerRef}
      className="w-full rounded-md border border-border bg-muted/30 mt-2"
      style={{ height: 280 }}
    />
  );
}

export function AddressMap({ address }: { address: string | null | undefined }) {
  const state = useAddressMapState(address);
  return (
    <div className="space-y-2">
      <AddressMapButtons state={state} />
      <AddressMapDisplay state={state} />
    </div>
  );
}
