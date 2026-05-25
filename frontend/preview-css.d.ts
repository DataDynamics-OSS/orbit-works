// 첨부 미리보기 — 외부 패키지 CSS side-effect import 의 타입 선언.
// Next.js 가 런타임엔 CSS 를 처리하지만 TypeScript 모듈 해석엔 별도.
declare module "highlight.js/styles/*.css";
declare module "docx-preview/dist/docx-preview.css";
