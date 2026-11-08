import { Link } from "react-router";
import { ForgetLastEvent } from "./_components/ForgetLastEvent";
import { useDocumentTitle } from "./_lib/use-document-title";

/**
 * 見つからなかったときの画面。
 *
 * ここへはどの機能からも来る（消えたイベント、打ち間違い）。
 * 文面を日程調整に寄せると、在室状況を探していた人に「イベント一覧へ」だけが
 * 示されることになるので、両方の入口を並べる。
 */
export default function NotFound() {
  // 打ち間違いの URL では、直前の画面の題名がタブに残ってしまう。
  useDocumentTitle(null);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      {/* ここに着いた時点で、覚えている「続き」は無効。忘れないと何度でもここへ戻る。 */}
      <ForgetLastEvent />
      <h1 className="font-semibold text-ink text-lg">ページが見つかりません</h1>
      <p className="mt-2 text-ink-muted text-sm">URL が変わったか、消された可能性があります。</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          to="/"
          className="inline-block rounded-[var(--radius-control)] bg-accent px-4 py-2 font-medium text-sm text-white"
        >
          日程調整へ
        </Link>
        <Link
          to="/attendance"
          className="inline-block rounded-[var(--radius-control)] border border-line px-4 py-2 text-ink-muted text-sm hover:text-ink"
        >
          在室状況へ
        </Link>
      </div>
    </div>
  );
}
