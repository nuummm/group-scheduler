import { AlertTriangle, Check, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { type IslandNotice, useIslandStore } from "../_stores/island-store";

/**
 * アプリ島の描画。位置は画面上端の中央で固定、アプリ全体で 1 枚だけ。
 *
 * 通知そのものはクリックを素通しし、中の操作ボタンだけが押せる。取り消しの猶予がある通知は
 * 残り秒数を出す — 「いつまで押せるか」が見えないと、押していいのか迷って結局押せない。
 */

const TONE_STYLE: Record<IslandNotice["tone"], string> = {
  neutral: "text-ink",
  success: "text-present",
  danger: "text-danger",
};

const TONE_ICON = {
  neutral: Info,
  success: Check,
  danger: AlertTriangle,
} as const;

function RemainingSeconds({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
  );
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return <span className="tabular-nums">{remaining}</span>;
}

export function AppIsland() {
  const notice = useIslandStore((state) => state.notice);
  const closing = useIslandStore((state) => state.closing);
  const dismiss = useIslandStore((state) => state.dismiss);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3">
      {/* 読み上げ用の live region は常設し、中身の入れ替えで announce させる。 */}
      <span role="status" aria-live="polite" className="sr-only">
        {notice && !closing ? (
          <span key={notice.id}>{[notice.title, notice.detail].filter(Boolean).join("。")}</span>
        ) : (
          ""
        )}
      </span>
      {notice && (
        <div
          key={notice.id}
          className={cn(
            "pointer-events-auto flex max-w-[min(94vw,44rem)] items-center gap-2.5 rounded-full",
            "border border-line bg-surface-raised px-4 py-2 text-sm shadow-float",
            "transition-all duration-300 ease-[var(--ease-spring)]",
            closing ? "-translate-y-2 scale-95 opacity-0" : "translate-y-0 scale-100 opacity-100",
          )}
        >
          {(() => {
            const Icon = TONE_ICON[notice.tone];
            return <Icon className={cn("size-4 shrink-0", TONE_STYLE[notice.tone])} aria-hidden />;
          })()}
          {/* 主文は省略しない。何が起きたのかが読めないと、取り消してよいか判断できない。 */}
          <span className="whitespace-nowrap font-medium text-ink">{notice.title}</span>
          {notice.detail && (
            <span className="hidden truncate text-ink-muted md:inline">{notice.detail}</span>
          )}
          {notice.action && (
            <button
              type="button"
              onClick={() => {
                notice.action?.run();
                dismiss(notice.id);
              }}
              className={cn(
                "ml-1 shrink-0 rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent-ink",
                "transition hover:bg-accent hover:text-white",
              )}
            >
              {notice.action.label}
              {notice.expiresAt && (
                <>
                  {" "}
                  <RemainingSeconds expiresAt={notice.expiresAt} />
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
