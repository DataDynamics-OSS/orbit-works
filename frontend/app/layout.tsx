import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
// Prism 코드 하이라이팅 테마 — react-markdown + rehype-prism-plus 가 token 클래스를
// 부여하면 이 CSS 가 색상·줄번호 레이아웃을 적용.
import "prismjs/themes/prism-tomorrow.css";
import { Providers } from "@/components/Providers";

// Roboto Condensed — self-hosted variable font (woff2, ~170KB, 100~900 wght).
// 과거엔 next/font/google 로 빌드 시 fetch 했으나 Google Fonts CDN 도달 불가
// 환경(폐쇄망/네트워크 이슈) 에서 빌드가 fallback 폰트로 떨어졌다. 로컬
// 파일을 두면 빌드는 인터넷 의존 X, 런타임도 동일 woff2 자산을 정적 서빙.
const robotoCondensed = localFont({
  src: "./fonts/RobotoCondensed-Variable.woff2",
  weight: "100 900",
  variable: "--font-roboto-condensed",
  display: "swap",
});

// Noto Sans KR — self-hosted (public/fonts 에 이미 존재하던 .ttf 를 app/fonts/
// 로 복사해 next/font/local 로 로딩). 폐쇄망 빌드 + Turbopack 폰트 모듈
// 리졸버 버그 양쪽을 피하는 목적. 폐쇄망 정책상 Pretendard 가 1순위라
// 실제로는 Pretendard fallback 으로 거의 안 쓰이지만 layout 변수 호환 위해 유지.
const notoSansKR = localFont({
  src: [
    { path: "./fonts/NotoSansKR-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/NotoSansKR-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-noto-sans-kr",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Orbit Works",
  description: "인력·프로젝트·영업·청구·급여·라이센스 통합 운영",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: 영한사전(Endic) · WXT 기반 등 브라우저 확장이
    // <body> 에 마커 element/attribute 를 주입해 SSR HTML 과 불일치 → 가짜
    // hydration warning 만 발생. 우리 코드 본문엔 영향 없으므로 root 차원에서 무시.
    <html
      lang="ko"
      className={`${robotoCondensed.variable} ${notoSansKR.variable}`}
      suppressHydrationWarning
    >
      <body
        className="min-h-screen antialiased text-sm text-foreground bg-background font-sans"
        suppressHydrationWarning
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
