import type { LucideIcon } from "lucide-react";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";
import { Button, inputClass } from "../../../_components/ui";
import { isSubmitEnter } from "../../../_lib/ime";

/**
 * 属性を選ぶチップの並び。区分とグループで同じ見た目・同じ操作にするための共通部品。
 *
 * 違いは選び方だけ:
 * - 区分は 1 人 1 つなので `single`（選び直すと前の選択が外れ、同じものを押すと未選択に戻る）
 * - グループは掛け持ちがあるので `multi`
 *
 * 数値の表示（所属人数）や削除ボタンは、使う場所によって出したり出さなかったりする。
 */

export interface ChipItem {
  id: number;
  name: string;
  /** グループは色を持つ。区分は色を持たず、選択時はアクセント色になる。 */
  color?: string;
  memberCount?: number;
  /** 名前の右に添える短い補足（グループなら 1 回の長さ）。 */
  badge?: string;
  /** 消したり名前を変えたりできない枠（主宰者など）。 */
  locked?: boolean;
}

/**
 * チップの右にくっつく操作。削除以外の用途（開催日時の仮決めなど）をここから足す。
 * チップ本体の選択とは別の意味を持つので、押しても選択状態は変わらない。
 */
export interface ChipAction {
  icon: LucideIcon;
  /** 押したときの説明。何のボタンか分からないアイコンになるので必ず入れる。 */
  title: (item: ChipItem) => string;
  /** 効いている状態か（開催日時が決まっているグループなど）。 */
  isActive?: (item: ChipItem) => boolean;
  disabled?: boolean;
  onClick: (item: ChipItem) => void;
}

export function CategoryChips({
  items,
  selectedIds,
  mode,
  onToggle,
  onDelete,
  onRename,
  onAdd,
  action,
  addPlaceholder,
  addExtra,
  emptyText,
  showCount = false,
}: {
  items: ChipItem[];
  selectedIds: number[];
  mode: "single" | "multi";
  onToggle: (id: number, selected: boolean) => void;
  onDelete?: (item: ChipItem) => void;
  /** 名前の変更。渡すとチップをダブルクリックでその場で直せるようになる。 */
  onRename?: (item: ChipItem, name: string) => void;
  onAdd?: (name: string) => void;
  action?: ChipAction;
  addPlaceholder?: string;
  /** 追加欄に何か入力しているあいだだけ出す設定（新しいグループのコマ数など）。 */
  addExtra?: ReactNode;
  emptyText?: string;
  /** 所属人数を出すか。絞り込みでは効き目の目安になるが、自分の入力欄では雑音。 */
  showCount?: boolean;
}) {
  const [draft, setDraft] = useState("");
  // 名前を直しているチップ。null なら誰も編集していない。
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);

  const commitRename = () => {
    if (!renaming || !onRename) return;
    const item = items.find((candidate) => candidate.id === renaming.id);
    const value = renaming.value.trim();
    if (item && value && value !== item.name) {
      onRename(item, value);
    }
    setRenaming(null);
  };

  const commitAdd = () => {
    const value = draft.trim();
    if (!value || !onAdd) return;
    onAdd(value);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      {items.length === 0 && emptyText ? (
        <p className="text-ink-subtle text-xs">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {items.map((item) => {
            const selected = selectedIds.includes(item.id);
            const tint = item.color
              ? { backgroundColor: `${item.color}24`, color: item.color }
              : undefined;
            if (renaming?.id === item.id) {
              return (
                <input
                  key={item.id}
                  // biome-ignore lint/a11y/noAutofocus: 直すために開いた入力欄なので即座に打てるべき
                  autoFocus
                  aria-label={`${item.name} の名前を変更`}
                  className="h-[26px] w-40 rounded-full border border-accent bg-surface px-3 text-xs outline-none"
                  value={renaming.value}
                  onChange={(event) =>
                    setRenaming((current) =>
                      current ? { ...current, value: event.target.value } : current,
                    )
                  }
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setRenaming(null);
                      return;
                    }
                    // 変換確定の Enter は無視する（1 回目で確定してしまわないように）。
                    if (!isSubmitEnter(event)) return;
                    event.preventDefault();
                    commitRename();
                  }}
                />
              );
            }
            return (
              // items-stretch にしないと、文字のチップとアイコンのボタンで高さが揃わず段差になる。
              <span key={item.id} className="inline-flex items-stretch">
                <label
                  title={
                    onRename && !item.locked
                      ? "ダブルクリック、または選んでから F2 で名前を変更できます"
                      : undefined
                  }
                  // 2 打目の既定動作を止める。label なので、そのままだと名前を直すたびに
                  // 中のチェックボックスが 2 回反転して余計な再描画が走る。
                  onMouseDown={
                    onRename && !item.locked
                      ? (mouseEvent) => {
                          if (mouseEvent.detail === 2) mouseEvent.preventDefault();
                        }
                      : undefined
                  }
                  onDoubleClick={
                    onRename && !item.locked
                      ? () => setRenaming({ id: item.id, value: item.name })
                      : undefined
                  }
                  className={cn(
                    "flex cursor-pointer items-center border py-1 pl-3 text-xs transition-colors",
                    (onDelete && !item.locked) || action
                      ? "rounded-l-full pr-2"
                      : "rounded-full pr-3",
                    selected
                      ? "border-transparent font-medium"
                      : "border-line text-ink-muted hover:border-ink-subtle",
                    selected && !item.color && "bg-accent text-white",
                  )}
                  style={selected && item.color ? tint : undefined}
                >
                  <input
                    // single は同じものを押して外せるようにしたいので、radio ではなく
                    // checkbox にして外し方を自前で持つ。
                    type="checkbox"
                    className="sr-only"
                    checked={selected}
                    onChange={() => onToggle(item.id, !selected)}
                    // 名前の変更にキーボードからの道を用意する。ダブルクリックだけだと
                    // マウスを使わない人には到達できない（席名の変更は鉛筆ボタンで到達できる）。
                    onKeyDown={
                      onRename && !item.locked
                        ? (event) => {
                            if (event.key !== "F2") return;
                            event.preventDefault();
                            setRenaming({ id: item.id, value: item.name });
                          }
                        : undefined
                    }
                  />
                  {item.name}
                  {item.badge && (
                    <span
                      className={cn(
                        "ml-1.5 rounded-full px-1.5 py-px text-[10px] tabular-nums",
                        selected ? "bg-white/25" : "bg-surface-muted text-ink-subtle",
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                  {showCount && item.memberCount !== undefined && (
                    <span
                      className={cn(
                        "ml-1 tabular-nums",
                        selected ? "opacity-70" : "text-ink-subtle",
                      )}
                    >
                      {item.memberCount}
                    </span>
                  )}
                </label>
                {action && (
                  <button
                    type="button"
                    title={action.title(item)}
                    aria-label={action.title(item)}
                    aria-pressed={action.isActive?.(item) ?? false}
                    disabled={action.disabled}
                    onClick={() => action.onClick(item)}
                    className={cn(
                      "flex items-center border border-l-0 pr-2 pl-1.5",
                      onDelete && !item.locked ? "" : "rounded-r-full pr-2.5",
                      action.disabled
                        ? "cursor-not-allowed border-line text-ink-subtle/50"
                        : "cursor-pointer border-line text-ink-subtle hover:text-accent",
                      action.isActive?.(item) && "border-transparent bg-accent text-white",
                    )}
                  >
                    <action.icon className="size-3" aria-hidden />
                  </button>
                )}
                {onDelete && !item.locked && (
                  <button
                    type="button"
                    aria-label={`${item.name} を削除`}
                    onClick={() => onDelete(item)}
                    className={cn(
                      "flex items-center rounded-r-full border border-l-0 pr-2.5 pl-1 text-xs hover:text-danger",
                      selected ? "border-transparent" : "border-line text-ink-subtle",
                      selected && !item.color && "bg-accent text-white/80",
                    )}
                    style={
                      selected && item.color ? { backgroundColor: `${item.color}24` } : undefined
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {onAdd && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input
              className={inputClass}
              placeholder={addPlaceholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // 変換確定の Enter は無視する（1 回目で登録されてしまわないように）。
                if (!isSubmitEnter(event)) return;
                event.preventDefault();
                commitAdd();
              }}
            />
            <Button onClick={commitAdd} aria-label={addPlaceholder ?? "追加"}>
              <Plus className="size-4" aria-hidden />
            </Button>
          </div>
          {/* 追加の設定は名前を打ち始めてから出す。何も足そうとしていないときに
              並べておくと、既存のグループの設定と紛らわしい。 */}
          {addExtra && draft.trim().length > 0 && addExtra}
        </div>
      )}

      {mode === "single" && <span className="sr-only">1 つだけ選べます</span>}
    </div>
  );
}

/** `single` の選択結果を作る。同じものを押したら未選択に戻す。 */
export function nextSingleSelection(
  current: number | null,
  id: number,
  selected: boolean,
): number | null {
  if (!selected) {
    return current === id ? null : current;
  }
  return id;
}
