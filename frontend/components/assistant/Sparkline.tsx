"use client";

/**
 * 미니 시계열 라인 — 도구 결과 카드 안에 인라인 표시용.
 *
 * 의존성 0 (순수 SVG). Highcharts 는 floating chat 의 좁은 폭에선 오버킬이고,
 * 이 컴포넌트는 ~30 라인이라 도구마다 다른 색·길이로 재사용 쉬움.
 *
 * 입력값이 단조증가/감소하든 모두 0 이든 자연스럽게 처리되도록 max-min=0 가드.
 */

type Props = {
  values: number[];
  width?: number;
  height?: number;
  color?: string;          // CSS color (예: "rgb(2 132 199)")
  fillOpacity?: number;
  strokeWidth?: number;
};

export function Sparkline({
  values,
  width = 160,
  height = 32,
  color = "currentColor",
  fillOpacity = 0.12,
  strokeWidth = 1.5,
}: Props) {
  if (!values || values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  // 모든 값이 같으면 한가운데에 평행선.
  const flat = max === min;
  const points = values.map((v, i) => {
    const y = flat ? height / 2 : height - ((v - min) / range) * height;
    return `${i * stepX},${y}`;
  });

  const linePoints = points.join(" ");
  const areaPoints = `0,${height} ${linePoints} ${width},${height}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block shrink-0"
      aria-hidden
    >
      <polyline points={areaPoints} fill={color} opacity={fillOpacity} stroke="none" />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
