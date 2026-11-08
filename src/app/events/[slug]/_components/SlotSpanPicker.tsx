import { MAX_SLOT_SPAN } from "@/lib/candidates";
import { cn } from "@/lib/cn";

/**
 * グループ 1 回あたりの連続コマ数を選ぶ。
 *
 * グループの属性なので、どこから変えても全員に効く。参加者の入力欄に置くのは、
 * グループを登録した流れでそのまま決められるようにするため。
 */
export function SlotSpanPicker({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (slotSpan: number) => void;
  /** 読み上げ用。どのグループのコマ数なのかを補う。 */
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="mr-0.5 text-ink-subtle text-xs">1 回の長さ</span>
      {Array.from({ length: MAX_SLOT_SPAN }, (_, index) => index + 1).map((span) => (
        <button
          key={span}
          type="button"
          aria-label={`${label} を 1 回 ${span} コマにする`}
          aria-pressed={value === span}
          onClick={() => onChange(span)}
          className={cn(
            "h-6 cursor-pointer rounded-[6px] border px-2 text-xs tabular-nums transition-colors",
            value === span
              ? "border-transparent bg-accent font-medium text-white"
              : "border-line text-ink-muted hover:border-ink-subtle",
          )}
        >
          {span} コマ
        </button>
      ))}
    </span>
  );
}
