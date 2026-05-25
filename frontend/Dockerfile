# Build context = repo root (docker-compose.yml 에서 context: . 로 지정).
# 이유: @orbit/shared 패키지 소스가 /shared 에 있고, pnpm workspace 로 연결되기 때문.

FROM node:20-alpine AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY pnpm-workspace.yaml ./
# pnpm-lock.yaml 을 빌드 컨텍스트에 복사해야 --frozen-lockfile 가 동작한다.
# 누락 시 pnpm 이 package.json semver range 로 매번 새로 resolve 하여
# 동일 코드가 빌드 시점마다 다른 transitive 버전으로 묶여 "Invalid array
# passed to renderSpec" 류 회귀를 일으킨다 (실제 prod 사고 사례).
COPY pnpm-lock.yaml ./
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/
# mobile 의 package.json 도 lockfile 해석에 필요 (workspace 전체가 정합).
COPY mobile/package.json ./mobile/
# 전체 workspace 설치 — shared 의 peerDep (axios, js-cookie) 을 frontend 의
# 실제 의존성으로 해석해 shared/src 파일의 타입 체크가 가능하도록.
# --frozen-lockfile: lockfile 의 정확한 버전을 강제. 재현 가능한 빌드 보장.
RUN pnpm install --frozen-lockfile
# 혹시라도 shared 쪽 node_modules 가 비어 있으면 뒤 단계 COPY 실패를 막는다.
RUN mkdir -p shared/node_modules frontend/node_modules mobile/node_modules node_modules

FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/frontend/node_modules ./frontend/node_modules
COPY --from=deps /repo/shared/node_modules ./shared/node_modules
COPY shared/ ./shared/
COPY frontend/ ./frontend/
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo/frontend
# public/ 디렉터리가 repo 에 없을 수 있어 runner 의 COPY 가 실패하지 않도록 사전 생성.
RUN mkdir -p public && pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Seoul
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone
# monorepo standalone: server.js 는 /app/frontend/server.js 로 만들어지므로
# public 도 server.js 와 같은 레벨(/app/frontend/public)에 두어야 정적 자산이
# 노출된다. /app/public 으로 복사하면 Next.js 가 못 찾아 /fonts/* 등이 404.
COPY --from=builder /repo/frontend/.next/standalone ./
COPY --from=builder /repo/frontend/public ./frontend/public
COPY --from=builder /repo/frontend/.next/static ./frontend/.next/static
EXPOSE 4000
# standalone build 는 frontend/server.js 로 엔트리포인트가 만들어진다.
CMD ["node", "frontend/server.js"]
