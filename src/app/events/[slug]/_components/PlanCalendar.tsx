import { CircleDashed, Move, Pin, PinOff } from "lucide-react";
import type { SeminarPlacement } from "@/lib/assignment";
import { cn } from "@/lib/cn";
import {
  type ColumnDefinition,
  type ScheduleMode,
  type SlotDefinition,
  slotHeading,
} from "@/lib/schedule";
import { terms } from "../../../_lib/app-config";
import { DragGhost } from "./DragGhost";
import { buildCoverMap, type DragTarget, useSeminarDrag } from "./use-seminar-drag";

/**
 * 割り当て結果を時間割の形で見せる。
 *
 * 一覧だと「月 5〜6 限」を 5 行ぶん頭の中で並べ直すことになる。同じ盤面に置けば、
 * どのグループが週のどこに入るか、空いている時間がどこかを一目で読める。
 *
 * 操作は 3 つ。押すとその枠で仮決め、**長押しで掴むと別のコマへ動かせる**（動かしても仮決め）、
 * 仮決めした枠は右上の印から外す（押しても外れない。押し間違いで決定が消えるのを避ける）
 * （置ける場所だけが光るので、動かせない先を選んでしまうことはない）。
 */
export function PlanCalendar({
  columns,
  slotDefinitions,
  scheduleMode,
  placements,
  placeableStarts,
  onToggleFixed,
  onMove,
}: {
  columns: ColumnDefinition[];
  slotDefinitions: SlotDefinition[];
  scheduleMode: ScheduleMode;
  placements: SeminarPlacement[];
  /** グループごとの動かせる先（`${列キー}:${開始コマ}`）。 */
  placeableStarts: { groupId: number; starts: string[] }[];
  onToggleFixed: (placement: SeminarPlacement) => void;
  onMove: (groupId: number, target: DragTarget) => void;
}) {
  const { state, dragging, startHold, consumeDrop, dropStateOf } = useSeminarDrag("plan", onMove);

  const slotNumbers = slotDefinitions.map((definition) => definition.slot);
  /** そのグループが占める範囲まで広げた落とし先。2 コマなら 2 マスぶんが落とせる。 */
  const coverOf = (placement: SeminarPlacement) =>
    buildCoverMap(
      placeableStarts.find((item) => item.groupId === placement.groupId)?.starts ?? [],
      slotNumbers,
      placement.slotSpan,
    );

  const byCell = new Map<string, SeminarPlacement[]>();
  for (const placement of placements) {
    for (let slot = placement.startSlot; slot <= placement.endSlot; slot += 1) {
      const key = `${placement.columnKey}:${slot}`;
      byCell.set(key, [...(byCell.get(key) ?? []), placement]);
    }
  }

  const isWeekly = scheduleMode === "weekly";

  return (
    <div className="matrix-scroll rounded-[var(--radius-control)] border border-line">
      <DragGhost state={state} />
      <table className={cn("matrix-table w-full text-sm", dragging && "select-none")}>
        <caption className="sr-only">
          {terms().group}の日程の時間割。色の付いたマスがその{terms().group}
          の開催枠です。塗りつぶしは仮決めした枠、
          実線は仮決めを外して場所だけ残っている枠、破線は自動で決まった枠です。
          マウスなら長押しで掴んで別のコマへ動かせます。
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="w-20 min-w-20 px-2 py-2 text-center font-medium text-ink-muted text-xs"
            >
              {isWeekly ? "時限" : "時間"}
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="min-w-[5rem] px-2 py-2 text-center font-medium text-ink text-xs"
              >
                {column.shortLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slotDefinitions.map((definition) => (
            <tr key={definition.slot}>
              <th
                scope="row"
                className="px-2 py-1.5 text-center font-medium text-ink-muted text-[11px] leading-tight"
              >
                <span className="block text-ink">{slotHeading(definition, scheduleMode)}</span>
                {isWeekly && (
                  <span className="block text-[10px] text-ink-subtle">
                    {definition.start}〜{definition.end}
                  </span>
                )}
              </th>
              {columns.map((column) => {
                const key = `${column.key}:${definition.slot}`;
                const here = byCell.get(key) ?? [];
                const drop = dropStateOf(key);
                return (
                  <td
                    key={column.key}
                    className="p-0"
                    data-drop-scope="plan"
                    data-drop-column={column.key}
                    data-drop-slot={definition.slot}
                  >
                    <div
                      className={cn(
                        "flex h-full min-h-[2.4rem] w-full flex-col",
                        // 置ける場所を光らせる。落とす先はコマ数ぶんまとめて濃くする。
                        drop === "placeable" &&
                          "bg-accent-soft/60 inset-ring-1 inset-ring-accent/40",
                        drop === "target" && "bg-accent-soft inset-ring-2 inset-ring-accent",
                      )}
                    >
                      {here.map((placement) => {
                        // 動かせる先が無いグループは掴めない（掴んでも落とせる場所が無い）。
                        // 掴めないものに「長押しで動かせます」と書くと、押しても
                        // 何も起きない操作を案内することになる。
                        const movable = coverOf(placement).size > 0;
                        return (
                          // 仮決めの解除ボタンを重ねるので、枠ごとに位置の基準を作る。
                          // ボタンの入れ子は作れないので、本体と解除は兄弟にする。
                          <span key={placement.groupId} className="relative flex flex-1">
                            <button
                              type="button"
                              title={[
                                placement.groupName,
                                "：",
                                placement.fixed
                                  ? "仮決めした枠です"
                                  : placement.moved
                                    ? "仮決めは外れていますが、場所はここに残っています。押すと仮決めに戻ります"
                                    : "押すとこの枠で仮決めになります",
                                movable
                                  ? "。長押しで掴むと別の枠へ動かせます（動かすと仮決めになります）"
                                  : "。ほかに全員が空いている枠が無いので、動かせません",
                              ].join("")}
                              onPointerDown={(pointerEvent) =>
                                startHold(pointerEvent, {
                                  groupId: placement.groupId,
                                  label: placement.groupName,
                                  color: placement.groupColor,
                                  cover: coverOf(placement),
                                })
                              }
                              onClick={() => {
                                // 掴んで離した直後のクリックは押下として扱わない。
                                if (consumeDrop()) return;
                                // 仮決め済みの枠は本体を押しても外さない。押し間違いで外れると、
                                // 解いた結果が別の場所へ飛んで「動かしたものが戻った」ように見える。
                                // 外すのは右上の × から。
                                if (placement.fixed) return;
                                onToggleFixed(placement);
                              }}
                              className={cn(
                                "flex w-full items-center justify-center gap-1 px-1 text-center font-medium text-[10px] leading-[1.2]",
                                "transition-opacity hover:opacity-85",
                                state.source?.groupId === placement.groupId
                                  ? "cursor-grabbing"
                                  : movable
                                    ? "cursor-grab"
                                    : "cursor-pointer",
                              )}
                              style={{
                                // 3 つの状態を **形** で分ける（濃さだけだと色によって差が消える）。
                                //   自動で置かれた = 破線の縁取り
                                //   掴んで動かした = 実線の縁取り（動かないが、決めてはいない）
                                //   仮決めした     = 色で塗りつぶし + 📌
                                ...(placement.fixed
                                  ? { backgroundColor: placement.groupColor, color: "#ffffff" }
                                  : {
                                      backgroundColor: `${placement.groupColor}1f`,
                                      color: placement.groupColor,
                                      border: `1.5px ${placement.moved ? "solid" : "dashed"} ${placement.groupColor}`,
                                    }),
                                // 掴んでいる本体は薄くする。「持ち上げた」ことが分かる。
                                opacity: state.source?.groupId === placement.groupId ? 0.3 : 1,
                              }}
                            >
                              {placement.fixed ? (
                                <Pin className="size-2.5 shrink-0" aria-hidden />
                              ) : placement.moved ? (
                                <Move className="size-2.5 shrink-0" aria-hidden />
                              ) : (
                                <CircleDashed className="size-2.5 shrink-0" aria-hidden />
                              )}
                              <span className="truncate">{placement.groupName}</span>
                            </button>
                            {/* 解除は本体とは別の当たり判定にする。掴む操作と取り違えないよう、
                            開始コマの行にだけ小さく出す。 */}
                            {placement.fixed && definition.slot === placement.startSlot && (
                              <button
                                type="button"
                                title={`${placement.groupName} の仮決めを解除する`}
                                aria-label={`${placement.groupName} の仮決めを解除する`}
                                onClick={() => onToggleFixed(placement)}
                                className="absolute top-0.5 right-0.5 flex size-4 cursor-pointer items-center justify-center rounded-full bg-white/25 text-white transition-colors hover:bg-white/45"
                              >
                                <PinOff className="size-2.5" aria-hidden />
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
