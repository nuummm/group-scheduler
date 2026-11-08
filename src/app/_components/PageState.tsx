import { RotateCcw } from "lucide-react";
import { Button } from "./ui";

/**
 * 画面がデータを読み込んでいる間と、読めなかったときの表示。
 * どの画面も最初の 1 回だけ API を待つので、同じ見た目に揃える。
 */
export function PageLoading() {
  return (
    <p className="py-16 text-center text-ink-subtle text-sm" role="status">
      読み込み中…
    </p>
  );
}

export function PageLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <p className="text-ink-muted text-sm" role="alert">
        {message}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        <RotateCcw className="size-3.5" aria-hidden />
        もう一度読み込む
      </Button>
    </div>
  );
}
