"use client";

/**
 * 저장 성공 직후 "저장됨 HH:mm" 표시 — 인라인 저장 버튼 옆에 두는 안내 라벨.
 *
 * 사용 패턴:
 *   const [savedAt, setSavedAt] = useState<Date | null>(null);
 *   const m = useMutation({ onSuccess: () => setSavedAt(new Date()) ... });
 *   <SavedAtLabel at={savedAt} />
 *
 * `at` 이 null 이면 아무것도 렌더하지 않는다.
 *
 * 옵션 `autoHideMs` 를 주면 마지막 `at` 변경 후 해당 시간(ms) 뒤 라벨을 숨김.
 * 다이얼로그처럼 "닫기" 버튼 같은 별도 단서가 있는 곳에서 사용 (인라인 폼은 영구 표시가 의도).
 */

import { useEffect, useState, type ReactElement } from "react";

export function SavedAtLabel({
  at,
  prefix = "저장됨",
  autoHideMs,
}: {
  at: Date | null;
  prefix?: string;
  autoHideMs?: number;
}): ReactElement | null {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!at || !autoHideMs) {
      setHidden(false);
      return;
    }
    setHidden(false);
    const t = setTimeout(() => setHidden(true), autoHideMs);
    return () => clearTimeout(t);
  }, [at, autoHideMs]);

  if (!at || hidden) return null;
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {prefix} {hh}:{mm}
    </span>
  );
}
