// 인증 관련 재노출. 토큰 조작은 @orbit/shared/api 에서, 타입은 /types 에서.
export { setToken, clearToken, getToken, TOKEN_COOKIE } from "../api/client";
export type { MeUser } from "../types/auth";
