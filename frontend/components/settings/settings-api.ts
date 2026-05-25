/**
 * 런타임 설정(`/api/v1/settings/{section}`) 조회/저장을 위한 공통 helper.
 *
 * 백엔드는 섹션당 JSONB blob 하나. 프런트는 GET 으로 받은 값 그대로 form state
 * 에 넣고, 저장 시 전체 body 를 PUT 으로 보낸다. 시크릿 필드는 서버가 `***xxxx`
 * 로 마스킹해 주며, UI 에서 수정하지 않으면 그 마스킹된 문자열이 그대로 되돌아가
 * 서버가 "유지" 로 해석.
 */

import { api } from "@/lib/api";

export async function fetchSection<T>(section: string): Promise<T> {
  return (await api.get(`/settings/${section}`)).data as T;
}

export async function saveSection<T>(section: string, payload: T): Promise<T> {
  return (await api.put(`/settings/${section}`, payload)).data as T;
}

export async function resetSection(section: string): Promise<void> {
  await api.delete(`/settings/${section}`);
}
