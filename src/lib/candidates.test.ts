import { describe, expect, it } from "vitest";
import { type CandidateMember, cellKey, findCandidates } from "./candidates";

/**
 * グループの開催候補さがし。
 *
 * 「全員が通して空いている枠」を取りこぼさないこと、コマ数ぶん連続していない枠を
 * 候補にしないこと、並び順（多い順 → 早い順）を固定する。
 */

const COLUMNS = [
  { key: "mon", label: "月曜日" },
  { key: "tue", label: "火曜日" },
];
const SLOTS = [1, 2, 3];

function member(name: string, busy: string[]): CandidateMember {
  return { name, busy: new Set(busy) };
}

describe("findCandidates", () => {
  it("全員が空いている枠を見つける", () => {
    const members = [member("A", [cellKey("mon", 1)]), member("B", [cellKey("mon", 2)])];
    const top = findCandidates(members, COLUMNS, SLOTS, 1)[0];
    expect(top?.freeCount).toBe(2);
    expect(top?.columnKey).toBe("mon");
    expect(top?.startSlot).toBe(3);
  });

  it("必要なコマ数のあいだ通して空いていないと候補にならない", () => {
    // A は月2限だけ埋まっている。2 コマ続きなら月1-2 も月2-3 も不可。
    const members = [member("A", [cellKey("mon", 2)])];
    const twoSlots = findCandidates(members, COLUMNS, SLOTS, 2);
    const monday = twoSlots.filter((item) => item.columnKey === "mon");
    expect(monday.every((item) => item.freeCount === 0)).toBe(true);
    // 火曜は空いているので 2 コマ続きが取れる
    expect(twoSlots[0]?.columnKey).toBe("tue");
    expect(twoSlots[0]?.freeCount).toBe(1);
  });

  it("コマ数ぶんの枠が作れないときは候補なし", () => {
    expect(findCandidates([member("A", [])], COLUMNS, [1, 2], 3)).toEqual([]);
  });

  it("メンバーがいなければ候補なし", () => {
    expect(findCandidates([], COLUMNS, SLOTS, 1)).toEqual([]);
  });

  it("空いている人が多い順、同数なら早い枠が先", () => {
    const members = [
      member("A", [cellKey("mon", 1), cellKey("mon", 2), cellKey("mon", 3)]),
      member("B", []),
    ];
    const result = findCandidates(members, COLUMNS, SLOTS, 1);
    // 火曜は 2 人、月曜は 1 人
    expect(result[0]?.freeCount).toBe(2);
    expect(result[0]?.columnKey).toBe("tue");
    expect(result[0]?.startSlot).toBe(1);
    expect(result.at(-1)?.freeCount).toBe(1);
  });

  it("番号が飛んでいる並びは連続した枠として扱わない", () => {
    // 追加コマを消したあとなど、コマ番号が 1,2,4 と飛ぶ場合
    const result = findCandidates([member("A", [])], COLUMNS, [1, 2, 4], 2);
    expect(result.every((item) => item.endSlot - item.startSlot === 1)).toBe(true);
    expect(result.some((item) => item.startSlot === 2)).toBe(false);
  });

  it("誰が出られて誰が出られないかを名前で返す", () => {
    const members = [member("A", [cellKey("mon", 1)]), member("B", [])];
    const monday1 = findCandidates(members, COLUMNS, SLOTS, 1).find(
      (item) => item.columnKey === "mon" && item.startSlot === 1,
    );
    expect(monday1?.freeNames).toEqual(["B"]);
    expect(monday1?.busyNames).toEqual(["A"]);
  });
});
