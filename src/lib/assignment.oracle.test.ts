import { describe, expect, it } from "vitest";
import { type AssignmentOptions, assignSeminars, type SeminarInput } from "./assignment";
import { createRandom } from "./random";

/**
 * 分枝限定法を、独立に書いた厳密解（オラクル）と突き合わせる。
 *
 * オラクルは assignment.ts / candidates.ts を一切使わず、候補もここで数え直す。
 * 同じ関数を使い回すと、候補の数え方の誤りが両方に入って一致してしまう。
 *
 * 比べるのは目的関数の値（出られる人の延べ人数）。最適解は 1 つとは限らないので、
 * 置き場所そのものは比べず、解が満たすべき条件（不変条件）を別に確かめる。
 * 人が置いた枠は、DP の初期状態でそのマスを埋めておくことで同じ問題として解く。
 */

interface Instance {
  columns: string[];
  slots: number[];
  groups: {
    name: string;
    span: number;
    members: { name: string; busy: Set<string> }[];
    required: string[];
  }[];
}

interface Option {
  mask: bigint;
  value: number;
}

function indexCells(instance: Instance): Map<string, number> {
  const cellIndex = new Map<string, number>();
  for (const column of instance.columns) {
    for (const slot of instance.slots) {
      cellIndex.set(`${column}:${slot}`, cellIndex.size);
    }
  }
  return cellIndex;
}

/** グループごとの置き方（使うマスの集合と、出られる人数）を素直に数える。 */
function enumerateOptions(instance: Instance): Option[][] {
  const cellIndex = indexCells(instance);
  return instance.groups.map((group) => {
    const options: Option[] = [];
    for (const column of instance.columns) {
      for (const start of instance.slots) {
        const cells = Array.from(
          { length: group.span },
          (_, offset) => `${column}:${start + offset}`,
        );
        if (!cells.every((cell) => cellIndex.has(cell))) {
          continue;
        }
        const free = group.members.filter((member) =>
          cells.every((cell) => !member.busy.has(cell)),
        );
        const freeNames = new Set(free.map((member) => member.name));
        if (free.length === 0 || !group.required.every((name) => freeNames.has(name))) {
          continue;
        }
        const mask = cells.reduce(
          (bits, cell) => bits | (1n << BigInt(cellIndex.get(cell) ?? 0)),
          0n,
        );
        options.push({ mask, value: free.length });
      }
    }
    return options;
  });
}

/** 使ったマスの集合を状態にした動的計画法。グループは置かなくてもよい。 */
function solveByDp(options: Option[][], initiallyUsed = 0n): number {
  const memo = new Map<string, number>();
  const best = (index: number, used: bigint): number => {
    if (index === options.length) {
      return 0;
    }
    const key = `${index}:${used}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let value = best(index + 1, used);
    for (const option of options[index] ?? []) {
      if ((option.mask & used) === 0n) {
        value = Math.max(value, option.value + best(index + 1, used | option.mask));
      }
    }
    memo.set(key, value);
    return value;
  };
  return best(0, initiallyUsed);
}

/**
 * ハンガリー法（最小費用の割当、行 n ≤ 列 m）。全グループが 1 コマのときの厳密解に使う。
 * 置けない組み合わせは重み 0 にする。重みが非負なら、置かないグループを空いている列へ
 * 回しても総和は変わらないので、部分的な割当の最大値と一致する。
 */
function solveByHungarian(weights: number[][]): number {
  const n = weights.length;
  const m = weights[0]?.length ?? 0;
  const cost = (i: number, j: number) => -(weights[i - 1]?.[j - 1] ?? 0);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0] as number;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const current = cost(i0, j) - (u[i0] as number) - (v[j] as number);
        if (current < (minv[j] as number)) {
          minv[j] = current;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= m; j += 1) {
    const i = p[j] as number;
    if (i > 0) total += weights[i - 1]?.[j - 1] ?? 0;
  }
  return total;
}

function randomInstance(
  seed: number,
  shape: { columns: number; slots: number; groups: number; maxSpan: number; people: number },
): Instance {
  const random = createRandom(seed);
  const pick = (count: number) => Math.floor(random() * count);
  const columns = ["mon", "tue", "wed", "thu", "fri"].slice(0, shape.columns);
  const slots = Array.from({ length: shape.slots }, (_, index) => index + 1);
  const people = Array.from({ length: shape.people }, (_, index) => {
    const density = 0.1 + random() * 0.5;
    const busy = new Set<string>();
    for (const column of columns) {
      for (const slot of slots) {
        if (random() < density) busy.add(`${column}:${slot}`);
      }
    }
    return { name: `P${index}`, busy };
  });
  const groups = Array.from({ length: shape.groups }, (_, index) => {
    const members = people.filter(() => random() < 0.45);
    if (members.length === 0) {
      members.push(people[pick(people.length)] as (typeof people)[number]);
    }
    const required =
      random() < 0.4 ? [(members[pick(members.length)] as { name: string }).name] : [];
    return { name: `G${index}`, span: 1 + pick(shape.maxSpan), members, required };
  });
  return { columns, slots, groups };
}

/** 人が置いた枠。グループの番号（0 始まり）から開始コマへ。 */
type Placed = Map<number, { columnKey: string; startSlot: number }>;

function toInputs(instance: Instance, placed: Placed = new Map()): SeminarInput[] {
  return instance.groups.map((group, index) => ({
    groupId: index + 1,
    groupName: group.name,
    groupColor: "#000000",
    slotSpan: group.span,
    members: group.members,
    requiredNames: group.required,
    placedStart: placed.get(index) ?? null,
  }));
}

const UNLIMITED = {
  nodeBudget: Number.POSITIVE_INFINITY,
  maxPlacements: Number.POSITIVE_INFINITY,
};

function solve(instance: Instance, options: AssignmentOptions = UNLIMITED, placed?: Placed) {
  return assignSeminars(
    toInputs(instance, placed),
    instance.columns.map((key) => ({ key, label: key })),
    instance.slots,
    options,
  );
}

/** 解が満たすべき条件。目的関数の一致とは別に、解そのものが実行できる案かを見る。 */
function expectFeasible(
  instance: Instance,
  result: ReturnType<typeof solve>,
  placed: Placed = new Map(),
): void {
  const placements = result.placements;
  for (const [index, a] of placements.entries()) {
    for (const b of placements.slice(index + 1)) {
      const overlap =
        a.columnKey === b.columnKey && a.startSlot <= b.endSlot && b.startSlot <= a.endSlot;
      expect(overlap, `${a.groupName} と ${b.groupName} が同じコマにある`).toBe(false);
    }
    const group = instance.groups[a.groupId - 1];
    if (!group) throw new Error("知らないグループが置かれた");
    expect(a.endSlot - a.startSlot + 1).toBe(group.span);
    const cells = Array.from({ length: group.span }, (_, k) => `${a.columnKey}:${a.startSlot + k}`);
    const free = group.members
      .filter((member) => cells.every((cell) => !member.busy.has(cell)))
      .map((member) => member.name);
    expect([...a.freeNames].sort()).toEqual([...free].sort());
    const start = placed.get(a.groupId - 1);
    if (start) {
      // 人が置いた枠は必須メンバーの都合でも動かさない。
      expect({ columnKey: a.columnKey, startSlot: a.startSlot }).toEqual(start);
      expect(a.moved).toBe(true);
      continue;
    }
    for (const name of group.required) {
      expect(a.freeNames).toContain(name);
    }
    expect(a.fixed || a.moved).toBe(false);
    expect(a.conflictsWith).toEqual([]);
  }
  expect(result.placements.length + result.unplaced.length).toBe(instance.groups.length);
  expect(result.totalAttendance).toBe(
    placements.reduce((total, placement) => total + placement.freeNames.length, 0),
  );
}

describe("厳密解との突き合わせ", () => {
  it("小さな盤面 200 件で、上限を外した探索は DP の最適値と一致する", () => {
    let truncated = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const instance = randomInstance(seed, {
        columns: 2 + (seed % 2),
        slots: 4 + (seed % 3),
        groups: 1 + (seed % 5),
        maxSpan: 3,
        people: 6,
      });
      const result = solve(instance);
      if (result.truncated) truncated += 1;
      expect(result.totalAttendance, `seed ${seed}`).toBe(solveByDp(enumerateOptions(instance)));
      expectFeasible(instance, result);
    }
    expect(truncated).toBe(0);
  });

  it("同じ 200 件は既定の上限（ノード数・候補数）でも打ち切らず、最適値と一致する", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const instance = randomInstance(seed, {
        columns: 2 + (seed % 2),
        slots: 4 + (seed % 3),
        groups: 1 + (seed % 5),
        maxSpan: 3,
        people: 6,
      });
      const result = solve(instance, {});
      expect(result.truncated, `seed ${seed}`).toBe(false);
      expect(result.totalAttendance, `seed ${seed}`).toBe(solveByDp(enumerateOptions(instance)));
    }
  });

  it("週の盤面（5 列 × 6 コマ）で全グループ 1 コマなら、ハンガリー法の最適値と一致する", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const instance = randomInstance(1000 + seed, {
        columns: 5,
        slots: 6,
        groups: 4 + (seed % 5),
        maxSpan: 1,
        people: 12,
      });
      const cells = instance.columns.flatMap((column) =>
        instance.slots.map((slot) => `${column}:${slot}`),
      );
      const weights = instance.groups.map((group) =>
        cells.map((cell) => {
          const free = group.members.filter((member) => !member.busy.has(cell));
          const freeNames = new Set(free.map((member) => member.name));
          return group.required.every((name) => freeNames.has(name)) ? free.length : 0;
        }),
      );
      const optimum = solveByHungarian(weights);
      const result = solve(instance);
      expect(result.truncated).toBe(false);
      expect(result.totalAttendance, `seed ${1000 + seed}`).toBe(optimum);
      expectFeasible(instance, result);

      // 既定の上限（候補 24 件）は 30 マスの盤面で実際に効く。最適値に届かないのは
      // 打ち切ったときだけで、絞り込みのせいで届かないことはない。
      const limited = solve(instance, {});
      expect(limited.totalAttendance).toBeLessThanOrEqual(optimum);
      if (limited.totalAttendance < optimum) {
        expect(limited.truncated, `seed ${1000 + seed}`).toBe(true);
      }
      expectFeasible(instance, limited);
    }
  });

  it("人が置いた枠がある盤面 200 件で、DP の最適値と一致する（上限なし・既定の上限とも）", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const instance = randomInstance(5000 + seed, {
        columns: 2 + (seed % 2),
        slots: 4 + (seed % 3),
        groups: 2 + (seed % 4),
        maxSpan: 3,
        people: 6,
      });
      // 1 グループを、空き具合に関係なく決まった場所へ置く（人の指定は空き人数で捨てない）。
      const random = createRandom(seed);
      const index = Math.floor(random() * instance.groups.length);
      const group = instance.groups[index];
      if (!group) throw new Error("グループが無い");
      const columnKey = instance.columns[Math.floor(random() * instance.columns.length)] as string;
      const startSlot = 1 + Math.floor(random() * (instance.slots.length - group.span + 1));
      const placed: Placed = new Map([[index, { columnKey, startSlot }]]);

      const cellIndex = indexCells(instance);
      const cells = Array.from({ length: group.span }, (_, k) => `${columnKey}:${startSlot + k}`);
      const mask = cells.reduce(
        (bits, cell) => bits | (1n << BigInt(cellIndex.get(cell) ?? 0)),
        0n,
      );
      const placedValue = group.members.filter((member) =>
        cells.every((cell) => !member.busy.has(cell)),
      ).length;
      const options = enumerateOptions(instance).map((list, i) => (i === index ? [] : list));
      const optimum = placedValue + solveByDp(options, mask);

      for (const limits of [UNLIMITED, {}]) {
        const result = solve(instance, limits, placed);
        expect(result.truncated, `seed ${5000 + seed}`).toBe(false);
        expect(result.totalAttendance, `seed ${5000 + seed}`).toBe(optimum);
        expectFeasible(instance, result, placed);
      }
    }
  });

  it("オラクル自体が手で解ける問題で正しい", () => {
    // 2 グループが 1 マスを取り合う。片方しか置けないので、多いほう（2 人）が最適。
    const instance: Instance = {
      columns: ["mon"],
      slots: [1],
      groups: [
        { name: "A", span: 1, members: [{ name: "x", busy: new Set() }], required: [] },
        {
          name: "B",
          span: 1,
          members: [
            { name: "y", busy: new Set() },
            { name: "z", busy: new Set() },
          ],
          required: [],
        },
      ],
    };
    expect(solveByDp(enumerateOptions(instance))).toBe(2);
    expect(
      solveByHungarian([
        [1, 0],
        [2, 0],
      ]),
    ).toBe(2);
    expect(
      solveByHungarian([
        [3, 1],
        [3, 0],
      ]),
    ).toBe(4);
  });
});

describe("候補の絞り込み（上位 maxPlacements 件）", () => {
  it("絞り込みで漏れた枠も、置けなかったグループの最後の当たり直しで使う", () => {
    // A の上位 1 件（1 コマ目）は B に取られる。漏れた 2 コマ目に当たり直せば両方置ける。
    const instance: Instance = {
      columns: ["mon"],
      slots: [1, 2],
      groups: [
        {
          name: "A",
          span: 1,
          members: [
            { name: "a1", busy: new Set() },
            { name: "a2", busy: new Set(["mon:2"]) },
          ],
          required: [],
        },
        {
          name: "B",
          span: 1,
          members: ["b1", "b2", "b3"].map((name) => ({ name, busy: new Set(["mon:2"]) })),
          required: [],
        },
      ],
    };
    const result = solve(instance, { nodeBudget: Number.POSITIVE_INFINITY, maxPlacements: 1 });
    expect(result.unplaced).toEqual([]);
    expect(result.totalAttendance).toBe(solveByDp(enumerateOptions(instance)));
    expectFeasible(instance, result);
  });

  it("人が置いた枠とぶつかる窓は、上位を選ぶ前に除く", () => {
    // A を mon:1 に置く。B と C の上位 2 件にはどちらも mon:1 が入るので、先に絞ると
    // 実際に使える候補が 1 件ずつに減り、2 グループが mon:2 を取り合って C が置けない。
    const instance: Instance = {
      columns: ["mon"],
      slots: [1, 2, 3],
      groups: [
        { name: "A", span: 1, members: [{ name: "a1", busy: new Set() }], required: [] },
        {
          name: "B",
          span: 1,
          members: ["b1", "b2", "b3"].map((name) => ({ name, busy: new Set<string>() })),
          required: [],
        },
        {
          name: "C",
          span: 1,
          members: ["c1", "c2"].map((name) => ({ name, busy: new Set(["mon:3"]) })),
          required: [],
        },
      ],
    };
    const placed: Placed = new Map([[0, { columnKey: "mon", startSlot: 1 }]]);
    const result = solve(
      instance,
      { nodeBudget: Number.POSITIVE_INFINITY, maxPlacements: 2 },
      placed,
    );
    expect(result.unplaced).toEqual([]);
    expect(result.totalAttendance).toBe(6);
    expectFeasible(instance, result, placed);
  });

  it("候補を 2 件に絞っても、置けなかったグループには空いている枠が 1 つも残らない", () => {
    let narrowed = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const instance = randomInstance(seed, {
        columns: 2 + (seed % 2),
        slots: 4 + (seed % 3),
        groups: 1 + (seed % 5),
        maxSpan: 3,
        people: 6,
      });
      const options = enumerateOptions(instance);
      if (options.some((group) => group.length > 2)) narrowed += 1;
      const result = solve(instance, { nodeBudget: Number.POSITIVE_INFINITY, maxPlacements: 2 });
      expectFeasible(instance, result);
      expect(result.totalAttendance).toBeLessThanOrEqual(solveByDp(options));
      for (const { groupId } of result.unplaced) {
        const group = instance.groups[groupId - 1];
        if (!group) throw new Error("知らないグループ");
        for (const column of instance.columns) {
          for (const start of instance.slots) {
            const end = start + group.span - 1;
            if (end > Math.max(...instance.slots)) continue;
            const cells = Array.from({ length: group.span }, (_, k) => `${column}:${start + k}`);
            const freeNames = new Set(
              group.members
                .filter((member) => cells.every((cell) => !member.busy.has(cell)))
                .map((member) => member.name),
            );
            if (freeNames.size === 0 || !group.required.every((name) => freeNames.has(name))) {
              continue;
            }
            const blocked = result.placements.some(
              (placement) =>
                placement.columnKey === column &&
                placement.startSlot <= end &&
                start <= placement.endSlot,
            );
            expect(blocked, `seed ${seed}: ${group.name} を ${column}:${start} に置ける`).toBe(
              true,
            );
          }
        }
      }
    }
    // 絞り込みが実際に効いた盤面が十分にあること（効かなければ検査の意味がない）。
    expect(narrowed).toBeGreaterThan(100);
  });
});
