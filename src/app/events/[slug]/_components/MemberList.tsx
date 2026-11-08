import { Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { hasResponded, MEMBER_SORTS, type MemberSort, sortParticipants } from "@/lib/participants";
import type { ParticipantListItem } from "@/lib/types";
import { Button, EmptyState } from "../../../_components/ui";
import { terms } from "../../../_lib/app-config";

function sortLabel(sort: MemberSort): string {
  return sort === "grade" ? `${terms().role}順` : "名前順";
}

/**
 * 登録メンバーの一覧。カードを押すとその人の予定表を開く。
 *
 * 1 人あたり 2 行に抑える（操作が名前より目立たないように）。表示切り替えは目のアイコンに寄せ、
 * 削除と並べて右上にまとめる（どちらもカードのクリックとは当たり判定を分ける）。
 */
export function MemberList({
  participants,
  sort,
  onChangeSort,
  onOpen,
  onToggleVisibility,
  onDelete,
}: {
  participants: ParticipantListItem[];
  sort: MemberSort;
  onChangeSort: (sort: MemberSort) => void;
  onOpen: (participant: ParticipantListItem) => void;
  onToggleVisibility: (participant: ParticipantListItem, hidden: boolean) => void;
  onDelete: (participant: ParticipantListItem) => void;
}) {
  if (participants.length === 0) {
    return <EmptyState>まだメンバーが登録されていません。</EmptyState>;
  }

  return (
    <div className="space-y-2">
      {/* 並び替えは一覧のすぐ上。誰が入力していないかを探すのがいちばんの用なので、
          その並びにいつでも切り替えられるようにしておく。 */}
      <div className="flex items-center gap-1 rounded-full border border-line bg-surface-muted p-0.5 text-xs">
        {MEMBER_SORTS.map((option) => (
          <label
            key={option}
            className={cn(
              "flex-1 cursor-pointer rounded-full px-2 py-1 text-center transition-colors",
              sort === option ? "bg-surface text-ink" : "text-ink-muted",
            )}
          >
            <input
              type="radio"
              name="memberSort"
              className="sr-only"
              checked={sort === option}
              onChange={() => onChangeSort(option)}
            />
            {sortLabel(option)}
          </label>
        ))}
      </div>

      {/* 人数が増えるとサイドバーだけが際限なく伸びて、左の表と丈が合わなくなる。
          一定の高さで頭打ちにして、その中でスクロールさせる。 */}
      <ul className="max-h-[32rem] space-y-1.5 overflow-y-auto pr-0.5">
        {sortParticipants(participants, sort).map((participant) => (
          <li
            key={participant.id}
            className={cn(
              // カードのどこを押しても開けるようにする。当たり判定が名前の行だけだと、
              // 属性チップの余白を押しても何も起きず「反応しないカード」に見える。
              "group relative rounded-[var(--radius-control)] border border-line bg-surface-muted/40",
              "transition-colors hover:border-accent/50 hover:bg-accent-soft/40",
              // 非表示の人は薄くするが、読めなくはしない（誰を隠しているかは分かるべき）。
              participant.hiddenInMatrix && "border-dashed opacity-70",
            )}
          >
            <button
              type="button"
              onClick={() => onOpen(participant)}
              aria-label={`${participant.name} の予定表を開く`}
              className="absolute inset-0 cursor-pointer rounded-[var(--radius-control)]"
            />

            {/* 表示は当たり判定を持たせず、上に重ねるだけ。個別の操作ボタンだけが受け取る。 */}
            <div className="pointer-events-none relative px-3 py-2.5">
              <div className="flex items-center gap-1">
                <span className="truncate font-medium text-ink text-sm group-hover:text-accent-ink">
                  {participant.name}
                </span>
                {/* コマ数は名前のすぐ右。属性チップの列に混ぜると、数字が埋もれて読めない。 */}
                {hasResponded(participant) ? (
                  <span className="shrink-0 text-ink-subtle text-xs tabular-nums">
                    {participant.busyCount} コマ
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-busy-soft px-1.5 py-0.5 text-[10px] text-busy">
                    未入力
                  </span>
                )}
                {participant.hasPassword && (
                  <KeyRound
                    className="size-3 shrink-0 text-ink-subtle"
                    aria-label="パスワードあり"
                  />
                )}

                <span className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={participant.hiddenInMatrix}
                    title={participant.hiddenInMatrix ? "全体表に表示する" : "全体表で非表示にする"}
                    aria-label={`${participant.name} を全体表で${participant.hiddenInMatrix ? "表示" : "非表示"}にする`}
                    onClick={() => onToggleVisibility(participant, !participant.hiddenInMatrix)}
                    className={cn("h-7 px-1.5", participant.hiddenInMatrix && "text-accent")}
                  >
                    {participant.hiddenInMatrix ? (
                      <EyeOff className="size-3.5" aria-hidden />
                    ) : (
                      <Eye className="size-3.5" aria-hidden />
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${participant.name} を削除`}
                    onClick={() => onDelete(participant)}
                    className="h-7 px-1.5 hover:text-danger"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {participant.gradeName && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-[11px] text-accent-ink">
                    {participant.gradeName}
                  </span>
                )}
                {participant.groups.map((group) => (
                  <span
                    key={group.id}
                    className="rounded-full px-2 py-0.5 text-[11px]"
                    style={{ backgroundColor: `${group.color}1f`, color: group.color }}
                  >
                    {group.name}
                  </span>
                ))}
                {participant.hiddenInMatrix && (
                  <span className="text-ink-subtle">全体表では非表示</span>
                )}
              </div>

              {participant.note && (
                <p className="mt-1.5 rounded-[6px] bg-surface px-2 py-1.5 text-ink-muted text-xs leading-relaxed">
                  {participant.note}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
