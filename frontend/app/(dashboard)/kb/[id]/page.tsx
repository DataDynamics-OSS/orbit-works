"use client";

/**
 * 지식 베이스 (KB) — 상세 페이지.
 *
 * 표시 모드 / 편집 모드 토글:
 * - 표시 모드 (기본): TipTap viewer + 메타 박스 + 첨부 리스트 + 작성자/수정일.
 * - 편집 모드 (kb.write 또는 작성자): 제목·메타·태그·body 편집 + 저장/취소.
 *
 * 첨부 업로드: FileDropZone (회의록 패턴). 다운로드는 axios blob → object URL.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Download,
  Edit2,
  ExternalLink,
  FileText,
  ListOrdered,
  Paperclip,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { TipTapEditor, TipTapViewer } from "@/components/board/TipTapEditor";
import { CatalogTriple } from "@/components/catalog/CatalogTriple";
import { KbToc, applyHeadingIds, extractKbHeadings } from "@/components/kb/KbToc";

type KbType = "DOC" | "KB";
type KbVisibility = "all" | "manager" | "admin";

type Attachment = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  uploaded_by: string | null;
  created_at: string;
};

type SourceLink = { name: string; url: string };

type KbDetail = {
  id: string;
  title: string;
  type: KbType;
  vendor_id: string | null;
  vendor_name: string | null;
  product_id: string | null;
  product_name: string | null;
  version_id: string | null;
  version_name: string | null;
  category: string | null;
  tags: string[];
  body: string | null;
  plain_text: string | null;
  source_url: string | null;       // legacy
  source_links: SourceLink[];
  resolved: boolean;
  visibility: KbVisibility;
  author_user_id: string | null;
  author_name: string | null;
  attachments: Attachment[];
  created_at: string;
  updated_at: string;
};

type Vendor = { id: string; name: string };
type Product = { id: string; vendor_id: string; name: string };
type Version = { id: string; product_id: string; name: string };

const TYPE_LABEL: Record<KbType, string> = { DOC: "벤더 자료", KB: "노하우" };

export default function KbDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const id = String(params.id);

  const [editMode, setEditMode] = useState(false);
  // TOC 패널 — 회의록 패턴. localStorage 영속. SSR mismatch 방지 위해 useState
  // initializer 안에서 localStorage 1회 읽음.
  const [tocOpen, setTocOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("kbTocOpen") !== "0";
    } catch {
      return true;
    }
  });
  const [tocWidth, setTocWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 240;
    try {
      const v = Number(localStorage.getItem("kbTocWidth"));
      return Number.isFinite(v) && v >= 160 && v <= 720 ? v : 240;
    } catch {
      return 240;
    }
  });

  const { data: detail } = useQuery<KbDetail>({
    queryKey: ["kb-entry", id],
    queryFn: async () => (await api.get(`/kb-entries/${id}`)).data,
  });
  const { data: me } = useQuery<{ id: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  // kb.write 보유 여부 — feature_permissions API 로 확인.
  const { data: featurePerms = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["feature-permissions"],
    queryFn: async () => (await api.get("/feature-permissions")).data,
    staleTime: 5 * 60_000,
  });
  const canEdit = useMemo(() => {
    if (!me) return false;
    if (me.role === "ADMIN" || me.role === "SUPER_ADMIN") return true;
    if (detail && detail.author_user_id === me.id) return true;
    return (featurePerms["kb.write"] ?? []).includes(me.role);
  }, [me, detail, featurePerms]);
  // 삭제는 write 와 분리 — kb.delete 또는 작성자 본인 또는 ADMIN.
  const canDelete = useMemo(() => {
    if (!me) return false;
    if (me.role === "ADMIN" || me.role === "SUPER_ADMIN") return true;
    if (detail && detail.author_user_id === me.id) return true;
    return (featurePerms["kb.delete"] ?? []).includes(me.role);
  }, [me, detail, featurePerms]);

  if (!detail) {
    return (
      <>
        <DashboardHeader title="지식 베이스" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="지식 베이스"
        actions={
          <button
            type="button"
            onClick={() => router.push("/kb")}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 목록
          </button>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-y-auto">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            작성 {detail.author_name ?? "—"} · 수정 {detail.updated_at.slice(0, 10)}
          </span>
          {canEdit && !editMode && (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-muted ml-auto"
            >
              <Edit2 className="h-3.5 w-3.5" /> 편집
            </button>
          )}
          {/* 편집 버튼 오른쪽 — TOC 토글. 편집 버튼 없으면 ml-auto 로 우측 정렬. */}
          <button
            type="button"
            onClick={() => {
              const next = !tocOpen;
              setTocOpen(next);
              try {
                localStorage.setItem("kbTocOpen", next ? "1" : "0");
              } catch {
                /* ignore */
              }
            }}
            className={
              "h-8 inline-flex items-center gap-1 rounded-md border px-2.5 text-xs " +
              (canEdit && !editMode ? "" : "ml-auto ") +
              (tocOpen
                ? "border-primary text-primary bg-primary/5 hover:bg-primary/10"
                : "border-border hover:bg-muted")
            }
            title="목차 패널 토글"
          >
            <ListOrdered className="h-3 w-3" />
            목차
          </button>
        </div>

        {editMode && canEdit ? (
          <EditMode
            detail={detail}
            tocOpen={tocOpen}
            tocWidth={tocWidth}
            onTocClose={() => {
              setTocOpen(false);
              try {
                localStorage.setItem("kbTocOpen", "0");
              } catch {
                /* ignore */
              }
            }}
            onTocWidthChange={(w) => {
              setTocWidth(w);
              try {
                localStorage.setItem("kbTocWidth", String(w));
              } catch {
                /* ignore */
              }
            }}
            onCancel={() => setEditMode(false)}
            onSaved={() => {
              setEditMode(false);
              qc.invalidateQueries({ queryKey: ["kb-entry", id] });
              qc.invalidateQueries({ queryKey: ["kb-entries"] });
            }}
            onDeleted={() => router.push("/kb")}
            canDelete={canDelete}
          />
        ) : (
          <ViewMode
            detail={detail}
            tocOpen={tocOpen}
            tocWidth={tocWidth}
            onTocClose={() => {
              setTocOpen(false);
              try {
                localStorage.setItem("kbTocOpen", "0");
              } catch {
                /* ignore */
              }
            }}
            onTocWidthChange={(w) => {
              setTocWidth(w);
              try {
                localStorage.setItem("kbTocWidth", String(w));
              } catch {
                /* ignore */
              }
            }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 표시 모드
// ---------------------------------------------------------------------------

function ViewMode({
  detail,
  tocOpen,
  tocWidth,
  onTocClose,
  onTocWidthChange,
}: {
  detail: KbDetail;
  tocOpen: boolean;
  tocWidth: number;
  onTocClose: () => void;
  onTocWidthChange: (w: number) => void;
}) {
  // 본문 컨테이너 ref — heading 에 id 부여하여 TOC 클릭 scroll target 활성.
  const bodyRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(
    () => extractKbHeadings(detail.body),
    [detail.body],
  );
  useEffect(() => {
    applyHeadingIds(bodyRef.current);
  }, [detail.body]);

  return (
    <div className="flex flex-1 min-h-0 gap-0">
      <article className="flex-1 min-w-0 rounded-md border border-border bg-card p-4 flex flex-col gap-3 overflow-auto">
        <header className="flex items-start justify-between gap-3 pb-3 border-b border-border">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">
                {TYPE_LABEL[detail.type]}
              </span>
            </div>
            <h1 className="text-lg font-bold">{detail.title}</h1>
            <MetaLine detail={detail} />
          </div>
        </header>

        <div ref={bodyRef}>
          {detail.body && <TipTapViewer html={detail.body} />}
          {!detail.body && (
            <div className="text-xs text-muted-foreground italic">본문이 비어 있습니다.</div>
          )}
        </div>

        {detail.attachments.length > 0 && (
          <section className="pt-3 border-t border-border">
            <h2 className="text-xs font-semibold mb-2 inline-flex items-center gap-1">
              <Paperclip className="h-3.5 w-3.5" /> 첨부 ({detail.attachments.length})
            </h2>
            <ul className="flex flex-col gap-1">
              {detail.attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">{a.file_name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtSize(a.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => downloadAttachment(detail.id, a)}
                    className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
                  >
                    <Download className="h-3 w-3" /> 다운로드
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>

      {tocOpen && (
        <>
          <TocSeparator width={tocWidth} onChange={onTocWidthChange} />
          <KbToc headings={headings} width={tocWidth} onClose={onTocClose} />
        </>
      )}
    </div>
  );
}

/** 본문 ↔ TOC 사이 드래그 가능 separator. 더블 클릭으로 기본값(240px) 복원. */
function TocSeparator({
  width,
  onChange,
}: {
  width: number;
  onChange: (w: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="목차 패널 폭 조절"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let latest = startWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const onMove = (ev: MouseEvent) => {
          // 마우스 ← : width 증가 (TOC 가 오른쪽 끝). → : 감소.
          const delta = startX - ev.clientX;
          latest = Math.max(160, Math.min(720, startWidth + delta));
          onChange(latest);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }}
      onDoubleClick={() => onChange(240)}
      className="shrink-0 w-1 cursor-col-resize bg-border hover:bg-primary/40 transition-colors"
      title="드래그하여 폭 조절 · 더블클릭으로 기본값(240px) 복원"
    />
  );
}

function MetaLine({ detail }: { detail: KbDetail }) {
  const items: { label: string; value: string | null }[] = [
    { label: "벤더", value: detail.vendor_name },
    { label: "제품", value: detail.product_name },
    { label: "버전", value: detail.version_name },
  ];
  const visible = items.filter((x) => x.value);
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
      {visible.map((x) => (
        <span key={x.label}>
          {x.label} <span className="text-foreground font-medium">{x.value}</span>
        </span>
      ))}
      {detail.tags.length > 0 &&
        detail.tags.map((t) => (
          <span key={t} className="inline-block rounded-full bg-muted px-2 py-0.5 text-[11px]">
            #{t}
          </span>
        ))}
      {detail.source_links.map((l, i) => (
        <a
          key={`${l.url}|${i}`}
          href={l.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> {l.name}
        </a>
      ))}
    </div>
  );
}

async function downloadAttachment(entryId: string, a: Attachment) {
  const res = await api.get(`/kb-entries/${entryId}/attachments/${a.id}/download`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = a.file_name;
  link.click();
  URL.revokeObjectURL(url);
}

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 편집 모드 — 메타 + body + 첨부 추가/삭제.
// ---------------------------------------------------------------------------

function EditMode({
  detail,
  tocOpen,
  tocWidth,
  onTocClose,
  onTocWidthChange,
  onCancel,
  onSaved,
  onDeleted,
  canDelete,
}: {
  detail: KbDetail;
  tocOpen: boolean;
  tocWidth: number;
  onTocClose: () => void;
  onTocWidthChange: (w: number) => void;
  onCancel: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  canDelete: boolean;
}) {
  const dialog = useDialog();
  const qc = useQueryClient();
  const [title, setTitle] = useState(detail.title);
  const [type, setType] = useState<KbType>(detail.type);
  const [vendorName, setVendorName] = useState(detail.vendor_name ?? "");
  const [productName, setProductName] = useState(detail.product_name ?? "");
  const [versionName, setVersionName] = useState(detail.version_name ?? "");
  const [tags, setTags] = useState<string[]>(detail.tags);
  const [body, setBody] = useState(detail.body ?? "");
  // 외부 자료 링크 — 최대 2개. {name, url}. UI 에 두 슬롯 항상 노출.
  const [sourceLinks, setSourceLinks] = useState<SourceLink[]>(() => {
    const arr = [...(detail.source_links ?? [])].slice(0, 2);
    while (arr.length < 2) arr.push({ name: "", url: "" });
    return arr;
  });
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  // TOC — body 변경 시 heading 추출 + TipTap editor 의 heading 들에 id 부여.
  const bodyRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(() => extractKbHeadings(body), [body]);
  useEffect(() => {
    applyHeadingIds(bodyRef.current);
  }, [body]);

  // 카탈로그 lookup — vendor/product/version 의 id 매핑 (입력은 자유 텍스트).
  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["catalog", "vendors", "active"],
    queryFn: async () => (await api.get("/catalog/vendors")).data,
    staleTime: 60_000,
  });
  const vendorId = useMemo(
    () => vendors.find((v) => v.name === vendorName)?.id ?? null,
    [vendors, vendorName],
  );
  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["catalog", "products", vendorId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/products", { params: { vendor_id: vendorId } })).data,
    enabled: !!vendorId,
    staleTime: 60_000,
  });
  const productId = useMemo(
    () => products.find((p) => p.name === productName)?.id ?? null,
    [products, productName],
  );
  const { data: versions = [] } = useQuery<Version[]>({
    queryKey: ["catalog", "versions", productId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/versions", { params: { product_id: productId } })).data,
    enabled: !!productId,
    staleTime: 60_000,
  });
  const versionId = useMemo(
    () => versions.find((v) => v.name === versionName)?.id ?? null,
    [versions, versionName],
  );

  const saveM = useMutation({
    mutationFn: async () => {
      // body 의 plain_text 캐시 — TipTap 본문에서 HTML 태그 제거한 단순 추출.
      const tmp = document.createElement("div");
      tmp.innerHTML = body || "";
      const plain = (tmp.textContent || "").trim();
      // 빈 row 제거 (둘 중 하나만 입력해도 무의미 — name·url 둘 다 있을 때만 보냄).
      const links = sourceLinks
        .map((l) => ({ name: l.name.trim(), url: l.url.trim() }))
        .filter((l) => l.name && l.url);
      const payload = {
        title: title.trim(),
        type,
        vendor_id: vendorId,
        product_id: productId,
        version_id: versionId,
        tags,
        body,
        plain_text: plain,
        source_links: links,
      };
      await api.patch(`/kb-entries/${detail.id}`, payload);
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        await api.post(`/kb-entries/${detail.id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      setPendingFiles([]);
      onSaved();
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteAttachmentM = useMutation({
    mutationFn: async (attId: string) =>
      api.delete(`/kb-entries/${detail.id}/attachments/${attId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb-entry", detail.id] }),
  });

  const deleteEntryM = useMutation({
    mutationFn: async () => api.delete(`/kb-entries/${detail.id}`),
    onSuccess: () => onDeleted(),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="제목 *" colSpan={2}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="구분" colSpan={2}>
          <div className="flex items-center gap-2">
            {(["KB", "DOC"] as KbType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={
                  "h-9 flex-1 rounded-md border text-sm " +
                  (type === t
                    ? "border-primary bg-primary/10"
                    : "border-border text-muted-foreground hover:bg-muted")
                }
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </Field>
        {/* 벤더 → 제품 → 버전 — 케이스 페이지의 CatalogTriple 그대로. 한 row 에 3 col. */}
        <div className="col-span-2 grid grid-cols-3 gap-3">
          <CatalogTriple
            vendor={vendorName}
            product={productName}
            version={versionName}
            onVendor={(v) => {
              setVendorName(v);
              setProductName("");
              setVersionName("");
            }}
            onProduct={(p) => {
              setProductName(p);
              setVersionName("");
            }}
            onVersion={setVersionName}
          />
        </div>
        <Field label="태그" colSpan={2}>
          <TagBadgeInput value={tags} onChange={setTags} />
        </Field>
        {type === "DOC" && (
          <Field label="외부 자료 링크 (최대 2개)" colSpan={2}>
            <div className="flex flex-col gap-2">
              {sourceLinks.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_2fr] gap-2 items-center">
                  <input
                    value={l.name}
                    onChange={(e) => {
                      const next = [...sourceLinks];
                      next[i] = { ...next[i], name: e.target.value };
                      setSourceLinks(next);
                    }}
                    placeholder={`표시명 ${i + 1} (예: 공식 문서)`}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <input
                    value={l.url}
                    onChange={(e) => {
                      const next = [...sourceLinks];
                      next[i] = { ...next[i], url: e.target.value };
                      setSourceLinks(next);
                    }}
                    placeholder="https://docs.example.com/..."
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                표시명·URL 둘 다 입력해야 저장됩니다. 빈 슬롯은 무시.
              </p>
            </div>
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">본문</span>
        <div className="flex min-h-[320px]">
          <div ref={bodyRef} className="flex-1 min-w-0">
            <TipTapEditor value={body} onChange={setBody} />
          </div>
          {tocOpen && (
            <>
              <TocSeparator width={tocWidth} onChange={onTocWidthChange} />
              <KbToc headings={headings} width={tocWidth} onClose={onTocClose} />
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">첨부</span>
        {detail.attachments.length > 0 && (
          <ul className="flex flex-col gap-1">
            {detail.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate">{a.file_name}</span>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await dialog.confirm(`'${a.file_name}' 첨부를 삭제할까요?`, {
                      title: "삭제 확인",
                      confirmText: "삭제",
                      destructive: true,
                    });
                    if (ok) deleteAttachmentM.mutate(a.id);
                  }}
                  className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-2 text-xs text-destructive hover:bg-red-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <FileDropZone
          onFiles={(arr) => setPendingFiles((prev) => [...prev, ...arr])}
        />
        {pendingFiles.length > 0 && (
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {pendingFiles.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="flex-1 truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="text-destructive hover:underline"
                >
                  제거
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        {canDelete && (
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm(
                "이 KB 항목과 모든 첨부를 삭제할까요?",
                { title: "삭제 확인", confirmText: "삭제", destructive: true },
              );
              if (ok) deleteEntryM.mutate();
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
          >
            <Trash2 className="h-3.5 w-3.5" /> 항목 삭제
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm"
          >
            <X className="h-3.5 w-3.5" /> 취소
          </button>
          <button
            type="button"
            disabled={saveM.isPending || !title.trim()}
            onClick={() => saveM.mutate()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> {saveM.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  const cls = colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// 배지 형태 태그 입력 — 텍스트 + Enter → push, X 클릭 → 제거.
// 빈 input 에서 Backspace → 마지막 배지 제거. 콤마(`,`)도 trigger 로 인식.
// 최대 3개 제한 — 3개 다 차면 input 비활성, placeholder 변경.
const MAX_TAGS = 3;
function TagBadgeInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const reachedMax = value.length >= MAX_TAGS;
  function commit() {
    const t = draft.trim();
    if (!t) return;
    if (reachedMax) {
      setDraft("");
      return;
    }
    if (value.includes(t)) {
      setDraft("");
      return;
    }
    onChange([...value, t]);
    setDraft("");
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 min-h-[36px]">
      {value.map((t, i) => (
        <span
          key={`${t}|${i}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs"
        >
          {t}
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-primary/70 hover:text-destructive"
            aria-label={`태그 ${t} 제거`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={reachedMax}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            remove(value.length - 1);
          }
        }}
        onBlur={commit}
        placeholder={
          reachedMax
            ? `최대 ${MAX_TAGS}개`
            : value.length === 0
              ? "태그 입력 후 Enter (예: install)"
              : ""
        }
        className="flex-1 min-w-[120px] text-sm bg-transparent outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}
