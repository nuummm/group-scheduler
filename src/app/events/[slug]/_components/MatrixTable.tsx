import { Check } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/cn";
import { slotHeading } from "@/lib/schedule";
import type { EventDetail, EventSummary, SummaryCell } from "@/lib/types";
import { terms } from "../../../_lib/app-config";
import { type CellRange, isInRange, selectionAfterDrag, selectionAfterPress } from "./cell-range";
import { DragGhost } from "./DragGhost";
import { buildCoverMap, type DragTarget, useSeminarDrag } from "./use-seminar-drag";

/**
 * 全体の予定表。
 *
 * 探しているのは「多く集まるコマ」ではなく「**全員が出られるコマ**」。1 人でも予定が
 * 入っていればそのグループはそこで開催しないので、空き率のグラデーションで塗ると
 * 開催できる枠とできない枠が地続きに見えてしまう。
 *
 * そこで塗り分けは 2 値にする。
 * - 全員が空いている  → 緑（ここだけが開催できる枠）。ただし必要なコマ数だけ
 *   続いていない枠は薄い緑にする（続かない枠を同じ緑にすると「ここでやれる」と読める）
 * - 1 人でも予定あり  → 赤。濃さは予定が入っている人数で、薄いほど「あと少し」
 *
 * 数字も色に合わせて「予定が入っている人数」にする。緑のマスに数字は出さない
 * （0 と書くより、全員空きだと言い切ったほうが速く読める）。
 *
 * 縦はページごとスクロールし、横だけ表の中で送る。行見出し（コマ）は sticky にして、
 * 期間指定モードで 61 列を右へ送っても何のコマを見ているか分かるようにする。
 */

function cellKey(columnKey: string, slot: number): string {
  return `${columnKey}:${slot}`;
}

/**
 * 選択範囲の枠線。連続したコマを **1 つの囲み** に見せるための指定。
 *
 * マスごとに枠を回すと、範囲を選んでいるのに 1 コマずつ独立して見える。
 * 左右は常に、上下は範囲の端だけに引くことで、縦につながった 1 本の囲みになる。
 */
function rangeOutline(isFirst: boolean, isLast: boolean): string {
  const line = "var(--color-accent)";
  const edges = [`inset 2px 0 0 ${line}`, `inset -2px 0 0 ${line}`];
  if (isFirst) edges.push(`inset 0 2px 0 ${line}`);
  if (isLast) edges.push(`inset 0 -2px 0 ${line}`);
  return edges.join(", ");
}

/**
 * マスの背景色。
 *
 * 全員が空いているマスだけを緑にし、それ以外は一律で赤に振る。緑は 2 段階
 * （必要なコマ数だけ続いているか）だけなので、「開催できる枠」を色で拾える。
 * 赤の濃さは予定が入っている人数。薄い赤は「あと 1 人ずらせば開催できる」の合図。
 */
function cellStyle(busyCount: number, matchedCount: number, usable = true): React.CSSProperties {
  if (matchedCount === 0) {
    return {};
  }
  if (busyCount === 0) {
    // 空いてはいるが必要なコマ数だけ続かない枠は、緑のまま濃さを落とす。
    // 赤にすると「予定が入っている」と区別できず、同じ濃さだと開催できる枠に見える。
    return {
      backgroundColor: `color-mix(in oklch, var(--color-free) ${usable ? 58 : 20}%, transparent)`,
    };
  }
  const ratio = busyCount / matchedCount;
  return {
    backgroundColor: `color-mix(in oklch, var(--color-busy) ${Math.round(10 + ratio * 42)}%, transparent)`,
  };
}

export function MatrixTable({
  event,
  summary,
  showNames,
  requiredSpan,
  selection,
  action,
  placeableStarts,
  onSelect,
  onMoveGroup,
}: {
  event: EventDetail;
  summary: EventSummary;
  showNames: boolean;
  /** いま見ているグループが 1 回に必要とする連続コマ数。1 なら続き具合は問わない。 */
  requiredSpan: number;
  selection: CellRange | null;
  /** 凡例の行の右端に置く操作。表そのものに対する操作をここへ寄せる。 */
  action?: ReactNode;
  /** グループごとの動かせる先（`${列キー}:${開始コマ}`）。 */
  placeableStarts: { groupId: number; starts: string[] }[];
  onSelect: (range: CellRange | null) => void;
  onMoveGroup: (groupId: number, target: DragTarget) => void;
}) {
  const {
    state: dragState,
    dragging,
    startHold,
    consumeDrop,
    dropStateOf,
  } = useSeminarDrag("matrix", onMoveGroup);
  /** そのグループが占める範囲まで広げた落とし先。2 コマなら 2 マスぶんが落とせる。 */
  const coverOf = (group: { id: number; slotSpan: number }) =>
    buildCoverMap(
      placeableStarts.find((item) => item.groupId === group.id)?.starts ?? [],
      event.slotDefinitions.map((definition) => definition.slot),
      group.slotSpan,
    );
  /** 開催日時が決まったグループ。表のマスに直接書き込んで、空き状況と一緒に読めるようにする。 */
  const fixedByCell = useMemo(() => {
    const map = new Map<string, { id: number; name: string; color: string; slotSpan: number }[]>();
    for (const group of event.groups) {
      // 表に書き込むのは仮決め済みだけ。「覚えているだけ」の位置まで書くと、
      // まだ決まっていない予定が決定事項に見える。
      if (!group.fixed || !group.pinned) continue;
      for (let slot = group.fixed.startSlot; slot <= group.fixed.endSlot; slot += 1) {
        const key = cellKey(group.fixed.columnKey, slot);
        const list = map.get(key) ?? [];
        list.push({
          id: group.id,
          name: group.name,
          color: group.color,
          slotSpan: group.slotSpan,
        });
        map.set(key, list);
      }
    }
    return map;
  }, [event.groups]);

  // ドラッグの起点。同じ列のあいだだけ範囲を伸ばす。
  // state ではなく ref なのは、pointerdown と同じ tick で来る pointerenter から読むため
  // （state は次の描画まで古いままで、1 マス目から先に伸びない）。
  const anchorRef = useRef<{ columnKey: string; slot: number } | null>(null);
  /**
   * 直前の選択がポインタ由来か。続けて来る click がこれを消費する。
   *
   * pointerup のあとにタイマーで倒すやり方は、click とタイマーのどちらが先に走るかが
   * 環境依存で、選択が二重に反転したり消えたりする。フラグの受け渡しなら順序に依存しない。
   */
  const pointerSelectionRef = useRef(false);

  useEffect(() => {
    const stop = () => {
      anchorRef.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const extendTo = (columnKey: string, slot: number) => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const next = selectionAfterDrag(selection, anchor, { columnKey, slot });
    // 範囲が変わっていないなら通知しない。selectionAfterDrag は毎回新しい
    // オブジェクトを返すので、そのまま渡すとポインタが動くたびに画面全体が描き直る。
    if (
      next &&
      selection &&
      next.columnKey === selection.columnKey &&
      next.startSlot === selection.startSlot &&
      next.endSlot === selection.endSlot
    ) {
      return;
    }
    onSelect(next);
  };

  /**
   * 押した位置から選び直す。同じ 1 コマをもう一度押したら選択を解く。
   *
   * 起点（`anchorRef`）はここでは立てない。click / キーボードからも呼ばれるが、
   * その時点で pointerup は済んでいて起点を倒す機会が二度と来ないため、
   * 「離したのにカーソルを動かすだけで範囲が伸び続ける」状態になる。
   * 起点を立てるのは pointerdown だけ。
   */
  const startAt = (columnKey: string, slot: number) => {
    onSelect(selectionAfterPress(selection, { columnKey, slot }));
  };

  const cellMap = useMemo(() => {
    const map = new Map<string, SummaryCell>();
    for (const cell of summary.cells) {
      map.set(cellKey(cell.columnKey, cell.slot), cell);
    }
    return map;
  }, [summary.cells]);

  /**
   * 必要なコマ数だけ続けて空いているマスの集合。
   *
   * 2 コマ必要なグループでは、1 コマだけ空いている枠は開催に使えない。使えない枠まで
   * 同じ緑にすると「ここでやれる」と読めてしまうので、続き具合まで見て分ける。
   */
  const usableCells = useMemo(() => {
    const usable = new Set<string>();
    const span = Math.max(1, requiredSpan);
    const slots = event.slotDefinitions.map((definition) => definition.slot);
    const isFree = (columnKey: string, slot: number) =>
      summary.matchedCount > 0 && (cellMap.get(cellKey(columnKey, slot))?.busyCount ?? 0) === 0;

    for (const column of event.columns) {
      for (let index = 0; index + span <= slots.length; index += 1) {
        // 変数名を window にしないこと（グローバルの window を隠す）。
        const run = slots.slice(index, index + span);
        // コマ番号が飛んでいる並びは「続いている」とは見なさない（追加コマの前後など）。
        const contiguous = run.every((slot, offset) => slot === (run[0] as number) + offset);
        if (!contiguous || !run.every((slot) => isFree(column.key, slot))) {
          continue;
        }
        for (const slot of run) {
          usable.add(cellKey(column.key, slot));
        }
      }
    }
    return usable;
  }, [cellMap, event.columns, event.slotDefinitions, requiredSpan, summary.matchedCount]);

  const isWeekly = event.scheduleMode === "weekly";
  // 該当者ゼロでも表そのものは描き続ける。空状態に差し替えると高さが大きく変わり、
  // 絞り込みを 1 つ切り替えただけで画面がガクンと動いてしまう。
  const noMatches = summary.matchedCount === 0;

  return (
    <div className="relative space-y-2">
      <DragGhost state={dragState} />
      {/* 凡例は表のすぐ上に置く。カード見出しの説明文だけだと、表を見るころには
          「数字が何なのか」も「色の向き」も頭から抜けている。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1.5">
          <span
            className="flex h-5 items-center justify-center rounded-[4px] px-1.5"
            style={cellStyle(0, 1)}
            aria-hidden
          >
            <Check className="size-3.5 text-ink" />
          </span>
          <span className="text-ink-muted">= 表示中のメンバー全員が空き（開催できる）</span>
        </span>
        {requiredSpan > 1 && (
          <span className="flex items-center gap-1.5">
            <span className="h-5 w-6 rounded-[4px]" style={cellStyle(0, 1, false)} aria-hidden />
            <span className="text-ink-muted">
              = 空いているが {requiredSpan} コマ続かない（この枠では開催できない）
            </span>
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="text-ink-subtle">あと 1 人</span>
          <span className="flex overflow-hidden rounded-[4px]" aria-hidden>
            {[0.15, 0.4, 0.7, 1].map((ratio) => (
              <span
                key={ratio}
                className="size-4"
                style={cellStyle(
                  Math.max(1, Math.round(ratio * summary.matchedCount)),
                  Math.max(1, summary.matchedCount),
                )}
              />
            ))}
          </span>
          <span className="text-ink-subtle">全員に予定あり</span>
          <span className="text-ink-muted">= 赤の数字は予定が入っている人数</span>
        </span>
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>

      <div
        // 範囲の伸長は、セルごとの pointerenter ではなく座標から引く。
        // enter は環境によって取りこぼしがあり、1 マス目から先に伸びないことがある。
        onPointerMove={(pointerEvent) => {
          // 予定入力と同じ理由。離した合図が届かない経路があるので、
          // ボタンが離れていたら起点を倒す。
          if (pointerEvent.buttons === 0) {
            anchorRef.current = null;
            return;
          }
          if (!anchorRef.current) return;
          const target = document
            .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
            ?.closest<HTMLElement>("[data-cell-column]");
          if (!target?.dataset.cellColumn || !target.dataset.cellSlot) return;
          extendTo(target.dataset.cellColumn, Number(target.dataset.cellSlot));
        }}
        className={cn(
          // ドラッグで範囲を選ぶあいだ、文字が選択されて見た目が乱れないようにする。
          "matrix-scroll select-none rounded-[var(--radius-control)] border border-line",
          noMatches && "opacity-35",
        )}
        // inert なら読み上げも当たり判定もタブ順もまとめて外れる。pointer-events だけだと
        // キーボードでは中のセルに入り込めてしまう。
        inert={noMatches}
      >
        <table className="matrix-table w-full text-sm">
          <caption className="sr-only">
            コマごとの空き状況。緑は全員が空いているコマ、赤の数字は予定が入っている人数です。
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="w-20 min-w-20 px-2 py-2 text-center font-medium text-ink-muted text-xs"
              >
                {isWeekly ? "時限" : "時間"}
              </th>
              {event.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="min-w-[4.5rem] px-2 py-2 text-center font-medium text-ink text-xs"
                >
                  {column.shortLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {event.slotDefinitions.map((slotDefinition) => (
              <tr key={slotDefinition.slot}>
                <th
                  scope="row"
                  className="px-2 py-1.5 text-center font-medium text-ink-muted text-[11px] leading-tight"
                >
                  <span className="block text-ink">
                    {slotHeading(slotDefinition, event.scheduleMode)}
                  </span>
                  {isWeekly && (
                    <span className="block text-[10px] text-ink-subtle">
                      {slotDefinition.start}〜{slotDefinition.end}
                    </span>
                  )}
                </th>
                {event.columns.map((column) => {
                  const key = cellKey(column.key, slotDefinition.slot);
                  const cell = cellMap.get(key);
                  const busyCount = cell?.busyCount ?? 0;
                  const allFree = summary.matchedCount > 0 && busyCount === 0;
                  // 名前は数字と同じ「予定が入っている人」に揃える。ここで知りたいのは
                  // 「誰のせいで開催できないのか」なので、そのまま次の一手につながる。
                  const busyNames = (cell?.busyParticipants ?? []).map((item) => item.name);
                  const usable = usableCells.has(key);
                  const fixedHere = fixedByCell.get(key) ?? [];
                  const active = isInRange(selection, column.key, slotDefinition.slot);
                  const isRangeStart = active && selection?.startSlot === slotDefinition.slot;
                  const isRangeEnd = active && selection?.endSlot === slotDefinition.slot;
                  const drop = dropStateOf(key);
                  return (
                    <td
                      key={key}
                      className="p-0"
                      data-drop-scope="matrix"
                      data-drop-column={column.key}
                      data-drop-slot={slotDefinition.slot}
                    >
                      <button
                        type="button"
                        aria-pressed={active}
                        style={{
                          ...cellStyle(busyCount, summary.matchedCount, usable),
                          ...(active ? { boxShadow: rangeOutline(isRangeStart, isRangeEnd) } : {}),
                        }}
                        onPointerDown={(pointerEvent) => {
                          // タッチはドラッグに使わない（表のスクロールを潰さないため）。
                          // 直前のマウス操作で立った印はここで倒す。残すと、続くタップが
                          // 「ポインタで処理済み」と見なされて 1 回無視される。
                          if (pointerEvent.pointerType === "touch") {
                            pointerSelectionRef.current = false;
                            return;
                          }
                          if (pointerEvent.button !== 0) return;
                          // 仮決めの帯を掴む操作が始まっているときは範囲選択にしない。
                          if (fixedHere.length > 0) return;
                          pointerEvent.preventDefault();
                          pointerSelectionRef.current = true;
                          anchorRef.current = { columnKey: column.key, slot: slotDefinition.slot };
                          startAt(column.key, slotDefinition.slot);
                        }}
                        data-cell-column={column.key}
                        data-cell-slot={slotDefinition.slot}
                        onClick={(clickEvent) => {
                          // ポインタ操作は pointerdown で済んでいる。
                          // ここで扱うのはキーボード（detail === 0）とタッチのタップだけ。
                          const handledByPointer = pointerSelectionRef.current;
                          pointerSelectionRef.current = false;
                          if (consumeDrop()) return;
                          if (clickEvent.detail === 0 || !handledByPointer) {
                            startAt(column.key, slotDefinition.slot);
                          }
                        }}
                        aria-label={[
                          `${column.label} ${slotHeading(slotDefinition, event.scheduleMode)}: `,
                          fixedHere.length > 0
                            ? `${fixedHere.map((item) => item.name).join("、")} を仮決め済み。`
                            : "",
                          allFree ? "全員が空き" : `${busyCount} 人に予定あり`,
                        ].join("")}
                        className={cn(
                          "flex h-full min-h-[2.6rem] w-full cursor-pointer flex-col items-center justify-center gap-0.5",
                          "transition-shadow",
                          // 仮決め済みのマスはグループ名でマスを埋める。余白を残すと
                          // 「そのコマが押さえられている」ことが面として読めない。
                          fixedHere.length > 0 ? "p-0" : "px-1 py-1.5",
                          // 枠は選択中だけ style 側で引く。hover は未選択のマスにだけ出す。
                          !active && !dragging && "hover:inset-ring-2 hover:inset-ring-accent/50",
                          // グループを掴んでいるあいだは、置ける場所だけを光らせる。
                          // 落とす先はコマ数ぶんまとめて濃くする。
                          drop === "placeable" && "inset-ring-1 inset-ring-accent/40",
                          drop === "target" && "inset-ring-2 inset-ring-accent",
                        )}
                      >
                        {/* 開催が決まったマスは空き人数を出さない。もう探す対象ではないので、
                            そこで何があるかだけを読めればよい。2 コマ以上でも全部のマスに名前を出す
                            （途中のマスが空欄だと、上に何が入っているのかを目で追う必要が出る）。 */}
                        {fixedHere.length === 0 && allFree && !usable ? (
                          // 空いてはいるが必要なコマ数だけ続かない枠。チェックを出すと
                          // 「開催できる」と読めてしまうので、印そのものを変える。
                          <span className="text-[10px] text-ink-subtle leading-tight">
                            {requiredSpan} コマ続かず
                          </span>
                        ) : fixedHere.length > 0 ? (
                          <span className="flex h-full min-h-[2.6rem] w-full flex-col">
                            {fixedHere.map((item) => {
                              // 動かせる先が無いグループは掴めない。掴めないものに
                              // 「長押しで動かせます」と書くと、押しても何も起きない案内になる。
                              const cover = coverOf(item);
                              const movable = cover.size > 0;
                              return (
                                <span
                                  key={item.id}
                                  title={
                                    movable
                                      ? `${item.name}（長押しで掴むと別のコマへ動かせます）`
                                      : `${item.name}（ほかに全員が空いている枠が無いので、動かせません）`
                                  }
                                  onPointerDown={(pointerEvent) =>
                                    startHold(pointerEvent, {
                                      groupId: item.id,
                                      label: item.name,
                                      color: item.color,
                                      cover,
                                    })
                                  }
                                  className={cn(
                                    "flex flex-1 items-center justify-center px-1 text-center font-medium text-[10px] text-white leading-[1.2]",
                                    dragState.source?.groupId === item.id
                                      ? "cursor-grabbing"
                                      : movable
                                        ? "cursor-grab"
                                        : "cursor-default",
                                  )}
                                  style={{
                                    backgroundColor: item.color,
                                    // 掴んでいる本体は薄くする。「持ち上げた」ことが分かる。
                                    opacity: dragState.source?.groupId === item.id ? 0.3 : 1,
                                  }}
                                >
                                  {item.name}
                                </span>
                              );
                            })}
                          </span>
                        ) : (
                          <>
                            {allFree ? (
                              <Check className="size-4 text-ink" aria-hidden />
                            ) : (
                              <span className="font-semibold text-ink text-sm tabular-nums leading-none">
                                {busyCount}
                              </span>
                            )}
                            {showNames &&
                              (allFree ? (
                                <span className="text-[10px] text-ink-muted leading-tight">
                                  全員が空き
                                </span>
                              ) : (
                                <span className="line-clamp-2 text-[10px] text-ink-muted leading-tight">
                                  {busyNames.slice(0, 3).join("・")}
                                  {busyNames.length > 3 && ` +${busyNames.length - 3}`}
                                </span>
                              ))}
                          </>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {noMatches && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-sm rounded-[var(--radius-control)] border border-line bg-surface px-4 py-3 text-center text-ink-muted text-sm shadow-[var(--shadow-card)]">
            {`表示条件に合うメンバーがいません。${terms().role}や${terms().group}の絞り込みを見直すか、予定を登録してください。`}
          </p>
        </div>
      )}
    </div>
  );
}
