import type { Instance } from "./instances";

/**
 * 同じ問題を 0-1 整数計画として書き、HiGHS で上限なしに解く（厳密解の基準）。
 *
 *   max  Σ_{g,p} w_{g,p} x_{g,p}
 *   s.t. Σ_p x_{g,p} ≤ 1                 （グループ g は高々 1 か所）
 *        Σ_{(g,p) ∋ k} x_{g,p} ≤ 1         （マス k には高々 1 グループ）
 *        x_{g,p} ∈ {0, 1}
 *
 * p は「必ず参加」の人が出られて、出られる人が 1 人以上いる連続窓。w はそこで出られる人数。
 * 候補はアプリの実装（candidates.ts）を使わずにここで数え直す。
 */

interface Placement {
  name: string;
  weight: number;
  cells: string[];
}

export function enumeratePlacements(instance: Instance): Placement[][] {
  return instance.seminars.map((seminar, groupIndex) => {
    const required = new Set(seminar.requiredNames ?? []);
    const placements: Placement[] = [];
    for (const column of instance.columns) {
      for (let start = 0; start + seminar.slotSpan <= instance.slotNumbers.length; start += 1) {
        const cells = instance.slotNumbers
          .slice(start, start + seminar.slotSpan)
          .map((slot) => `${column.key}:${slot}`);
        const free = seminar.members.filter((member) =>
          cells.every((cell) => !member.busy.has(cell)),
        );
        const freeNames = new Set(free.map((member) => member.name));
        if (free.length === 0 || [...required].some((name) => !freeNames.has(name))) {
          continue;
        }
        placements.push({
          name: `x_${groupIndex}_${column.key}_${start}`,
          weight: free.length,
          cells,
        });
      }
    }
    return placements;
  });
}

/** CPLEX LP 形式の文字列を組む。 */
export function toLp(instance: Instance): string {
  const placements = enumeratePlacements(instance);
  const all = placements.flat();
  if (all.length === 0) {
    return "";
  }
  const lines = ["Maximize", ` obj: ${all.map((p) => `${p.weight} ${p.name}`).join(" + ")}`];
  lines.push("Subject To");
  placements.forEach((group, index) => {
    if (group.length > 1) {
      lines.push(` g${index}: ${group.map((p) => p.name).join(" + ")} <= 1`);
    }
  });
  const byCell = new Map<string, string[]>();
  for (const placement of all) {
    for (const cell of placement.cells) {
      byCell.set(cell, [...(byCell.get(cell) ?? []), placement.name]);
    }
  }
  let row = 0;
  for (const names of byCell.values()) {
    if (names.length > 1) {
      lines.push(` k${row}: ${names.join(" + ")} <= 1`);
      row += 1;
    }
  }
  lines.push("Binary", ` ${all.map((p) => p.name).join(" ")}`, "End");
  return lines.join("\n");
}
