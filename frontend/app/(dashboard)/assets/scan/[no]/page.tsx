"use client";

/**
 * QR 스캔 라우트 — `/assets/scan/DDA-YYYY-NNNN`.
 * 자산번호로 단건 조회 후 상세 페이지로 리다이렉트. 로그인 세션이 없으면
 * Axios 인터셉터가 /login?next=... 로 보내므로 별도 가드 불필요.
 */

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";

export default function AssetScanPage({
  params,
}: {
  params: Promise<{ no: string }>;
}) {
  const { no } = use(params);
  const router = useRouter();

  const { data, isError, error } = useQuery<{ id: string }>({
    queryKey: ["asset-by-number", no],
    queryFn: async () => (await api.get(`/assets/by-number/${no}`)).data,
    retry: false,
  });

  useEffect(() => {
    if (data?.id) router.replace(`/assets/${data.id}`);
  }, [data, router]);

  return (
    <>
      <DashboardHeader title={`자산 스캔 — ${no}`} />
      <div className="p-6 text-sm">
        {isError ? (
          <div className="rounded-md border border-destructive/40 bg-red-50 p-4 text-destructive">
            {(error as any)?.response?.data?.detail ?? "자산을 찾을 수 없습니다."}
          </div>
        ) : (
          <div className="text-muted-foreground">조회 중...</div>
        )}
      </div>
    </>
  );
}
