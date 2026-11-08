import { describe, expect, it } from "vitest";
import { assignSeminars } from "@/lib/assignment";
import { createRandom } from "@/lib/random";
import { DEFAULT_WEEKDAYS, DEFAULT_WEEKLY_SLOTS } from "@/lib/schedule";
import { buildDemoData, DEMO_SEED, type DemoData } from "./demo-data";

/** サーバーの buildSeminarPlanning と同じ組み方（グループのメンバー＋必ず参加の主宰者）。 */
function plan(data: DemoData) {
  const owner = data.members.find((member) => member.owner);
  return assignSeminars(
    data.groups.map((group, index) => {
      const members = data.members.filter((member) => member.groups.includes(group.name));
      if (group.requiresOwner && owner && !members.includes(owner)) {
        members.push(owner);
      }
      return {
        groupId: index + 1,
        groupName: group.name,
        groupColor: "#000000",
        slotSpan: group.slotSpan,
        members: members.map((member) => ({ name: member.name, busy: new Set(member.busy) })),
        requiredNames: group.requiresOwner && owner ? [owner.name] : [],
      };
    }),
    DEFAULT_WEEKDAYS.map((key) => ({ key, label: key })),
    DEFAULT_WEEKLY_SLOTS.map((slot) => slot.slot),
  );
}

describe("見本のデータ", () => {
  const data = buildDemoData(DEMO_SEED, DEFAULT_WEEKDAYS, DEFAULT_WEEKLY_SLOTS.length, 1);

  it("同じ seed なら同じ盤面になる", () => {
    expect(buildDemoData(DEMO_SEED, DEFAULT_WEEKDAYS, 6, 1)).toEqual(data);
  });

  it("主宰者は 1 人だけで、名前は重ならない", () => {
    expect(data.members.filter((member) => member.owner)).toHaveLength(1);
    const names = data.members.map((member) => member.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("全員が出られないグループが 1〜2 件ある盤面で、探索は打ち切らない", () => {
    const result = plan(data);
    expect(result.truncated).toBe(false);
    expect(result.unplaced).toEqual([]);
    const notFull = result.totalCount - result.fullyAttendedCount;
    expect(notFull).toBeGreaterThanOrEqual(1);
    expect(notFull).toBeLessThanOrEqual(2);
  });

  it("掴んで動かせる先が光るグループがある", () => {
    const result = plan(data);
    expect(result.placeableStarts.some((entry) => entry.starts.length > 0)).toBe(true);
  });
});

describe("createRandom", () => {
  it("[0, 1) の値を、seed ごとに決まった列で返す", () => {
    const first = createRandom(1);
    const second = createRandom(1);
    const values = Array.from({ length: 100 }, () => first());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(Array.from({ length: 100 }, () => second())).toEqual(values);
  });
});
