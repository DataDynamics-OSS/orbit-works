/**
 * 회사 자산 카테고리 · 상태 상수.
 *
 * 백엔드 `app/schemas/asset.py::AssetCategory` / `AssetStatus` Literal 과 동기화 필수.
 * 새 카테고리 추가 시 backend 모델·DB·이 파일을 같이 고친다.
 */

export const ASSET_CATEGORIES = [
  "LAPTOP",
  "DESKTOP",
  "SERVER",
  "MONITOR",
  "PROJECTOR",
  "DESK",
  "CHAIR",
  "PHONE",
  "TABLET",
  "PRINTER",
  "NETWORK",
  "PERIPHERAL",
  "FURNITURE",
  "SOFTWARE",
  "SPEAKER",
  "TV",
  "AIR_PURIFIER",
  "WATER_PURIFIER",
  "REFRIGERATOR",
  "BIDET",
  "BUILDING",
  "OFFICE",
  "LAND",
  "CERTIFICATION",
  "OTHER",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_CATEGORY_LABEL: Record<AssetCategory, string> = {
  LAPTOP: "노트북",
  DESKTOP: "데스크톱",
  SERVER: "서버",
  MONITOR: "모니터",
  PROJECTOR: "빔프로젝터",
  DESK: "책상",
  CHAIR: "의자",
  PHONE: "휴대전화",
  TABLET: "태블릿",
  PRINTER: "프린터",
  NETWORK: "네트워크 장비",
  PERIPHERAL: "주변기기",
  FURNITURE: "가구",
  SOFTWARE: "소프트웨어",
  SPEAKER: "스피커",
  TV: "TV",
  AIR_PURIFIER: "공기청정기",
  WATER_PURIFIER: "정수기",
  REFRIGERATOR: "냉장고",
  BIDET: "비데",
  BUILDING: "건물",
  OFFICE: "사무실",
  LAND: "토지",
  CERTIFICATION: "인증",
  OTHER: "기타",
};

export const ASSET_STATUSES = ["IN_USE", "IN_STORAGE", "DISPOSED"] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  IN_USE: "사용중",
  IN_STORAGE: "보관",
  DISPOSED: "폐기",
};

export const ASSET_STATUS_BADGE: Record<AssetStatus, string> = {
  IN_USE: "bg-blue-100 text-blue-700 border-blue-200",
  IN_STORAGE: "bg-amber-100 text-amber-700 border-amber-200",
  DISPOSED: "bg-gray-200 text-gray-600 border-gray-300",
};
