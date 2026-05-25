"use client";

/**
 * Kakao Map JavaScript SDK 자동 로더.
 *
 * 로그인 후 dashboard 진입 시 한 번 마운트되어:
 *   1) GET /integrations/kakao-map 으로 활성 여부 + key/version/integrity 조회
 *   2) 활성이면 <head> 에 SRI 스크립트 1개 삽입:
 *        <script src="https://t1.kakaocdn.net/kakao_js_sdk/${VERSION}/kakao.min.js"
 *                integrity="${INTEGRITY}" crossorigin="anonymous"></script>
 *   3) onload 에서 Kakao.init(KEY) + isInitialized 로그
 *
 * 중복 삽입 방지: <script data-kakao-sdk> 마커 확인. integrity 가 버전과
 * 안 맞으면 브라우저가 차단 → 콘솔 에러로 노출됨.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

declare global {
  interface Window {
    // Kakao SDK 는 임의 모양이라 any 로 둔다 (이 컴포넌트 외에는 직접 사용 X).
    Kakao?: {
      init: (key: string) => void;
      isInitialized: () => boolean;
      [k: string]: unknown;
    };
  }
}

type KakaoMapPublic = {
  enabled: boolean;
  javascript_key: string;
  sdk_version: string;
  integrity: string;
};

const SCRIPT_MARKER = "data-kakao-sdk";

export function KakaoMapLoader() {
  const { data } = useQuery<KakaoMapPublic>({
    queryKey: ["kakao-map-config"],
    queryFn: async () => (await api.get("/integrations/kakao-map")).data,
    // 설정 변경은 드물어 1시간 캐시. 즉시 반영이 필요하면 새로고침.
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!data || !data.enabled) return;
    const { javascript_key, sdk_version, integrity } = data;
    if (!javascript_key || !sdk_version || !integrity) return;

    // 이미 로드돼 있으면 init 만.
    if (window.Kakao && window.Kakao.isInitialized?.()) return;
    if (document.querySelector(`script[${SCRIPT_MARKER}]`)) return;

    const script = document.createElement("script");
    script.src = `https://t1.kakaocdn.net/kakao_js_sdk/${sdk_version}/kakao.min.js`;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.async = true;
    script.setAttribute(SCRIPT_MARKER, "true");
    script.onload = () => {
      try {
        if (window.Kakao && !window.Kakao.isInitialized()) {
          window.Kakao.init(javascript_key);
          // 로그는 일부러 남김 — 운영 진단 시 SDK 초기화 여부 빠르게 확인.
          // eslint-disable-next-line no-console
          console.log(
            "[Kakao SDK] init:",
            window.Kakao.isInitialized(),
            "v" + sdk_version,
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[Kakao SDK] init failed:", e);
      }
    };
    script.onerror = () => {
      // 보통 integrity mismatch 또는 네트워크 차단. 사용자에겐 toast 안 띄우고
      // 콘솔에만 — Kakao SDK 미사용 페이지에서도 layout 에 마운트되므로.
      // eslint-disable-next-line no-console
      console.error(
        "[Kakao SDK] script load failed (integrity mismatch or network).",
      );
    };
    document.head.appendChild(script);

    // SDK 는 SPA 라이프타임 동안 유지 — unmount 시 제거하지 않음.
  }, [data]);

  return null;
}
