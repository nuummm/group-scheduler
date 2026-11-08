import { describe, expect, it } from "vitest";
import { DEFAULT_WEEKLY_SLOTS, toMinutes } from "@/lib/schedule";
import { nextExtraSlot } from "./ExtraSlotEditor";

/** 押しただけで保存できなくなる初期値を作らない。 */
describe("nextExtraSlot", () => {
  it("何回足しても、終わりは始まりより後になる", () => {
    const slots: ReturnType<typeof nextExtraSlot>[] = [];
    for (let count = 0; count < 6; count += 1) {
      const slot = nextExtraSlot(slots, DEFAULT_WEEKLY_SLOTS);
      expect(toMinutes(slot.start)).toBeLessThan(toMinutes(slot.end));
      slots.push(slot);
    }
  });

  it("日をまたがない", () => {
    const slots = [{ label: "7限", start: "23:00", end: "23:50" }];
    const slot = nextExtraSlot(slots, DEFAULT_WEEKLY_SLOTS);
    expect(slot.end <= "23:59").toBe(true);
    expect(toMinutes(slot.start)).toBeLessThan(toMinutes(slot.end));
  });
});

describe("nextExtraSlot の見出しと始まり", () => {
  it("基本のコマの続き番号で、最後のコマの終わりより後から始まる", () => {
    const base = DEFAULT_WEEKLY_SLOTS.slice(0, 4);
    const slot = nextExtraSlot([], base);
    expect(slot.label).toBe("5限");
    expect(toMinutes(slot.start)).toBeGreaterThan(toMinutes(base.at(-1)?.end ?? ""));
  });
});
