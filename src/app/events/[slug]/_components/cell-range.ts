/**
 * 全体表で選ぶ「時間帯」の計算。
 *
 * 選べるのは **同じ列の連続したコマ** だけ。別々の曜日や飛び飛びのコマをまとめても
 * 「その時間帯」にはならないので、範囲は 1 列の連続区間に限っている。
 *
 * DOM を触らない純粋な計算にしてあるのは、ポインタ操作の分岐（押す / 伸ばす / 押し直す）が
 * 手で確かめにくいところだから。ここをテストで固定しておけば、描画側は
 * 「イベントをこの関数に流す」だけで済む。
 */

export interface CellRange {
  columnKey: string;
  startSlot: number;
  endSlot: number;
}

export interface CellPosition {
  columnKey: string;
  slot: number;
}

/** そのマスが選択範囲に入っているか。 */
export function isInRange(range: CellRange | null, columnKey: string, slot: number): boolean {
  return (
    range !== null &&
    range.columnKey === columnKey &&
    slot >= range.startSlot &&
    slot <= range.endSlot
  );
}

/**
 * マスを押したときの次の選択。
 * すでに「そのマス 1 つだけ」が選ばれていれば、押し直しで選択を解く。
 */
export function selectionAfterPress(current: CellRange | null, at: CellPosition): CellRange | null {
  const isSameSingle =
    current?.columnKey === at.columnKey &&
    current.startSlot === at.slot &&
    current.endSlot === at.slot;
  return isSameSingle ? null : { columnKey: at.columnKey, startSlot: at.slot, endSlot: at.slot };
}

/**
 * ドラッグで伸ばしたときの次の選択。
 * 列をまたいだ移動は無視する（時間帯として意味を持たないため、現在の選択を保つ）。
 */
export function selectionAfterDrag(
  current: CellRange | null,
  anchor: CellPosition,
  at: CellPosition,
): CellRange | null {
  if (anchor.columnKey !== at.columnKey) {
    return current;
  }
  return {
    columnKey: anchor.columnKey,
    startSlot: Math.min(anchor.slot, at.slot),
    endSlot: Math.max(anchor.slot, at.slot),
  };
}
