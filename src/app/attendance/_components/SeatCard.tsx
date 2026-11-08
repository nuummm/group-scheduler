import { Coffee, Pencil, SquareDashed, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Seat } from "@/lib/types";
import { Button } from "../../_components/ui";

/**
 * 座席 1 マス。
 *
 * カード面そのものが在室 / 不在のトグル。副操作（離席中・名前変更・レイアウト編集）は
 * カード内の小さなボタンに分け、主操作と押し間違えないよう当たり判定を分離する。
 */

const STATUS_LABEL = {
  present: "在室中",
  away: "離席",
  offsite: "不在",
} as const;

const STATUS_CLASS = {
  present: "border-present bg-present-soft",
  away: "border-away bg-away-soft",
  offsite: "border-line bg-surface",
} as const;

/**
 * カーソルを乗せたときの見え方。面のどこでも押せることを、枠と地色の変化で示す。
 * 押した先の状態（在室なら緑）とは別の「触れている」表現にして、
 * いまの状態と取り違えないようにする。
 */
const STATUS_HOVER = {
  present: "hover:border-present hover:brightness-[0.97]",
  away: "hover:border-away hover:brightness-[0.97]",
  offsite: "hover:border-accent hover:bg-accent-soft/40",
} as const;

const STATUS_DOT = {
  present: "bg-present",
  away: "bg-away",
  offsite: "bg-ink-subtle/40",
} as const;

export function SeatCard({
  seat,
  editingLayout,
  pendingUndo,
  onToggle,
  onToggleAway,
  onRename,
  onChangeKind,
  onRemove,
}: {
  seat: Seat;
  editingLayout: boolean;
  /** この席に取り消せる通知が残っているか。枠を光らせて「まだ戻せる」と示す。 */
  pendingUndo: boolean;
  onToggle: () => void;
  onToggleAway: () => void;
  onRename: () => void;
  onChangeKind: (kind: "seat" | "void") => void;
  onRemove: () => void;
}) {
  if (seat.seatKind === "void") {
    return (
      <div className="flex min-h-[5.5rem] items-center justify-center rounded-[var(--radius-control)] border border-line border-dashed bg-surface-muted/40">
        {editingLayout ? (
          <Button size="sm" variant="ghost" onClick={() => onChangeKind("seat")}>
            座席にする
          </Button>
        ) : (
          <span className="sr-only">席なし</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex min-h-[5.5rem] flex-col rounded-[var(--radius-control)] border",
        "transition-[background-color,border-color,filter]",
        STATUS_CLASS[seat.status],
        // 編集中は押せないので、押せる見た目にしない。
        !editingLayout && ["cursor-pointer", STATUS_HOVER[seat.status]],
        pendingUndo && "ring-2 ring-accent ring-offset-1 ring-offset-canvas",
      )}
    >
      {/* 切り替えの当たり判定はカード全面（アイコン行の余白を押しても切り替わるように）。
          レイアウト編集中は出さない。席の増減や席なし化をしている最中に
          カードの余白を押すと、**他人の席が在室中になって Slack にも流れる**。 */}
      {!editingLayout && (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={seat.status === "present"}
          aria-label={`${seat.label} は${STATUS_LABEL[seat.status]}。押すと切り替わります`}
          className="absolute inset-0 cursor-pointer rounded-[var(--radius-control)]"
        />
      )}

      {/* 表示だけの層。クリックは下のボタンへ素通しする。 */}
      <div className="pointer-events-none relative flex flex-1 flex-col items-start gap-1 px-3 pt-3 pb-1">
        {/* 称号はここには出さない。誰が何日来ているかを常時見える場所に置くと、
            来ていない人を指す物差しになる。テロップと押した本人へのお祝いに留める。 */}
        <span className="line-clamp-2 w-full font-medium text-ink text-sm">{seat.label}</span>
        <span className="mt-auto flex items-center gap-1.5 text-ink-muted text-xs">
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[seat.status])} aria-hidden />
          {STATUS_LABEL[seat.status]}
        </span>
      </div>

      {/* 副操作。行そのものはクリックを通し（余白を押したらカードの切り替えになる）、
          ボタンだけが手前で受ける。 */}
      <div className="pointer-events-none relative flex items-center justify-end gap-0.5 px-1.5 pb-1.5">
        {editingLayout ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChangeKind("void")}
              title="席なしのマスにする"
              aria-label={`${seat.label} を席なしのマスにする`}
              className="pointer-events-auto"
            >
              <SquareDashed className="size-3.5" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRemove}
              title="この席を削除"
              aria-label={`${seat.label} を削除`}
              className="pointer-events-auto"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={onToggleAway}
            aria-pressed={seat.status === "away"}
            title={seat.status === "away" ? "離席をやめる" : "離席中にする"}
            aria-label={
              seat.status === "away"
                ? `${seat.label} の離席をやめる`
                : `${seat.label} を離席中にする`
            }
            className={cn("pointer-events-auto", seat.status === "away" && "text-away")}
          >
            <Coffee className="size-3.5" aria-hidden />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onRename}
          title={`${seat.label} の名前を変更`}
          className="pointer-events-auto"
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
