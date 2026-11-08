import { describe, expect, it } from "vitest";
import { isInRange, selectionAfterDrag, selectionAfterPress } from "./cell-range";

/**
 * 全体表の時間帯選択。
 *
 * 「1・2 限をまとめて見る」ための機能なので、同じ列の連続区間しか作らないこと、
 * 押し直しで解けること、列をまたいだドラッグを無視することを固定する。
 */

describe("selectionAfterPress", () => {
  it("何も選んでいなければ、そのマス 1 つを選ぶ", () => {
    expect(selectionAfterPress(null, { columnKey: "mon", slot: 3 })).toEqual({
      columnKey: "mon",
      startSlot: 3,
      endSlot: 3,
    });
  });

  it("同じ 1 マスを押し直すと選択が解ける", () => {
    const current = { columnKey: "mon", startSlot: 3, endSlot: 3 };
    expect(selectionAfterPress(current, { columnKey: "mon", slot: 3 })).toBeNull();
  });

  it("範囲を選んでいる状態でその中の 1 マスを押すと、そのマスだけの選択になる", () => {
    const current = { columnKey: "mon", startSlot: 1, endSlot: 4 };
    expect(selectionAfterPress(current, { columnKey: "mon", slot: 3 })).toEqual({
      columnKey: "mon",
      startSlot: 3,
      endSlot: 3,
    });
  });

  it("別の列を押したら、その列の 1 マスに移る", () => {
    const current = { columnKey: "mon", startSlot: 3, endSlot: 3 };
    expect(selectionAfterPress(current, { columnKey: "tue", slot: 3 })).toEqual({
      columnKey: "tue",
      startSlot: 3,
      endSlot: 3,
    });
  });
});

describe("selectionAfterDrag", () => {
  const anchor = { columnKey: "mon", slot: 2 };

  it("下へ伸ばすと連続した範囲になる", () => {
    expect(selectionAfterDrag(null, anchor, { columnKey: "mon", slot: 5 })).toEqual({
      columnKey: "mon",
      startSlot: 2,
      endSlot: 5,
    });
  });

  it("上へ伸ばしても向きが揃う", () => {
    expect(selectionAfterDrag(null, anchor, { columnKey: "mon", slot: 1 })).toEqual({
      columnKey: "mon",
      startSlot: 1,
      endSlot: 2,
    });
  });

  it("起点まで戻せば 1 マスに戻る", () => {
    expect(selectionAfterDrag(null, anchor, { columnKey: "mon", slot: 2 })).toEqual({
      columnKey: "mon",
      startSlot: 2,
      endSlot: 2,
    });
  });

  it("列をまたいだ移動は無視して、いまの選択を保つ", () => {
    const current = { columnKey: "mon", startSlot: 2, endSlot: 4 };
    expect(selectionAfterDrag(current, anchor, { columnKey: "tue", slot: 6 })).toEqual(current);
  });
});

describe("isInRange", () => {
  const range = { columnKey: "mon", startSlot: 2, endSlot: 4 };

  it("範囲の内側と両端は含む", () => {
    expect(isInRange(range, "mon", 2)).toBe(true);
    expect(isInRange(range, "mon", 3)).toBe(true);
    expect(isInRange(range, "mon", 4)).toBe(true);
  });

  it("範囲の外や別の列は含まない", () => {
    expect(isInRange(range, "mon", 1)).toBe(false);
    expect(isInRange(range, "mon", 5)).toBe(false);
    expect(isInRange(range, "tue", 3)).toBe(false);
  });

  it("未選択なら常に false", () => {
    expect(isInRange(null, "mon", 3)).toBe(false);
  });
});
