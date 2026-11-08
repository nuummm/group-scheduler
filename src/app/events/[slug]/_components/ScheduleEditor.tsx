import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { slotHeading } from "@/lib/schedule";
import type { EventDetail } from "@/lib/types";
import { Field, inputClass } from "../../../_components/ui";
import { terms } from "../../../_lib/app-config";
import { CategoryChips, nextSingleSelection } from "./CategoryChips";

/**
 * 自分の予定を塗る表。
 *
 * ドラッグでまとめて塗れて、キーボードでも 1 マスずつ切り替えられる。
 * `pointerdown` だけで処理して `click` を打ち消すと、Enter / Space が無反応になり
 * キーボードだけでは予定を入力できない。ここではポインタとキーボードの経路を明示的に分ける。
 */

export interface EditorDraft {
  busy: Set<string>;
  groupIds: number[];
  /** 区分は 1 人 1 つ。未選択は null。 */
  gradeId: number | null;
  note: string;
}

export function cellId(columnKey: string, slot: number): string {
  return `${columnKey}:${slot}`;
}

export function ScheduleEditor({
  event,
  draft,
  onChange,
}: {
  event: EventDetail;
  draft: EditorDraft;
  onChange: (next: EditorDraft) => void;
}) {
  const { group: groupTerm, role: roleTerm } = terms();
  // ドラッグ塗り中かどうかは ref で見る。state だと pointerdown と同じ tick で来る
  // pointerenter の時点でまだ false のままで、1 マス目から先に塗れない。
  const draggingRef = useRef(false);
  // 直前の塗りがポインタ由来か。続けて来る click がこれを消費する。
  // タイマーで倒すと click との順序が環境依存になり、二重反転が起きる。
  const pointerPaintRef = useRef(false);
  // ドラッグ中に「塗る / 消す」のどちらをしているか。開始マスの状態の逆で固定する。
  const paintValueRef = useRef(false);
  const visitedRef = useRef(new Set<string>());

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  /**
   * 直近の集合。props は「その回の描画時点」のものなので、再描画が挟まらずに
   * 2 回続けて塗ると、2 回目が 1 回目を無かったことにする（そのマスは
   * visitedRef に入っているので二度と塗られない）。ここを正本にして積む。
   */
  const busyRef = useRef(draft.busy);
  useEffect(() => {
    busyRef.current = draft.busy;
  }, [draft.busy]);

  const setBusy = useCallback(
    (id: string, busy: boolean) => {
      const next = new Set(busyRef.current);
      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      busyRef.current = next;
      onChange({ ...draft, busy: next });
    },
    [draft, onChange],
  );

  const startPaint = (id: string) => {
    const busy = !busyRef.current.has(id);
    paintValueRef.current = busy;
    visitedRef.current = new Set([id]);
    draggingRef.current = true;
    setBusy(id, busy);
  };

  const continuePaint = (id: string) => {
    if (!draggingRef.current || visitedRef.current.has(id)) return;
    visitedRef.current.add(id);
    setBusy(id, paintValueRef.current);
  };

  const isWeekly = event.scheduleMode === "weekly";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-muted text-xs">
        <span>
          {"予定が入っているコマを選んでください。マウスならドラッグでまとめて塗れます。"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-[3px] bg-busy-soft ring-1 ring-busy/40" />
          予定あり
        </span>
        <span className="ml-auto font-medium text-ink tabular-nums">
          {draft.busy.size} コマ選択中
        </span>
      </div>

      <div
        // 塗り広げは、マスごとの pointerenter ではなく座標から引く。
        // enter は速く動かすと飛ばされ、通ったはずのマスが塗り残る。
        onPointerMove={(pointerEvent) => {
          // ボタンが離れていたら塗らない。掴んだまま右クリックしたり、
          // ウィンドウの外で離したりすると pointerup が届かず、
          // 押していないのに指を動かすだけで塗り続ける状態になる。
          if (pointerEvent.buttons === 0) {
            draggingRef.current = false;
            return;
          }
          if (!draggingRef.current) return;
          const target = document
            .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
            ?.closest<HTMLElement>("[data-paint-cell]");
          const id = target?.dataset.paintCell;
          if (id) continuePaint(id);
        }}
        className="matrix-scroll paint-grid rounded-[var(--radius-control)] border border-line"
      >
        <table className="matrix-table w-full text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className="w-20 min-w-20 px-2 py-2 text-center text-ink-muted text-xs"
              >
                {isWeekly ? "時限" : "時間"}
              </th>
              {event.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="min-w-[4rem] px-2 py-2 text-center font-medium text-ink text-xs"
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
                  className="px-2 py-1.5 text-center font-medium text-ink text-[11px] leading-tight"
                >
                  {slotHeading(slotDefinition, event.scheduleMode)}
                </th>
                {event.columns.map((column) => {
                  const id = cellId(column.key, slotDefinition.slot);
                  const busy = draft.busy.has(id);
                  return (
                    <td key={id} className="p-0">
                      <button
                        type="button"
                        aria-pressed={busy}
                        aria-label={`${column.label} ${slotHeading(slotDefinition, event.scheduleMode)}: ${busy ? "予定あり" : "予定なし"}`}
                        onPointerDown={(pointerEvent) => {
                          // タッチはドラッグ塗りに使わない。ここで既定動作を止めると
                          // 表をスクロールできなくなり、列の多いイベントで入力できなくなる。
                          // 直前のマウス操作で立った印はここで倒す。残すと、続くタップが
                          // 「ポインタで処理済み」と見なされて 1 回無視される。
                          if (pointerEvent.pointerType === "touch") {
                            pointerPaintRef.current = false;
                            return;
                          }
                          if (pointerEvent.button !== 0) return;
                          pointerEvent.preventDefault();
                          pointerPaintRef.current = true;
                          startPaint(id);
                        }}
                        data-paint-cell={id}
                        onClick={(clickEvent) => {
                          // ポインタのドラッグ塗りは pointerdown 側で処理済みなので、
                          // ここで扱うのはキーボード（detail === 0）とタッチのタップだけ。
                          const handledByPointer = pointerPaintRef.current;
                          pointerPaintRef.current = false;
                          if (clickEvent.detail === 0 || !handledByPointer) {
                            // 判定も ref から。props は「その回の描画時点」なので、
                            // 正本が 2 つあると連続操作で食い違う。
                            setBusy(id, !busyRef.current.has(id));
                          }
                        }}
                        className={cn(
                          "flex h-full min-h-[2.4rem] w-full cursor-pointer items-center justify-center text-xs transition-colors",
                          busy
                            ? "bg-busy-soft font-medium text-busy"
                            : "text-ink-subtle hover:bg-surface-muted",
                        )}
                      >
                        {busy ? "予定" : ""}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset>
        <legend className="mb-1.5 font-medium text-ink text-xs">{roleTerm}</legend>
        <CategoryChips
          items={event.grades}
          selectedIds={draft.gradeId === null ? [] : [draft.gradeId]}
          mode="single"
          onToggle={(id, selected) =>
            onChange({ ...draft, gradeId: nextSingleSelection(draft.gradeId, id, selected) })
          }
        />
      </fieldset>

      {event.groups.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 font-medium text-ink text-xs">参加する{groupTerm}</legend>
          <CategoryChips
            items={event.groups}
            selectedIds={draft.groupIds}
            mode="multi"
            onToggle={(id, selected) =>
              onChange({
                ...draft,
                groupIds: selected
                  ? [...draft.groupIds, id]
                  : draft.groupIds.filter((value) => value !== id),
              })
            }
          />
        </fieldset>
      )}

      <Field label="備考" hint="全体表には出ません。メンバー一覧にメモとして表示されます。">
        <textarea
          rows={2}
          maxLength={500}
          className={inputClass}
          placeholder="例: 木曜の午後は不定期で外出"
          value={draft.note}
          onChange={(changeEvent) => onChange({ ...draft, note: changeEvent.target.value })}
        />
      </Field>
    </div>
  );
}
