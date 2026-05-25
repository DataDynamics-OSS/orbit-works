"use client";

/**
 * SUPER_ADMIN — 백업 관리 (시스템 전역). 두 종류의 백업을 같은 디렉터리에서
 * 관리:
 *   - 데이터베이스 백업 (kind=db)   : pg_dump → ZIP. 자동 cron + 수동.
 *   - Data 디렉토리 백업 (kind=data) : upload.dir 전체 → ZIP. 수동만.
 *
 * 백엔드 /backups 엔드포인트는 require_super_admin 으로 가드됨.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Play, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { TabBar, TabItem } from "@/components/ui/TabBar";

type BackupKind = "db" | "data";

type BackupFile = { name: string; size: number; mtime: string };
type BackupList = { dir: string; files: BackupFile[] };

const KIND_LABEL: Record<BackupKind, string> = {
  db: "데이터베이스 백업",
  data: "Data 디렉토리 백업",
};

const KIND_RUN_LABEL: Record<BackupKind, string> = {
  db: "지금 실행",
  data: "지금 실행 (시간 소요 가능)",
};

const KIND_DESC: Record<BackupKind, string> = {
  db: "pg_dump 결과를 ZIP 으로 압축. 자동 스케줄에 따라 정기 실행되며 여기서 수동 실행도 가능.",
  data: "upload.dir(첨부·이미지 등) 전체를 ZIP 으로 압축. 자동 cron 없음 — 수동 실행만 지원. 백업 디렉토리 자체는 ZIP 에서 제외.",
};

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function BackupsPage() {
  const [tab, setTab] = useState<BackupKind>("db");
  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">백업</h1>
      </div>
      <div className="px-4 pt-3">
        <TabBar>
          <TabItem active={tab === "db"} onClick={() => setTab("db")}>
            데이터베이스 백업
          </TabItem>
          <TabItem active={tab === "data"} onClick={() => setTab("data")}>
            Data 디렉토리 백업
          </TabItem>
        </TabBar>
      </div>
      <BackupPane kind={tab} />
    </>
  );
}

function BackupPane({ kind }: { kind: BackupKind }) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data, isFetching } = useQuery<BackupList>({
    queryKey: ["admin-backups", kind],
    queryFn: async () => (await api.get("/backups", { params: { kind } })).data,
    refetchOnWindowFocus: false,
  });

  const runM = useMutation({
    mutationFn: async () =>
      (await api.post("/backups/run", null, { params: { kind } })).data,
    onSuccess: async (r: any) => {
      qc.invalidateQueries({ queryKey: ["admin-backups", kind] });
      const f = r?.file ?? r;
      await dialog.alert(
        `${KIND_LABEL[kind]} 완료: ${f?.name ?? ""} (${humanBytes(f?.size ?? 0)})`,
      );
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "백업 실패", { title: "오류" }),
  });

  async function download(name: string) {
    const res = await api.get(
      `/backups/${encodeURIComponent(name)}/download`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function remove(name: string) {
    if (!(await dialog.confirm(`${name} 을(를) 삭제하시겠습니까?`, { destructive: true }))) {
      return;
    }
    await api.delete(`/backups/${encodeURIComponent(name)}`);
    qc.invalidateQueries({ queryKey: ["admin-backups", kind] });
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            저장 위치: <span className="font-mono">{data?.dir ?? "—"}</span>
          </div>
          <div className="text-xs text-muted-foreground">{KIND_DESC[kind]}</div>
        </div>
        <button
          type="button"
          onClick={() => runM.mutate()}
          disabled={runM.isPending}
          className="h-8 shrink-0 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          {runM.isPending ? "실행 중..." : KIND_RUN_LABEL[kind]}
        </button>
      </div>
      {isFetching && !data ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : !data || data.files.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          백업 파일이 없습니다.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-sm uppercase text-muted-foreground">
              <tr>
                <th className="p-2 text-left">파일명</th>
                <th className="p-2 text-right">크기</th>
                <th className="p-2 text-left">생성</th>
                <th className="p-2 text-right">작업</th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((f) => (
                <tr key={f.name} className="border-t border-border">
                  <td className="p-2 font-mono">{f.name}</td>
                  <td className="p-2 text-right tabular-nums">{humanBytes(f.size)}</td>
                  <td className="p-2">{fmtDate(f.mtime)}</td>
                  <td className="p-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        onClick={() => download(f.name)}
                        className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-sm hover:bg-muted"
                      >
                        <Download className="h-3 w-3" /> 다운로드
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(f.name)}
                        className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 text-sm text-destructive hover:bg-destructive/20"
                      >
                        <Trash2 className="h-3 w-3" /> 삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
