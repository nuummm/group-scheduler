import { RotateCcw } from "lucide-react";
import { Component, type ReactNode, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "./_components/ui";

/**
 * 画面が落ちたときの受け皿。
 *
 * 何も置かないと React は画面を丸ごと外し、真っ白なページだけが残る（戻る道も無い）。
 * **もう一度試す** と **他の機能へ移る** の 2 つだけを置く。
 * 詳しい理由は画面に出さない（ブラウザのコンソールに出している）。
 *
 * 外枠（ヘッダー）より外側に置く。外枠ごと落ちたときも、ここが出る。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[scheduler] 画面の描画に失敗", error);
  }

  private reset = () => {
    this.setState({ failed: false });
  };

  render() {
    return this.state.failed ? <AppError onReset={this.reset} /> : this.props.children;
  }
}

function AppError({ onReset }: { onReset: () => void }) {
  // 受け皿は画面を移っても残り続けるので、移った時点で描き直す。
  // 同じ URL への移動でも key は変わるので、pathname ではなく key を見る。
  const { key } = useLocation();
  const failedAt = useRef(key);
  useEffect(() => {
    if (key !== failedAt.current) onReset();
  }, [key, onReset]);

  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <h1 className="font-semibold text-ink text-lg">画面を表示できませんでした</h1>
      <p className="copy-block text-ink-muted text-sm leading-relaxed">
        {
          "一時的な不調かもしれません。もう一度試しても直らないときは、ページを読み込み直してください。"
        }
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={onReset}>
          <RotateCcw className="size-3.5" aria-hidden />
          もう一度試す
        </Button>
        <Link
          to="/"
          className="inline-flex items-center rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-ink-muted text-xs hover:text-ink"
        >
          日程調整へ
        </Link>
        <Link
          to="/attendance"
          className="inline-flex items-center rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-ink-muted text-xs hover:text-ink"
        >
          在室状況へ
        </Link>
      </div>
    </div>
  );
}
