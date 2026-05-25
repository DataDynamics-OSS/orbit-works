"use client";

/**
 * 회사 자산 상세 페이지.
 * - 정보 표시 (목록 페이지의 수정 다이얼로그에서 편집).
 * - 사진 1장 업로드/교체/삭제. object URL 캐시는 fileName 바뀌면 재생성.
 * - QR 라벨 단건 인쇄 (선택: /assets/print?ids=xxx 로 이동).
 */

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, QrCode, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { PrintQrDialog } from "@/components/assets/PrintQrDialog";
import {
  ASSET_CATEGORY_LABEL,
  ASSET_STATUS_BADGE,
  ASSET_STATUS_LABEL,
  type AssetCategory,
  type AssetStatus,
} from "@/lib/asset-categories";

type AssetDetail = {
  id: string;
  asset_no: string;
  category: AssetCategory;
  manufacturer: string | null;
  model_name: string | null;
  serial_no: string | null;
  spec: string | null;
  purchase_date: string | null;
  purchase_vendor: string | null;
  purchase_price: string | number | null;
  warranty_expires: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_tag: string | null;
  status: AssetStatus;
  location: string | null;
  memo: string | null;
  photo_name: string | null;
  has_photo: boolean;
  created_at: string;
  updated_at: string;
};

export default function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const dialog = useDialog();

  const [printOpen, setPrintOpen] = useState(false);

  const { data: asset } = useQuery<AssetDetail>({
    queryKey: ["asset", id],
    queryFn: async () => (await api.get(`/assets/${id}`)).data,
  });

  // 사진 blob 캐시. photo_name 이 바뀌면 (업로드/삭제) 재fetch.
  const { data: photoBlob } = useQuery<Blob | null>({
    queryKey: ["asset-photo", id, asset?.photo_name],
    queryFn: async () => {
      if (!asset?.has_photo) return null;
      const res = await api.get(`/assets/${id}/photo`, { responseType: "blob" });
      return res.data as Blob;
    },
    enabled: Boolean(asset?.has_photo),
    staleTime: 60_000,
  });

  // Blob → object URL. 언마운트 시 revoke.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photoBlob) {
      setPhotoUrl(null);
      return;
    }
    const url = URL.createObjectURL(photoBlob);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photoBlob]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(`/assets/${id}/photo`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["asset", id] });
      qc.invalidateQueries({ queryKey: ["asset-photo", id] });
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "업로드 실패");
    },
  });

  const deletePhotoM = useMutation({
    mutationFn: async () => api.delete(`/assets/${id}/photo`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["asset", id] });
      qc.invalidateQueries({ queryKey: ["asset-photo", id] });
    },
  });

  if (!asset) {
    return (
      <>
        <DashboardHeader title="자산 상세" />
        <div className="p-6 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader title={`자산 ${asset.asset_no}`} />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto max-w-5xl">
        <div className="flex items-center gap-2">
          <Link
            href="/assets"
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
            목록
          </Link>
          <button
            type="button"
            onClick={() => setPrintOpen(true)}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <QrCode className="h-4 w-4" />
            QR 라벨 인쇄
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* 사진 */}
          <section className="rounded-lg border border-border bg-card p-4 md:col-span-1">
            <h2 className="text-sm font-semibold mb-2">사진</h2>
            <div className="flex h-48 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 overflow-hidden">
              {photoUrl ? (
                <img
                  src={photoUrl}
                  alt={asset.photo_name ?? "자산 사진"}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-xs text-muted-foreground">등록된 사진 없음</span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadM.mutate(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadM.isPending}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadM.isPending ? "업로드 중..." : asset.has_photo ? "교체" : "업로드"}
              </button>
              {asset.has_photo && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await dialog.confirm("사진을 삭제하시겠습니까?", { destructive: true })) {
                      deletePhotoM.mutate();
                    }
                  }}
                  disabled={deletePhotoM.isPending}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  삭제
                </button>
              )}
            </div>
            {asset.photo_name && (
              <div className="mt-1 text-[11px] text-muted-foreground truncate">
                {asset.photo_name}
              </div>
            )}
          </section>

          {/* 기본 정보 */}
          <section className="rounded-lg border border-border bg-card p-4 md:col-span-2 space-y-3">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center h-5 rounded border px-1.5 text-[11px] font-medium leading-none ${ASSET_STATUS_BADGE[asset.status]}`}
              >
                {ASSET_STATUS_LABEL[asset.status]}
              </span>
              <span className="text-sm text-muted-foreground">
                {ASSET_CATEGORY_LABEL[asset.category]}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <InfoRow label="자산번호"><span className="font-mono">{asset.asset_no}</span></InfoRow>
              <InfoRow label="소유자">
                {asset.owner_name ? (
                  <>
                    {asset.owner_name}
                    {asset.owner_tag && ` [${asset.owner_tag}]`}
                  </>
                ) : (
                  <span className="text-muted-foreground">— 없음 / 공용 —</span>
                )}
              </InfoRow>
              <InfoRow label="제조사">{asset.manufacturer || "-"}</InfoRow>
              <InfoRow label="제품명">{asset.model_name || "-"}</InfoRow>
              <InfoRow label="일련번호" span={2}>{asset.serial_no || "-"}</InfoRow>
              <InfoRow label="상세 사양" span={2}>
                <span className="whitespace-pre-wrap">{asset.spec || "-"}</span>
              </InfoRow>
              <InfoRow label="구입일">{asset.purchase_date || "-"}</InfoRow>
              <InfoRow label="구입가">
                {asset.purchase_price == null
                  ? "-"
                  : Number(asset.purchase_price).toLocaleString("ko-KR") + " 원"}
              </InfoRow>
              <InfoRow label="구입처">{asset.purchase_vendor || "-"}</InfoRow>
              <InfoRow label="AS 만료일">{asset.warranty_expires || "-"}</InfoRow>
              <InfoRow label="위치 / 부서" span={2}>{asset.location || "-"}</InfoRow>
              <InfoRow label="메모" span={2}>
                <span className="whitespace-pre-wrap">{asset.memo || "-"}</span>
              </InfoRow>
            </div>
          </section>
        </div>
      </div>

      {/* QR 라벨 PDF — 단건이라도 시작 칸 오프셋 조절 후 발급 가능. */}
      <PrintQrDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        assets={[{ asset_no: asset.asset_no }]}
      />
    </>
  );
}

function InfoRow({
  label,
  children,
  span,
}: {
  label: string;
  children: React.ReactNode;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : ""}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}
