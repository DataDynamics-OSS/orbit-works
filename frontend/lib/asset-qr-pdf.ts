/**
 * 회사 자산 QR 라벨 PDF 생성 헬퍼.
 *
 * Formtec QR-3111 (A4 · 8×13 = 104칸 · 12×12mm) 전용. jsPDF + qrcode 로
 * mm 단위 절대좌표에 QR + 자산번호 텍스트를 배치해 다운로드한다.
 *
 * 인쇄 시 PDF 뷰어에서 반드시 **"실제 크기(Actual Size) 100%"** 로 출력해야
 * 라벨지와 1:1 맞는다 (페이지 맞춤 / 축소 옵션은 끌 것).
 */

import jsPDF from "jspdf";
import QRCode from "qrcode";

// Formtec QR-3111 물리 레이아웃 (mm). 첫 테스트 인쇄 후 맞지 않으면 이 값만 조정.
export const QR3111_LAYOUT = {
  COLS: 8,
  ROWS: 13,
  LABEL_W: 12,
  LABEL_H: 12,
  MARGIN_LEFT: 11.5,
  MARGIN_TOP: 10.5,
  PITCH_X: 25, // 좌측 라벨 edge → 다음 라벨 edge 까지의 거리
  PITCH_Y: 22,
};

// 라벨 내부 레이아웃: 상단 QR + 하단 자산번호 텍스트.
const CELL = {
  QR_SIZE: 8.5,
  QR_OFFSET_X: (12 - 8.5) / 2, // 1.75mm (가로 중앙)
  TEXT_GAP: 0.3,
  TEXT_BASELINE_Y_FROM_CELL_TOP: 8.5 + 0.3 + 2.2, // ≈11mm from cell top
  FONT_SIZE_PT: 5,
  FONT_SIZE_MIN_PT: 3.5,
};

export const QR3111_CELLS_PER_SHEET =
  QR3111_LAYOUT.COLS * QR3111_LAYOUT.ROWS;

/**
 * QR payload — 폰 카메라 스캔 시 모바일 PWA (/m) 스캔 라우트로 진입.
 * `window.location.origin` 이 있으면 절대 URL, 없으면 상대 경로.
 */
export function assetScanUrl(assetNo: string): string {
  if (typeof window === "undefined") return `/m/assets/scan/${assetNo}`;
  return `${window.location.origin}/m/assets/scan/${assetNo}`;
}

export type PrintableAsset = { asset_no: string };

export type PdfOptions = {
  /** 앞의 N 칸을 공백으로 두고 그 다음부터 자산을 채움. 부분 사용된 라벨지 재활용. */
  startOffset?: number;
  /** 다운로드 파일명 base (확장자 제외). 미지정 시 타임스탬프 사용. */
  fileNameBase?: string;
};

/**
 * 선택된 자산들의 QR 라벨 PDF 를 생성해 즉시 다운로드.
 *
 * - 각 라벨 = QR 8.5mm + 자산번호 텍스트 (Helvetica Bold 5pt, 필요 시 자동 축소).
 * - 104칸 초과 자산이면 자동으로 다음 페이지를 추가.
 */
export async function downloadAssetQrLabelsPdf(
  assets: PrintableAsset[],
  options: PdfOptions = {},
): Promise<void> {
  if (assets.length === 0) return;
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));

  // A4 세로, mm 단위. precision 16 은 소수점 좌표 유지.
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // 각 자산별 QR data URL 을 병렬 생성. 512px PNG, errorCorrectionLevel 'L'.
  // 12mm 인쇄 시 600dpi ≈ 283px 이지만 512 로 받아 다운스케일되며 선명도 유지.
  const qrSize = 512;
  const qrs = await Promise.all(
    assets.map((a) =>
      QRCode.toDataURL(assetScanUrl(a.asset_no), {
        width: qrSize,
        margin: 0,
        errorCorrectionLevel: "L",
      }).then((dataUrl) => ({ asset: a, dataUrl })),
    ),
  );

  doc.setFont("helvetica", "bold");

  // 칸 번호 = 0 부터 시작. 앞 startOffset 칸은 공백, 이후 자산 채움.
  let cellIndex = startOffset;
  for (let i = 0; i < qrs.length; i += 1) {
    const pageIdx = Math.floor(cellIndex / QR3111_CELLS_PER_SHEET);
    const localIdx = cellIndex % QR3111_CELLS_PER_SHEET;

    // 새 페이지 진입 시 addPage (0 번 시트는 기본 생성된 페이지).
    if (pageIdx > 0 && localIdx === 0) doc.addPage();

    const col = localIdx % QR3111_LAYOUT.COLS;
    const row = Math.floor(localIdx / QR3111_LAYOUT.COLS);
    const cellX = QR3111_LAYOUT.MARGIN_LEFT + col * QR3111_LAYOUT.PITCH_X;
    const cellY = QR3111_LAYOUT.MARGIN_TOP + row * QR3111_LAYOUT.PITCH_Y;

    // QR — 셀 상단 중앙.
    doc.addImage(
      qrs[i].dataUrl,
      "PNG",
      cellX + CELL.QR_OFFSET_X,
      cellY,
      CELL.QR_SIZE,
      CELL.QR_SIZE,
    );

    // 자산번호 — 하단 중앙, 너무 길면 자동 축소.
    const label = qrs[i].asset.asset_no;
    const maxTextW = QR3111_LAYOUT.LABEL_W - 0.3;
    let fontSize = CELL.FONT_SIZE_PT;
    doc.setFontSize(fontSize);
    while (doc.getTextWidth(label) > maxTextW && fontSize > CELL.FONT_SIZE_MIN_PT) {
      fontSize -= 0.25;
      doc.setFontSize(fontSize);
    }
    const textW = doc.getTextWidth(label);
    const textX = cellX + (QR3111_LAYOUT.LABEL_W - textW) / 2;
    const textY = cellY + CELL.TEXT_BASELINE_Y_FROM_CELL_TOP;
    doc.text(label, textX, textY);

    cellIndex += 1;
  }

  const fname =
    options.fileNameBase ??
    `orbit-qr-labels-${new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "")
      .replace("T", "-")}`;
  doc.save(`${fname}.pdf`);
}
