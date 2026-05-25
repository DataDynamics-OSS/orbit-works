"use client";

/**
 * 회의록 — drawio 다이어그램 탭.
 *
 * 자체 호스팅 drawio (`/drawio/`) 를 iframe 으로 임베드하고 postMessage 로
 * load/save 한다. 마인드맵과 동일 권한·즉시 저장 패턴.
 *
 * 흐름:
 *   1) iframe 이 init 메시지 발신 → 호스트가 현재 XML 을 load 액션으로 주입.
 *   2) 사용자 편집 → drawio 가 autosave (또는 [Save] 클릭) 시 save 메시지.
 *   3) 호스트가 onSave(xml) 호출 → 서버 PATCH.
 *   4) 탭 전환·페이지 이탈 시 외부에서 saveRef.current() 로 즉시 flush.
 *
 * 보안:
 *   - 자체 호스팅이라 iframe origin = window.location.origin → postMessage
 *     origin 검증으로 외부 fake 메시지 차단.
 *   - sandbox: scripts + same-origin + popups + downloads (drawio 가 동작
 *     하려면 4종 모두 필요).
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  initialXml: string | null;
  onSave: (xml: string | null) => Promise<void>;
  /** 외부에서 즉시 flush 하기 위한 ref. 마인드맵·본문 패턴 mirror. */
  saveRef: React.MutableRefObject<(() => Promise<void>) | null>;
  readOnly?: boolean;
};

export function MeetingNoteDrawio({
  initialXml,
  onSave,
  saveRef,
  readOnly = false,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 가장 최근 저장한 XML — diff 비교용 (불필요 PATCH 방지).
  const lastSavedRef = useRef<string | null>(initialXml);
  // 가장 최근 받은 dirty XML — flush 시점에 사용.
  const dirtyXmlRef = useRef<string | null>(null);
  // debounce 타이머.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  // 즉시 flush — debounce 무관 동기 호출.
  const flush = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyXmlRef.current === null) return;
    if (dirtyXmlRef.current === lastSavedRef.current) return;
    const xml = dirtyXmlRef.current;
    setStatus("saving");
    try {
      await onSave(xml || null);
      lastSavedRef.current = xml;
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [onSave]);

  // saveRef 노출.
  useEffect(() => {
    saveRef.current = flush;
    return () => {
      if (saveRef.current === flush) saveRef.current = null;
    };
  }, [flush, saveRef]);

  // 5초 debounce 예약.
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flush();
    }, 5_000);
  }, [flush]);

  // postMessage handler.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // 자체 호스팅이라 origin 은 같은 도메인.
      if (e.origin !== window.location.origin) return;
      let msg: Record<string, unknown>;
      try {
        msg = typeof e.data === "string" ? JSON.parse(e.data) : (e.data as any);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const event = msg.event as string | undefined;
      if (event === "init") {
        // iframe 준비 완료 — 현재 XML 주입. 빈값이면 빈 다이어그램.
        const xml = lastSavedRef.current ?? "";
        iframeRef.current?.contentWindow?.postMessage(
          JSON.stringify({ action: "load", xml, autosave: 1 }),
          window.location.origin,
        );
      } else if (event === "save" || event === "autosave") {
        const xml = (msg.xml as string | undefined) ?? "";
        dirtyXmlRef.current = xml;
        scheduleSave();
      } else if (event === "exit") {
        // saveAndExit=0 라 보통 안 옴. 들어오면 flush 만.
        void flush();
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      window.removeEventListener("message", onMsg);
    };
  }, [scheduleSave, flush]);

  // 페이지 이탈 시 마지막 한 번 더 flush.
  useEffect(() => {
    const onUnload = () => {
      // sync 호출 — 결과 무관 (브라우저가 닫는 시점).
      if (
        dirtyXmlRef.current !== null &&
        dirtyXmlRef.current !== lastSavedRef.current
      ) {
        try {
          // navigator.sendBeacon 이 더 안정적이지만 인증 헤더 안 붙어서 skip.
          // 대신 onSave 의 promise 를 동기 호출만 — 일부 브라우저는 무시.
          void onSave(dirtyXmlRef.current);
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [onSave]);

  // drawio iframe URL — 자체 호스팅, embed 모드.
  // saveAndExit=0 — Save 클릭 시 호스트로 메시지만, 닫지 않음.
  // libraries=1   — 사내 도형 라이브러리 등록 가능 (현재는 빈 set).
  // proto=json    — postMessage 프로토콜.
  // ui=atlas      — 모던 UI.
  // splash=0      — 시작 splash 화면 끔 (사내 도구).
  // noExitBtn=1   — embed 모드라 Exit 버튼 의미 없음.
  // prefetchFonts=1 — 폰트 미리 로드 (UX).
  const src = `/drawio/?embed=1&proto=json&libraries=1&saveAndExit=0&spin=1&ui=atlas&splash=0&noExitBtn=1&prefetchFonts=1${
    readOnly ? "&toolbar=0&editable=0&chrome=0" : ""
  }`;

  return (
    <div className="flex flex-col w-full h-full">
      {/* 상태 인디케이터 — 본문/마인드맵과 동일 패턴 (오른쪽 하단 chip). */}
      <div className="px-3 py-1 border-b border-border flex items-center justify-between text-[11px] text-muted-foreground bg-muted/20">
        <span>다이어그램 (drawio) — 5초 자동 저장</span>
        <span
          className={
            status === "saving"
              ? "text-amber-600"
              : status === "saved"
                ? "text-emerald-600"
                : status === "error"
                  ? "text-rose-600"
                  : ""
          }
        >
          {status === "saving" ? "저장 중…"
            : status === "saved" ? "저장됨"
              : status === "error" ? "저장 실패"
                : ""}
        </span>
      </div>
      <iframe
        ref={iframeRef}
        src={src}
        className="flex-1 w-full bg-white"
        style={{ border: 0 }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms"
        title="drawio diagram editor"
      />
    </div>
  );
}
