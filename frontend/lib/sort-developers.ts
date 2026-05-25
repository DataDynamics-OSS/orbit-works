/**
 * 임직원 목록을 UI 에 노출할 때의 표준 정렬.
 *
 * 1차: ACTIVE(재직) 상단, INACTIVE/미상 말미 — 실수 선택 방지.
 * 2차: 이름 가나다 (한글 자모 기반, `localeCompare("ko")`).
 *
 * 임직원 picker 를 추가할 때는 이 함수를 거쳐서 옵션을 생성할 것. 여러 페이지
 * 에서 정렬 규칙이 제각각이라 이 헬퍼로 통일.
 */

/**
 * 호출자의 구체 타입(T)을 보존하면서 제약을 느슨하게 — name 필수, status 는
 * 있어도 되고 없어도 됨(타입·리터럴 무관). ACTIVE 아니면 전부 "비활성" 으로 분류.
 */
export type DeveloperLike = {
  name: string;
  status?: string | null;
};

export function sortDevelopersKo<T extends DeveloperLike>(devs: T[]): T[] {
  return [...devs].sort((a, b) => {
    // status 미정이면 ACTIVE 와 동일 취급 (필드가 없는 directory 응답 등).
    const ra = a.status == null || a.status === "ACTIVE" ? 0 : 1;
    const rb = b.status == null || b.status === "ACTIVE" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.name ?? "").localeCompare(b.name ?? "", "ko");
  });
}
