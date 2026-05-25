"use client";

/**
 * 자산 QR 라벨 PDF 생성 다이얼로그.
 *
 * 상위 컴포넌트가 선택된 자산(asset_no 만 필요) 을 넘기면 시작 칸 오프셋을
 * 입력받아 PDF 를 생성·다운로드한다.
 *
 * 별도 전용 라우트를 두지 않고 이 다이얼로그만으로 흐름을 마감 — 목록의
 * 체크박스 선택 + "QR 라벨 인쇄" 버튼으로 바로 진입한다.
 */

import { useState } from "react";
import { Download } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import {
  QR3111_CELLS_PER_SHEET,
  downloadAssetQrLabelsPdf,
  type PrintableAsset,
} from "@/lib/asset-qr-pdf";

export function PrintQrDialog({
  open,
  onClose,
  assets,
}: {
  open: boolean;
  onClose: () => void;
  assets: PrintableAsset[];
}) {
  const [startOffset, setStartOffset] = useState(0);
  const [generating, setGenerating] = useState(false);

  async function handleDownload() {
    if (assets.length === 0) return;
    setGenerating(true);
    try {
      await downloadAssetQrLabelsPdf(assets, { startOffset });
      onClose();
    } finally {
      setGenerating(false);
    }
  }

  const totalCells = assets.length + startOffset;
  const sheets = Math.max(1, Math.ceil(totalCells / QR3111_CELLS_PER_SHEET));

  return (
    <Dialog
      open={open}
      onClose={generating ? () => {} : onClose}
      title="QR 라벨 PDF 생성"
      width="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={assets.length === 0 || generating}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {generating ? "생성 중..." : "PDF"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md bg-muted/40 border border-border p-3 text-xs space-y-1">
          Formtec <b>QR-3111</b> (A4 · 8×13 = 104칸 · 12×12mm) 전용. 각 라벨에는
          상단 QR + 하단 자산번호가 함께 인쇄됩니다. PDF 뷰어에서 반드시
          <b className="mx-1">"실제 크기(Actual Size) 100%"</b> 로 인쇄해야 라벨지와
          정렬이 맞습니다 (페이지 맞춤 / 축소 옵션은 끌 것).
        </div>

        <div className="rounded-md border border-border p-3 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">선택한 자산</span>
          <span className="font-medium">
            {assets.length}개 · 시트 {sheets}장
          </span>
        </div>

        <label className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-20 shrink-0">시작 칸</span>
          <input
            type="number"
            min={0}
            max={QR3111_CELLS_PER_SHEET - 1}
            value={startOffset}
            onChange={(e) =>
              setStartOffset(
                Math.max(
                  0,
                  Math.min(
                    QR3111_CELLS_PER_SHEET - 1,
                    Number(e.target.value) || 0,
                  ),
                ),
              )
            }
            className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
          />
          <span className="text-[11px] text-muted-foreground">
            0 = 첫 칸부터. 부분 사용된 라벨지 재활용 시 사용.
          </span>
        </label>

        {assets.length > 0 && (
          <details className="rounded-md border border-border p-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              포함되는 자산번호 {assets.length}개
            </summary>
            <div className="mt-2 max-h-40 overflow-auto font-mono leading-5">
              {assets.map((a) => (
                <div key={a.asset_no}>{a.asset_no}</div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Dialog>
  );
}
