"use client";

/**
 * 도움말 편집 — DB upsert. 저장 시 backend 가 revision snapshot 자동.
 * TipTap 본문 + 메타(제목/그룹/순서/요약) + 변경 사유 메모.
 * 이미지는 TipTap 의 paste/drop 핸들러로 base64 data URL 인라인.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, History, Save, Trash2 } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { TipTapEditor } from "@/components/board/TipTapEditor";
import { HELP_SECTIONS } from "@/lib/help-content";
import { MENU_GROUP_ORDER, MENU_REGISTRY } from "@/components/layout/menu-registry";

type ArticleOut = {
  id: string;
  menu_key: string;
  title: string;
  group: string | null;
  sort_order: number;
  summary: string | null;
  body_html: string;
  body_text: string | null;
  updated_at: string | null;
};

export default function HelpEditPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const key = (params?.key as string | undefined) ?? "";

  // 코드 default — 새 항목 작성 시 prefill.
  const codeSection = HELP_SECTIONS.find((s) => s.key === key) ?? null;
  // menu-registry 에서도 추측 — group/title.
  const menuEntry = MENU_REGISTRY.find((m) => m.key === key) ?? null;

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canEdit =
    me?.role === "ADMIN" || me?.role === "SUPER_ADMIN" || me?.role === "HR";

  const { data: db, isLoading } = useQuery<ArticleOut | null>({
    queryKey: ["help-article", key],
    queryFn: async () => {
      try {
        return (await api.get(`/help-articles/${key}`)).data as ArticleOut;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
    enabled: !!key,
    staleTime: 60_000,
  });

  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [summary, setSummary] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [changeNote, setChangeNote] = useState("");

  // db 또는 code default 로 초기 channel.
  useEffect(() => {
    if (isLoading) return;
    if (db) {
      setTitle(db.title);
      setGroup(db.group ?? "");
      setSortOrder(db.sort_order);
      setSummary(db.summary ?? "");
      setBodyHtml(db.body_html);
    } else {
      setTitle(codeSection?.title ?? menuEntry?.label ?? key);
      setGroup(codeSection?.group ?? menuEntry?.group ?? "");
      setSortOrder(0);
      setSummary(codeSection?.summary ?? "");
      // 코드 TSX 컨텐츠를 HTML 문자열로 가져올 방법이 없어 빈 본문에서 시작.
      // 운영자가 처음 작성하는 시점.
      setBodyHtml("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, isLoading]);

  const saveM = useMutation({
    mutationFn: async () => {
      const tmp = document.createElement("div");
      tmp.innerHTML = bodyHtml || "";
      const plain = (tmp.textContent || "").trim();
      const payload = {
        title: title.trim(),
        group: group.trim() || null,
        sort_order: Number(sortOrder) || 0,
        summary: summary.trim() || null,
        body_html: bodyHtml || "",
        body_text: plain,
        change_note: changeNote.trim() || null,
      };
      return (await api.put(`/help-articles/${key}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["help-article", key] });
      qc.invalidateQueries({ queryKey: ["help-articles", "list"] });
      router.push(`/help/${key}`);
    },
    onError: (e: any) => alert(e?.response?.data?.detail ?? "저장 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/help-articles/${key}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["help-article", key] });
      qc.invalidateQueries({ queryKey: ["help-articles", "list"] });
      router.push("/help");
    },
  });

  if (!canEdit) {
    return (
      <>
        <DashboardHeader title="도움말 편집" />
        <div className="p-6 text-sm text-muted-foreground">
          편집 권한이 없습니다 (ADMIN/HR 필요).
        </div>
      </>
    );
  }

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <>
      <DashboardHeader
        title={`${title || key} (편집)`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/help/${key}/revisions`}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <History className="h-3.5 w-3.5" /> 이력
            </Link>
            <Link
              href={`/help/${key}`}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 보기
            </Link>
          </div>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-y-auto">
        <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="제목 *" colSpan={2}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={input}
              />
            </Field>
            <Field label="순서">
              <input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value))}
                className={input}
              />
            </Field>
            <Field label="그룹 (카테고리)">
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                list="help-group-options"
                placeholder={menuEntry?.group ?? ""}
                className={input}
              />
              <datalist id="help-group-options">
                {MENU_GROUP_ORDER.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
            <Field label="요약" colSpan={2}>
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                className={input}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">본문</span>
            <TipTapEditor value={bodyHtml} onChange={setBodyHtml} minHeight={500} />
            <p className="text-[11px] text-muted-foreground">
              이미지는 본문에 복사·붙여넣기(또는 끌어다 놓기) 하면 자동으로 포함됩니다 (data URL inline).
            </p>
          </div>

          <Field label="변경 사유 (이력에 기록)">
            <input
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder="예: 캐시 전략 안내 추가"
              className={input}
            />
          </Field>

          <div className="flex items-center gap-2 pt-2 border-t border-border">
            {db && (
              <button
                type="button"
                onClick={async () => {
                  if (confirm("이 도움말을 삭제할까요? (이력도 함께 삭제됩니다)"))
                    deleteM.mutate();
                }}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" /> 삭제
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Link
                href={`/help/${key}`}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm"
              >
                취소
              </Link>
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
      </div>
    </>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const cls = colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
