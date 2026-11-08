import type { SeminarInput } from "../src/lib/assignment";
import { createRandom, shuffle } from "../src/lib/random";

/**
 * bench 用の問題。seed から決まる架空の予定表で、実データは使わない。
 *
 * 人ごとに「忙しさ」を引き、各コマをその確率で埋める。グループは人をランダムに集め、
 * 半分ほどに「必ず参加」の主宰者を付ける（主宰者も同じ予定表を持つ 1 人）。
 */

export interface Shape {
  name: string;
  columns: number;
  slots: number;
  groups: number;
  people: number;
  /** 2 コマ続きのグループの割合。 */
  twoSlotShare: number;
  seeds: number;
}

export interface Instance {
  seed: number;
  columns: { key: string; label: string }[];
  slotNumbers: number[];
  seminars: SeminarInput[];
}

export function buildInstance(shape: Shape, seed: number): Instance {
  const random = createRandom(seed * 7919 + shape.columns * 31 + shape.groups);
  const columns = Array.from({ length: shape.columns }, (_, index) => ({
    key: `c${index + 1}`,
    label: `c${index + 1}`,
  }));
  const slotNumbers = Array.from({ length: shape.slots }, (_, index) => index + 1);
  const people = Array.from({ length: shape.people + 1 }, (_, index) => {
    const density = 0.15 + random() * 0.35;
    const busy = new Set<string>();
    for (const column of columns) {
      for (const slot of slotNumbers) {
        if (random() < density) busy.add(`${column.key}:${slot}`);
      }
    }
    return { name: index === 0 ? "owner" : `p${index}`, busy };
  });
  const owner = people[0] as (typeof people)[number];
  const members = people.slice(1);
  const seminars = Array.from({ length: shape.groups }, (_, index): SeminarInput => {
    const size = 3 + Math.floor(random() * 8);
    const chosen = shuffle(members, random).slice(0, size);
    const requiresOwner = random() < 0.5;
    return {
      groupId: index + 1,
      groupName: `g${index + 1}`,
      groupColor: "#000000",
      slotSpan: random() < shape.twoSlotShare ? 2 : 1,
      members: requiresOwner ? [...chosen, owner] : chosen,
      requiredNames: requiresOwner ? [owner.name] : [],
    };
  });
  return { seed, columns, slotNumbers, seminars };
}

export const SHAPES: Shape[] = [
  {
    name: "weekly 5x6, 6 groups",
    columns: 5,
    slots: 6,
    groups: 6,
    people: 30,
    twoSlotShare: 0.3,
    seeds: 100,
  },
  {
    name: "weekly 5x6, 10 groups",
    columns: 5,
    slots: 6,
    groups: 10,
    people: 30,
    twoSlotShare: 0.3,
    seeds: 100,
  },
  {
    name: "weekly 5x6, 14 groups",
    columns: 5,
    slots: 6,
    groups: 14,
    people: 30,
    twoSlotShare: 0.3,
    seeds: 100,
  },
  {
    name: "range 20x10, 12 groups",
    columns: 20,
    slots: 10,
    groups: 12,
    people: 30,
    twoSlotShare: 0.3,
    seeds: 30,
  },
  {
    name: "range 40x10, 12 groups",
    columns: 40,
    slots: 10,
    groups: 12,
    people: 30,
    twoSlotShare: 0.3,
    seeds: 30,
  },
  {
    name: "range 61x10, 16 groups",
    columns: 61,
    slots: 10,
    groups: 16,
    people: 30,
    twoSlotShare: 0.3,
    seeds: 30,
  },
];
