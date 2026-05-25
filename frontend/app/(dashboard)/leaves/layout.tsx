import localFont from "next/font/local";

// Root layout 과 동일한 self-hosted variable 폰트. 로컬 파일이라 빌드 시 외부
// fetch 없이 일관 적용.
const robotoCondensed = localFont({
  src: "../../fonts/RobotoCondensed-Variable.woff2",
  weight: "100 900",
  display: "swap",
});

/**
 * 연차 관리 화면 전용 폰트·크기 wrapper.
 * - 폰트: Roboto Condensed (다른 섹션과 구분)
 * - 기본 글꼴 크기: text-sm (14px)
 *
 * `flex flex-col min-h-0 flex-1 h-full` 는 상위 대시보드 레이아웃의 flex
 * 컨테이너에 맞춰 자식 페이지가 높이를 꽉 채울 수 있도록 보존.
 */
export default function LeavesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${robotoCondensed.className} text-sm flex flex-col min-h-0 flex-1`}
    >
      {children}
    </div>
  );
}
