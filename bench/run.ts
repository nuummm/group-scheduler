import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import highsLoader from "highs";
import { assignSeminars } from "../src/lib/assignment";
import { buildInstance, SHAPES } from "./instances";
import { toLp } from "./mip";

/**
 * 分枝限定法（既定の上限つき）と、HiGHS による厳密解を同じ問題で比べる。
 * `pnpm bench` で回し、Markdown の表を標準出力と bench/results/latest.md に書く。CI では回さない。
 */

interface Row {
  gap: number;
  relativeGap: number;
  greedyGap: number;
  truncated: boolean;
  nodes: number;
  bnbMs: number;
  mipMs: number;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function format(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

const highs = await highsLoader();
const lines: string[] = [];
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

lines.push(
  `- date: ${new Date().toISOString().slice(0, 10)} / node ${process.version} / ${cpus()[0]?.model ?? "unknown CPU"} / commit ${commit}`,
  "- B&B: default limits (node budget 200,000, 24 candidates per group). Greedy: the same code with node budget 0.",
  "- Exact: HiGHS (MIP, no limits) on the same candidate windows, enumerated independently of the app code.",
  "",
  "| instances | n | zero gap | mean gap (people) | max gap | max rel. gap | greedy zero gap | truncated | gap > 0, not truncated | nodes p50 / p95 / max | B&B ms p50 / p95 / max | HiGHS ms p50 / max |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
);

for (const shape of SHAPES) {
  const rows: Row[] = [];
  for (let seed = 0; seed < shape.seeds; seed += 1) {
    const instance = buildInstance(shape, seed);
    const args = [instance.seminars, instance.columns, instance.slotNumbers] as const;

    const started = performance.now();
    const result = assignSeminars(...args);
    const bnbMs = performance.now() - started;
    const greedy = assignSeminars(...args, { nodeBudget: 0 });

    const lp = toLp(instance);
    const mipStarted = performance.now();
    const solution = lp ? highs.solve(lp, { output_flag: false }) : null;
    const mipMs = performance.now() - mipStarted;
    if (solution && solution.Status !== "Optimal") {
      throw new Error(`${shape.name} seed ${seed}: HiGHS status ${solution.Status}`);
    }
    const optimum = solution ? Math.round(solution.ObjectiveValue) : 0;
    if (result.totalAttendance > optimum) {
      throw new Error(`${shape.name} seed ${seed}: B&B exceeded the optimum (bug)`);
    }
    rows.push({
      gap: optimum - result.totalAttendance,
      relativeGap: optimum === 0 ? 0 : (optimum - result.totalAttendance) / optimum,
      greedyGap: optimum - greedy.totalAttendance,
      truncated: result.truncated,
      nodes: result.nodes,
      bnbMs,
      mipMs,
    });
  }
  const gaps = rows.map((row) => row.gap);
  const share = (count: number) => `${format((100 * count) / rows.length, 0)}%`;
  lines.push(
    [
      shape.name,
      rows.length,
      share(rows.filter((row) => row.gap === 0).length),
      format(gaps.reduce((a, b) => a + b, 0) / rows.length, 2),
      Math.max(...gaps),
      `${format(100 * Math.max(...rows.map((row) => row.relativeGap)), 1)}%`,
      share(rows.filter((row) => row.greedyGap === 0).length),
      share(rows.filter((row) => row.truncated).length),
      // 打ち切っていないのに差があるなら、原因は候補を上位 24 件に絞ったこと。
      rows.filter((row) => row.gap > 0 && !row.truncated).length,
      [0.5, 0.95, 1]
        .map((q) =>
          quantile(
            rows.map((row) => row.nodes),
            q,
          ),
        )
        .join(" / "),
      [0.5, 0.95, 1]
        .map((q) =>
          format(
            quantile(
              rows.map((row) => row.bnbMs),
              q,
            ),
            1,
          ),
        )
        .join(" / "),
      [0.5, 1]
        .map((q) =>
          format(
            quantile(
              rows.map((row) => row.mipMs),
              q,
            ),
            1,
          ),
        )
        .join(" / "),
    ]
      .join(" | ")
      .replace(/^/, "| ")
      .concat(" |"),
  );
}

const table = lines.join("\n");
console.log(table);
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/latest.md", import.meta.url), `${table}\n`);
