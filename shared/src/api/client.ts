import axios, { AxiosInstance } from "axios";
import Cookies from "js-cookie";

export const TOKEN_COOKIE = "dlm_token";

export type ApiClientOptions = {
  baseURL?: string;
  // 인증 실패 시 이동할 로그인 경로. 데스크톱="/login", 모바일="/m/login".
  loginPath?: string;
};

export function createApiClient(opts: ApiClientOptions = {}): AxiosInstance {
  const baseURL = opts.baseURL ?? "/api/v1";
  const loginPath = opts.loginPath ?? "/login";

  // indexes: null — 배열 쿼리 파라미터를 `key[]=...` 대신 반복 키(`key=a&key=b`)
  // 로 직렬화. FastAPI 의 Query(list[str]) 는 반복 키 포맷만 인식하므로 이게
  // 기본이어야 `?sources=nipa&sources=keit` 같은 다중 선택 필터가 제대로 먹는다.
  const api = axios.create({
    baseURL,
    paramsSerializer: { indexes: null },
  });

  api.interceptors.request.use((config) => {
    const token = Cookies.get(TOKEN_COOKIE);
    if (token) {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
    }
    return config;
  });

  api.interceptors.response.use(
    (r) => r,
    (error) => {
      if (typeof window !== "undefined" && error?.response?.status === 401) {
        Cookies.remove(TOKEN_COOKIE);
        if (!window.location.pathname.startsWith(loginPath)) {
          window.location.href = loginPath;
        }
      }
      return Promise.reject(error);
    },
  );

  return api;
}

export function setToken(token: string): void {
  Cookies.set(TOKEN_COOKIE, token, { sameSite: "strict" });
}

export function clearToken(): void {
  Cookies.remove(TOKEN_COOKIE);
}

export function getToken(): string | undefined {
  return Cookies.get(TOKEN_COOKIE);
}
