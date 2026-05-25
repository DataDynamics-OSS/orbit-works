const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // 모노레포(`/shared`) 의 소스를 standalone 번들 trace 범위에 포함.
  outputFileTracingRoot: path.join(__dirname, ".."),
  // @orbit/shared 는 빌드된 dist 가 없는 순수 TS 소스 패키지. Next.js 가 직접 트랜스파일.
  transpilePackages: ["@orbit/shared"],
  // dev 서버를 LAN IP 로 접속할 때 cross-origin 경고를 막는다. 회사 내부망에서
  // 로컬 머신의 dev 서버를 다른 PC/노트북·태블릿이 직접 열 때 (10.0.x.x) 사용.
  // 미설정 시 Next.js 가 "Cross origin request detected ..." 경고를 띄우고
  // 향후 major 에서는 차단 예정. CIDR 은 지원 안 하므로 사설망 대역을 glob
  // 와일드카드로 등록. 추가 호스트는 ALLOWED_DEV_ORIGINS 환경변수에 콤마로
  // 나열해 override 가능 (예: ALLOWED_DEV_ORIGINS=dev.foo.example,10.0.*.*).
  allowedDevOrigins: (
    process.env.ALLOWED_DEV_ORIGINS ||
    [
      "localhost",
      "127.0.0.1",
      "10.*.*.*",
      "192.168.*.*",
      "172.16.*.*", "172.17.*.*", "172.18.*.*", "172.19.*.*",
      "172.20.*.*", "172.21.*.*", "172.22.*.*", "172.23.*.*",
      "172.24.*.*", "172.25.*.*", "172.26.*.*", "172.27.*.*",
      "172.28.*.*", "172.29.*.*", "172.30.*.*", "172.31.*.*",
    ].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  async rewrites() {
    const api = process.env.API_PROXY_URL || "http://backend:4001";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  // 구 URL /developers/* 북마크는 영구적으로 /employees/* 로 이동.
  // 백엔드 /api/v1/developers/* 는 영향 없음 (redirects 는 페이지 경로만, /api/* 는 rewrites 가 먼저 처리).
  async redirects() {
    return [
      { source: "/developers", destination: "/employees", permanent: true },
      { source: "/developers/:path*", destination: "/employees/:path*", permanent: true },
    ];
  },
};

module.exports = nextConfig;
