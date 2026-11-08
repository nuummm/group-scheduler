import { describe, expect, it } from "vitest";
import { countStreak, fiscalYearStart } from "./attendance-stats";

/**
 * 連続で来た日の数え方。
 *
 * 「今日まだ来ていないだけ」で連続が切れて見えると、称号が日中に消えたり戻ったりする。
 * 起点を今日と昨日のどちらでも許す挙動をここで固定する。
 */

describe("countStreak", () => {
  it("今日から遡って連続している日数を数える", () => {
    const days = new Set(["2026-04-10", "2026-04-09", "2026-04-08"]);
    expect(countStreak(days, "2026-04-10")).toBe(3);
  });

  it("今日まだ来ていなくても、昨日までの連続は保つ", () => {
    const days = new Set(["2026-04-09", "2026-04-08"]);
    expect(countStreak(days, "2026-04-10")).toBe(2);
  });

  it("昨日も今日も来ていなければ 0", () => {
    const days = new Set(["2026-04-08", "2026-04-07"]);
    expect(countStreak(days, "2026-04-10")).toBe(0);
  });

  it("途中で 1 日空いたらそこで止まる", () => {
    const days = new Set(["2026-04-10", "2026-04-09", "2026-04-07", "2026-04-06"]);
    expect(countStreak(days, "2026-04-10")).toBe(2);
  });

  it("月をまたいでも続く", () => {
    const days = new Set(["2026-05-01", "2026-04-30", "2026-04-29"]);
    expect(countStreak(days, "2026-05-01")).toBe(3);
  });

  it("年をまたいでも続く", () => {
    const days = new Set(["2027-01-01", "2026-12-31", "2026-12-30"]);
    expect(countStreak(days, "2027-01-01")).toBe(3);
  });

  it("年度（4/1）をまたいでも切れない", () => {
    // 取り出す範囲を年度で切ると、3 月から毎日来ている人が 4/2 に「4 日連続」になり、
    // 3/30 から来始めた人と並んでしまう。
    const days = new Set<string>();
    for (let day = 20; day <= 31; day += 1) {
      days.add(`2026-03-${day}`);
    }
    days.add("2026-04-01");
    days.add("2026-04-02");
    expect(countStreak(days, "2026-04-02")).toBe(14);
  });

  it("記録がなければ 0", () => {
    expect(countStreak(new Set(), "2026-04-10")).toBe(0);
  });
});

/**
 * 年の称号を数える範囲。1 年は 4 月に入れ替わる前提なので、
 * 1/1 ではなく 4/1 で数え直る（記録そのものは消さない）。
 */
describe("fiscalYearStart", () => {
  it("4 月に入ると新しい年度になる", () => {
    expect(fiscalYearStart("2026-04-01")).toBe("2026-04-01");
    expect(fiscalYearStart("2026-08-11")).toBe("2026-04-01");
  });

  it("1〜3 月はまだ前の年度", () => {
    expect(fiscalYearStart("2026-03-31")).toBe("2025-04-01");
    expect(fiscalYearStart("2027-01-05")).toBe("2026-04-01");
  });
});
