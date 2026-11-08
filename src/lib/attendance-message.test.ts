import { describe, expect, it } from "vitest";
import {
  buildArrivalGroupMessage,
  buildArrivalMessage,
  escapeSlackText,
  timeBandOf,
} from "./attendance-message";

/**
 * 知りたいのは「行ったら誰かいるか」。一番乗りと合流が読み分けられることと、
 * 席の名前から Slack のメンションが飛ばないことを固定する。
 */

const base = { label: "かえで", named: true, presentCount: 1, hour: 9, place: "部屋" };

describe("timeBandOf", () => {
  it("朝・昼・夜で分かれる", () => {
    expect(timeBandOf(5)).toBe("morning");
    expect(timeBandOf(10)).toBe("morning");
    expect(timeBandOf(11)).toBe("day");
    expect(timeBandOf(17)).toBe("day");
    expect(timeBandOf(18)).toBe("night");
    expect(timeBandOf(3)).toBe("night");
  });
});

describe("escapeSlackText", () => {
  it("メンションになる記号を潰す", () => {
    // 席の名前は誰でも変えられる。そのまま流すと全員に通知が飛ぶ。
    expect(escapeSlackText("<!channel>")).toBe("&lt;!channel&gt;");
    expect(escapeSlackText("A&B")).toBe("A&amp;B");
  });
});

describe("buildArrivalMessage", () => {
  it("一番乗りと合流を言い分ける", () => {
    const first = buildArrivalMessage({ ...base, hour: 9, presentCount: 1 });
    const join = buildArrivalMessage({ ...base, hour: 9, presentCount: 3 });
    expect(first).toContain("部屋を開けました");
    expect(join).toContain("来ました");
    expect(join).not.toContain("開けました");
  });

  it("時間帯で言い方が変わる", () => {
    expect(buildArrivalMessage({ ...base, hour: 8 })).toContain("開けました");
    expect(buildArrivalMessage({ ...base, hour: 14 })).toContain("いちばん乗り");
    expect(buildArrivalMessage({ ...base, hour: 21 })).toContain("灯りをつけました");
  });

  it("人数を必ず添える（時刻は出さない。Slack が持っている）", () => {
    expect(buildArrivalMessage({ ...base, hour: 14, presentCount: 3 })).toBe(
      "*かえで* が合流しました・いま部屋には 3 人います。",
    );
  });

  it("既定名のままなら名前を出さない", () => {
    const message = buildArrivalMessage({ ...base, label: "空席 A", named: false });
    expect(message).not.toContain("空席");
    expect(message).toContain("だれか");
  });

  it("人数は 1 を下回らない", () => {
    expect(buildArrivalMessage({ ...base, presentCount: 0 })).toContain(
      "いま部屋には 1 人います。",
    );
  });
});

/**
 * 猶予のあいだに続けて来た人は 1 通にまとめる。
 * 人数ぶん通知が出ること自体には情報がない（知りたいのは「行ったら誰かいるか」）。
 */
describe("buildArrivalGroupMessage", () => {
  const named = (label: string) => ({ label, named: true });

  it("複数人を 1 通にまとめて名前を並べる（並ぶので太字にはしない）", () => {
    const message = buildArrivalGroupMessage({
      arrivals: [named("かえで"), named("りく")],
      presentCount: 2,
      hour: 9,
      place: "部屋",
    });
    expect(message).toBe("かえで、りく が部屋を開けました・いま部屋には 2 人います。");
    expect(message).not.toContain("*");
  });

  it("全員が同時に来た＝一番乗りとして扱う（1 人だけのときと同じ判定にしない）", () => {
    // 3 人まとめて来て在室が 3 人なら、その 3 人が最初の入室者。
    const first = buildArrivalGroupMessage({
      arrivals: [named("A"), named("B"), named("C")],
      presentCount: 3,
      hour: 14,
      place: "部屋",
    });
    expect(first).toContain("いちばん乗り");
    // すでに 2 人いたところへ 3 人来たなら合流。
    const join = buildArrivalGroupMessage({
      arrivals: [named("A"), named("B"), named("C")],
      presentCount: 5,
      hour: 14,
      place: "部屋",
    });
    expect(join).toContain("合流しました");
  });

  it("既定名の席が混ざったら、名前のある人だけ挙げて残りは数える", () => {
    const message = buildArrivalGroupMessage({
      arrivals: [named("かえで"), { label: "空席 A", named: false }],
      presentCount: 2,
      hour: 14,
      place: "部屋",
    });
    expect(message).toContain("かえで ほか 1 人");
    expect(message).not.toContain("空席");
  });

  it("全員が既定名なら名前を出さず、来たことだけを伝える", () => {
    const message = buildArrivalGroupMessage({
      arrivals: [
        { label: "空席 A", named: false },
        { label: "空席 B", named: false },
      ],
      presentCount: 2,
      hour: 14,
      place: "部屋",
    });
    expect(message).toBe("何人か来たようです・いま部屋には 2 人います。");
    expect(message).not.toContain("空席");
  });

  it("席の名前からメンションが飛ばない", () => {
    const message = buildArrivalGroupMessage({
      arrivals: [named("<!channel>"), named("佐藤")],
      presentCount: 2,
      hour: 14,
      place: "部屋",
    });
    expect(message).not.toContain("<!channel>");
    expect(message).toContain("&lt;!channel&gt;");
  });

  it("在室人数が来た人数より少なくても、来た人数を下回らない", () => {
    // 送信の直前に誰かが不在へ戻すと、在室が来た人数より少なくなりうる。
    const message = buildArrivalGroupMessage({
      arrivals: [named("A"), named("B"), named("C")],
      presentCount: 1,
      hour: 14,
      place: "部屋",
    });
    expect(message).toContain("いま部屋には 3 人います。");
  });
});
