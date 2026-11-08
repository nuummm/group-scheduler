/**
 * グループ 1 つぶんの開催候補を探す。
 *
 * やっていることは総当たり。列（曜日・日付）× 開始コマ を順に見て、
 * 「そのグループのメンバーのうち何人が、必要なコマ数のあいだ通して空いているか」を数えるだけ。
 * これを全グループぶん組み合わせて実行できる案にするのは `assignment.ts` の役目。
 *
 * 最適化ソルバーは使わない。想定する規模（グループ十数件 × コマ数十 × メンバー数十人）では
 * 総当たりが数ミリ秒で終わり、WASM の依存を足す理由がない。
 */

/** 誰がどのコマに予定を入れているか。`${列キー}:${コマ番号}` の集合。 */
export type BusyKeySet = ReadonlySet<string>;

export interface CandidateMember {
  name: string;
  /** この人が予定を入れているコマ。 */
  busy: BusyKeySet;
}

export interface CandidateSlot {
  columnKey: string;
  columnLabel: string;
  startSlot: number;
  endSlot: number;
  /** 通して空いているメンバーの数。 */
  freeCount: number;
  /** 通して空いているメンバーの名前。誰なら出られるかを画面にそのまま出す。 */
  freeNames: string[];
  /** 1 コマでも予定が入っているメンバーの名前。 */
  busyNames: string[];
}

export function cellKey(columnKey: string, slot: number): string {
  return `${columnKey}:${slot}`;
}

/** 1 つのグループに設定できる連続コマ数の上限。 */
export const MAX_SLOT_SPAN = 4;

/**
 * 1 つのグループについて候補を並べる。
 *
 * `slotSpan` が 2 なら「1〜2 限」「2〜3 限」…のように連続した枠だけを見る。
 * 列をまたいだ枠は作らない（曜日を跨いだ連続は開催枠として意味がない）。
 */
export function findCandidates(
  members: CandidateMember[],
  columns: { key: string; label: string }[],
  slotNumbers: number[],
  slotSpan: number,
): CandidateSlot[] {
  const span = Math.max(1, Math.trunc(slotSpan));
  if (members.length === 0 || slotNumbers.length < span) {
    return [];
  }

  const candidates: CandidateSlot[] = [];
  for (const column of columns) {
    for (let index = 0; index + span <= slotNumbers.length; index += 1) {
      const window = slotNumbers.slice(index, index + span);
      // 連続していない並び（追加コマの前後で番号が飛ぶ場合）は枠にしない。
      const isContiguous = window.every((slot, offset) => slot === (window[0] as number) + offset);
      if (!isContiguous) {
        continue;
      }
      const freeNames: string[] = [];
      const busyNames: string[] = [];
      for (const member of members) {
        const free = window.every((slot) => !member.busy.has(cellKey(column.key, slot)));
        (free ? freeNames : busyNames).push(member.name);
      }
      candidates.push({
        columnKey: column.key,
        columnLabel: column.label,
        startSlot: window[0] as number,
        endSlot: window[window.length - 1] as number,
        freeCount: freeNames.length,
        freeNames,
        busyNames,
      });
    }
  }

  // 集まる人が多い順。同数なら早い時間帯を優先する（決めやすいので）。
  // 列の並びは先に引けるようにしておく。比較のたびに findIndex すると、
  // 期間指定モード（61 列）では並べ替えだけで百万回の走査になる。
  const columnOrder = new Map(columns.map((column, index) => [column.key, index]));
  return candidates.sort(
    (a, b) =>
      b.freeCount - a.freeCount ||
      (columnOrder.get(a.columnKey) ?? 0) - (columnOrder.get(b.columnKey) ?? 0) ||
      a.startSlot - b.startSlot,
  );
}
