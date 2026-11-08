import { describe, expect, it } from "vitest";
import {
  buildColumns,
  DEFAULT_WEEKDAYS,
  DEFAULT_WEEKLY_SLOTS,
  describeWeeklyLayout,
  formatDisplayDate,
  getSlotDefinitions,
  iterDates,
  MAX_RANGE_DAYS,
  parseWeekdays,
  parseWeeklySlots,
  slotHeading,
  weekdayColumns,
} from "./schedule";
import { parseList } from "./site-config";

/**
 * 列とコマの組み立て。ここがずれると「保存できたのに表に出ない」形の壊れ方をするので、
 * 境界（日数の上限・順序・タイムゾーンによる日付のずれ）を固定しておく。
 */

describe("iterDates", () => {
  it("開始日と終了日を含む連続した日付を返す", () => {
    expect(iterDates("2026-04-01", "2026-04-04")).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04",
    ]);
  });

  it("同じ日なら 1 日ぶんになる", () => {
    expect(iterDates("2026-04-01", "2026-04-01")).toEqual(["2026-04-01"]);
  });

  it("月をまたいでも連続する", () => {
    expect(iterDates("2026-04-29", "2026-05-02")).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
    ]);
  });

  it("終了日が開始日より前なら拒否する", () => {
    expect(() => iterDates("2026-04-05", "2026-04-01")).toThrow(/終了日/);
  });

  it("上限ちょうどは通り、1 日超えると拒否する", () => {
    const start = new Date(Date.UTC(2026, 3, 1));
    const lastAllowed = new Date(start.getTime() + (MAX_RANGE_DAYS - 1) * 86_400_000);
    const tooFar = new Date(start.getTime() + MAX_RANGE_DAYS * 86_400_000);
    expect(iterDates("2026-04-01", lastAllowed.toISOString().slice(0, 10))).toHaveLength(
      MAX_RANGE_DAYS,
    );
    expect(() => iterDates("2026-04-01", tooFar.toISOString().slice(0, 10))).toThrow(/日以内/);
  });
});

describe("formatDisplayDate", () => {
  it("曜日つきの表示にする", () => {
    // 2026-04-01 は水曜日
    expect(formatDisplayDate("2026-04-01")).toBe("4/1（水）");
  });

  it("月初でもローカルタイムゾーンで前日にずれない", () => {
    expect(formatDisplayDate("2026-01-01")).toBe("1/1（木）");
  });
});

describe("buildColumns", () => {
  it("毎週固定は月〜金の 5 列", () => {
    const columns = buildColumns("weekly", "", "");
    expect(columns.map((column) => column.key)).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  it("期間指定は日付が列キーになる", () => {
    const columns = buildColumns("date_range", "2026-04-01", "2026-04-02");
    expect(columns.map((column) => column.key)).toEqual(["2026-04-01", "2026-04-02"]);
  });
});

describe("getSlotDefinitions", () => {
  it("毎週固定は既定で 6 コマ", () => {
    expect(getSlotDefinitions("weekly")).toHaveLength(6);
  });

  it("追加コマは基本のコマの後ろに番号を続ける", () => {
    const base = parseWeeklySlots("9:00-10:00,10:00-11:00");
    const slots = getSlotDefinitions(
      "weekly",
      [{ label: "夜", start: "19:00", end: "20:00" }],
      base,
    );
    expect(slots.map((slot) => slot.slot)).toEqual([1, 2, 3]);
    expect(slotHeading(slots[2] as (typeof slots)[number], "weekly")).toBe("夜");
  });

  it("期間指定は 24 コマで、隣り合うコマの終わりと始まりがつながる", () => {
    const slots = getSlotDefinitions("date_range");
    expect(slots).toHaveLength(24);
    expect(slots[0]?.start).toBe("00:00");
    expect(slots[0]?.end).toBe(slots[1]?.start);
    expect(slots[23]?.end).toBe("00:00");
  });
});

describe("slotHeading", () => {
  it("モードごとに見出しの出し方を変える", () => {
    const weekly = getSlotDefinitions("weekly")[0];
    const hourly = getSlotDefinitions("date_range")[9];
    if (!weekly || !hourly) throw new Error("スロット定義が空");
    expect(slotHeading(weekly, "weekly")).toBe("1限");
    expect(slotHeading(hourly, "date_range")).toBe("09:00");
  });
});

describe("parseWeeklySlots", () => {
  it("見出しを省くと「N限」、付ければその名前", () => {
    expect(parseWeeklySlots("9:00-10:30,10:40-12:10").map((slot) => slot.label)).toEqual([
      "1限",
      "2限",
    ]);
    const named = parseWeeklySlots("朝会=8:30-9:00,午前=9:00-12:00");
    expect(named.map((slot) => [slot.slot, slot.label, slot.start, slot.end])).toEqual([
      [1, "朝会", "8:30", "9:00"],
      [2, "午前", "9:00", "12:00"],
    ]);
  });

  it("読めない・重なる・空のときは既定値に戻す（半端に読んだ時間割で動かさない）", () => {
    expect(parseWeeklySlots("")).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseWeeklySlots("9:00-10:30,abc")).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseWeeklySlots("9:00-10:30,10:00-11:00")).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseWeeklySlots("10:30-9:00")).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseWeeklySlots("A=9:00-10:00,A=10:00-11:00")).toBe(DEFAULT_WEEKLY_SLOTS);
  });
});

describe("parseWeekdays", () => {
  it("曜日の順に並べ直し、知らないキーがあれば既定値に戻す", () => {
    expect(parseWeekdays("sat, mon ,wed")).toEqual(["mon", "wed", "sat"]);
    expect(parseWeekdays("mon,someday")).toBe(DEFAULT_WEEKDAYS);
    expect(parseWeekdays("")).toBe(DEFAULT_WEEKDAYS);
  });

  it("要約は先頭と末尾だけを並べる", () => {
    expect(describeWeeklyLayout(weekdayColumns(DEFAULT_WEEKDAYS), DEFAULT_WEEKLY_SLOTS)).toBe(
      "月〜金 × 1限〜6限",
    );
  });
});

describe("parseList", () => {
  it("空要素と重複を落とし、空なら既定値", () => {
    expect(parseList(" a, b ,,a ", ["x"])).toEqual(["a", "b"]);
    expect(parseList("", ["x"])).toEqual(["x"]);
  });
});
