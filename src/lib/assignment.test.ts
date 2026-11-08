import { describe, expect, it } from "vitest";
import { assignSeminars, type SeminarInput } from "./assignment";
import { cellKey } from "./candidates";

/**
 * 全グループの同時割り当て。
 *
 * この機能の存在理由は掛け持ちなので、「同じ人がいるグループを同時刻に置かない」ことと、
 * 「置き方の選び方で全員が出られる案を逃さない」ことを固定する。
 */

const COLUMNS = [
  { key: "mon", label: "月" },
  { key: "tue", label: "火" },
];
const SLOTS = [1, 2, 3];

function seminar(
  groupId: number,
  groupName: string,
  members: { name: string; busy?: string[] }[],
  slotSpan = 1,
  extra: Partial<
    Pick<SeminarInput, "requiredNames" | "placedStart" | "pinned" | "requiredMissing">
  > = {},
): SeminarInput {
  return {
    groupId,
    groupName,
    groupColor: "#000000",
    slotSpan,
    members: members.map((member) => ({ name: member.name, busy: new Set(member.busy ?? []) })),
    ...extra,
  };
}

describe("assignSeminars", () => {
  it("掛け持ちの人がいるグループを同時刻に置かない", () => {
    const result = assignSeminars(
      [
        seminar(1, "最適化", [{ name: "A" }, { name: "B" }]),
        seminar(2, "勉強会", [{ name: "A" }, { name: "C" }]),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements).toHaveLength(2);
    const [first, second] = result.placements;
    if (!first || !second) throw new Error("両方置かれるはず");
    const sameTime =
      first.columnKey === second.columnKey &&
      first.startSlot <= second.endSlot &&
      second.startSlot <= first.endSlot;
    expect(sameTime).toBe(false);
  });

  it("メンバーが重ならなくても同じコマには置かない", () => {
    // 部屋も主宰者も 1 つなので、掛け持ちがいなくても同時には開けない。
    const result = assignSeminars(
      [seminar(1, "最適化", [{ name: "A" }]), seminar(2, "勉強会", [{ name: "B" }])],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements).toHaveLength(2);
    const [first, second] = result.placements;
    if (!first || !second) throw new Error("両方置かれるはず");
    const sameTime =
      first.columnKey === second.columnKey &&
      first.startSlot <= second.endSlot &&
      second.startSlot <= first.endSlot;
    expect(sameTime).toBe(false);
  });

  it("コマが 1 つしかなければ、片方は置けずに残る", () => {
    const result = assignSeminars(
      [seminar(1, "最適化", [{ name: "A" }]), seminar(2, "勉強会", [{ name: "B" }])],
      [{ key: "mon", label: "月" }],
      [1],
    );
    expect(result.placements).toHaveLength(1);
    expect(result.unplaced).toHaveLength(1);
  });

  it("全員が出られる組み合わせを見つける", () => {
    // A は月1限が埋まっている。最適化を月2限、勉強会を月1限に置けば全員出られる。
    const result = assignSeminars(
      [
        seminar(1, "最適化", [
          { name: "A", busy: [cellKey("mon", 1)] },
          { name: "B", busy: [cellKey("tue", 1), cellKey("tue", 2), cellKey("tue", 3)] },
        ]),
        seminar(2, "勉強会", [
          { name: "A", busy: [cellKey("mon", 1)] },
          { name: "C", busy: [cellKey("tue", 1), cellKey("tue", 2), cellKey("tue", 3)] },
        ]),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.fullyAttendedCount).toBe(2);
    expect(result.placements.every((item) => item.busyNames.length === 0)).toBe(true);
  });

  it("必要なコマ数ぶん連続して確保する", () => {
    const result = assignSeminars([seminar(1, "長い会", [{ name: "A" }], 2)], COLUMNS, SLOTS);
    const placement = result.placements[0];
    expect(placement?.endSlot).toBe((placement?.startSlot ?? 0) + 1);
  });

  it("置ける枠が無いグループは理由つきで残す", () => {
    const allBusy = [cellKey("mon", 1), cellKey("mon", 2), cellKey("mon", 3)];
    const result = assignSeminars(
      [seminar(1, "置けない会", [{ name: "A", busy: allBusy }])],
      [{ key: "mon", label: "月" }],
      SLOTS,
    );
    expect(result.placements).toHaveLength(0);
    expect(result.unplaced[0]?.groupName).toBe("置けない会");
  });

  it("メンバーのいないグループは対象外にする", () => {
    const result = assignSeminars([seminar(1, "空の会", [])], COLUMNS, SLOTS);
    expect(result.unplaced[0]?.reason).toContain("メンバー");
  });

  it("仮決めしてあってもメンバーがいなければ置かない", () => {
    const result = assignSeminars(
      [
        seminar(1, "空の会", [], 1, {
          placedStart: { columnKey: "mon", startSlot: 1 },
          pinned: true,
        }),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements).toHaveLength(0);
    expect(result.unplaced[0]?.reason).toContain("メンバー");
  });

  it("グループが無ければ何も返さない", () => {
    const result = assignSeminars([], COLUMNS, SLOTS);
    expect(result.placements).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("必ず参加する人が出られない枠は選ばない", () => {
    // 主宰者は月曜が全部埋まっている。月曜が空いていても月曜には置けない。
    const result = assignSeminars(
      [
        seminar(
          1,
          "定例",
          [
            { name: "A" },
            { name: "主宰者", busy: [cellKey("mon", 1), cellKey("mon", 2), cellKey("mon", 3)] },
          ],
          1,
          { requiredNames: ["主宰者"] },
        ),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements[0]?.columnKey).toBe("tue");
  });

  it("必ず参加する人がどこにも出られなければ置かない", () => {
    const allBusy = [
      cellKey("mon", 1),
      cellKey("mon", 2),
      cellKey("mon", 3),
      cellKey("tue", 1),
      cellKey("tue", 2),
      cellKey("tue", 3),
    ];
    const result = assignSeminars(
      [
        seminar(1, "定例", [{ name: "A" }, { name: "主宰者", busy: allBusy }], 1, {
          requiredNames: ["主宰者"],
        }),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements).toHaveLength(0);
    expect(result.unplaced[0]?.reason).toContain("必ず参加");
  });

  it("確定した枠は動かさず、他のグループがそれを避ける", () => {
    const result = assignSeminars(
      [
        seminar(1, "確定した会", [{ name: "A" }, { name: "B" }], 1, {
          placedStart: { columnKey: "mon", startSlot: 2 },
          pinned: true,
        }),
        seminar(2, "勉強会", [{ name: "A" }, { name: "C" }]),
      ],
      COLUMNS,
      [2],
    );
    const fixed = result.placements.find((item) => item.groupId === 1);
    expect(fixed?.columnKey).toBe("mon");
    expect(fixed?.startSlot).toBe(2);
    expect(fixed?.fixed).toBe(true);
    // 掛け持ちの A がいるので、勉強会は月2限を避けて火曜へ回る
    expect(result.placements.find((item) => item.groupId === 2)?.columnKey).toBe("tue");
  });

  it("確定した枠は全員に予定が入っていても残す", () => {
    const result = assignSeminars(
      [
        seminar(1, "確定した会", [{ name: "A", busy: [cellKey("mon", 1)] }], 1, {
          placedStart: { columnKey: "mon", startSlot: 1 },
          pinned: true,
        }),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]?.busyNames).toEqual(["A"]);
    expect(result.unplaced).toHaveLength(0);
  });

  it("掴んで動かしただけの場所も動かさない", () => {
    // 「置けると表示されたのに置けない」を防ぐため、仮決めでなくても人が置いた場所は動かさない。
    const result = assignSeminars(
      [
        seminar(1, "動かした会", [{ name: "A" }], 1, {
          placedStart: { columnKey: "tue", startSlot: 3 },
          pinned: false,
        }),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements[0]?.columnKey).toBe("tue");
    expect(result.placements[0]?.startSlot).toBe(3);
    // 動かしただけなので 📌 は付かない。
    expect(result.placements[0]?.fixed).toBe(false);
  });

  it("動かせる先には、他のグループが人の手で置かれている枠を入れない", () => {
    // 先客が月2限へ動かされているなら、その枠は「動かせる先」から外れる
    // （掛け持ちの有無は関係なく、同じコマには置かないため）。
    const result = assignSeminars(
      [
        seminar(1, "動かしたい", [{ name: "A" }, { name: "B" }]),
        seminar(2, "先客", [{ name: "C" }], 1, {
          placedStart: { columnKey: "mon", startSlot: 2 },
          pinned: false,
        }),
      ],
      COLUMNS,
      SLOTS,
    );
    const starts = result.placeableStarts.find((item) => item.groupId === 1)?.starts ?? [];
    expect(starts).not.toContain("mon:2");
    expect(starts).toContain("mon:1");
  });

  it("解いた結果で置かれているだけの枠は動かせる先に残る", () => {
    // どちらも人が置いていない。片方を動かせば、もう片方は自動で別の枠へ回る。
    const result = assignSeminars(
      [
        seminar(1, "動かしたい", [{ name: "A" }, { name: "B" }]),
        seminar(2, "自動配置", [{ name: "A" }, { name: "C" }]),
      ],
      COLUMNS,
      SLOTS,
    );
    const starts = result.placeableStarts.find((item) => item.groupId === 1)?.starts ?? [];
    const other = result.placements.find((item) => item.groupId === 2);
    expect(starts).toContain(`${other?.columnKey}:${other?.startSlot}`);
  });

  it("メンバーのいない仮決めグループのコマも、他のグループが避ける", () => {
    // 案には出さないが、全体表には 📌 が描かれたまま。そこへ別のグループを入れると
    // 画面上は同じコマに 2 つ並ぶ。
    const result = assignSeminars(
      [
        seminar(1, "空の先客", [], 1, {
          placedStart: { columnKey: "mon", startSlot: 1 },
          pinned: true,
        }),
        seminar(2, "勉強会", [{ name: "A" }]),
      ],
      [{ key: "mon", label: "月" }],
      [1, 2],
    );
    const placed = result.placements.find((item) => item.groupId === 2);
    expect(placed?.startSlot).toBe(2);
    expect(result.placeableStarts.find((item) => item.groupId === 2)?.starts).not.toContain(
      "mon:1",
    );
  });

  it("「必ず参加」の指定先にメンバーがいなければ、置かずに理由を出す", () => {
    // 制約が空になるだけだと「全員参加できます」と出てしまい、欠けていることに気づけない。
    const result = assignSeminars(
      [seminar(1, "定例", [{ name: "A" }], 1, { requiredMissing: true })],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements).toHaveLength(0);
    expect(result.fullyAttendedCount).toBe(0);
    expect(result.unplaced[0]?.reason).toContain("「必ず参加」の指定先");
  });

  it("コマ数が 1 日ぶんを超えているときは、予定のせいにしない", () => {
    const result = assignSeminars([seminar(1, "長すぎる会", [{ name: "A" }], 4)], COLUMNS, [1, 2]);
    expect(result.unplaced[0]?.reason).toContain("コマ数");
  });

  it("案に出さないグループの仮決めと重なったら、満点にしない", () => {
    const result = assignSeminars(
      [
        seminar(1, "空の先客", [], 1, {
          placedStart: { columnKey: "mon", startSlot: 1 },
          pinned: true,
        }),
        seminar(2, "勉強会", [{ name: "A" }], 1, {
          placedStart: { columnKey: "mon", startSlot: 1 },
          pinned: true,
        }),
      ],
      [{ key: "mon", label: "月" }],
      [1],
    );
    expect(result.fixedConflicts).toHaveLength(1);
    expect(result.placements[0]?.conflictsWith).toContain("空の先客");
    expect(result.fullyAttendedCount).toBe(0);
  });

  it("並び順は登録順に戻す", () => {
    const result = assignSeminars(
      [
        seminar(1, "大人数", [{ name: "A" }, { name: "B" }, { name: "C" }]),
        seminar(2, "少人数", [{ name: "D" }]),
      ],
      COLUMNS,
      SLOTS,
    );
    expect(result.placements.map((item) => item.groupId)).toEqual([1, 2]);
  });

  it("多くのグループでも打ち切らずに解ける（現実的な規模）", () => {
    const names = Array.from({ length: 12 }, (_, index) => `P${index}`);
    const seminars = Array.from({ length: 8 }, (_, index) =>
      seminar(
        index + 1,
        `G${index}`,
        // 3 人ずつ、ずらしながら割り当てて掛け持ちを作る
        [0, 1, 2].map((offset) => ({ name: names[(index + offset) % names.length] as string })),
      ),
    );
    const columns = ["mon", "tue", "wed", "thu", "fri"].map((key) => ({ key, label: key }));
    const result = assignSeminars(seminars, columns, [1, 2, 3, 4, 5, 6]);
    expect(result.placements).toHaveLength(8);
    expect(result.fullyAttendedCount).toBe(8);
  });
});
