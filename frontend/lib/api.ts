// 얇은 호환 레이어 — 실제 구현은 @orbit/shared/api 에 있다.
// 기존 호출부 (`import { api, setToken, clearToken } from "@/lib/api"`) 를
// 깨지 않도록 같은 이름으로 재노출.

import { createApiClient } from "@orbit/shared/api";

export const api = createApiClient({ baseURL: "/api/v1", loginPath: "/login" });

export {
  TOKEN_COOKIE,
  setToken,
  clearToken,
  getToken,
} from "@orbit/shared/api";
