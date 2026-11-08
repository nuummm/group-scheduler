# Benchmark: branch and bound vs. exact MIP

Produced by `pnpm bench` ([`bench/run.ts`](../bench/run.ts)). Instances are generated from
seeds ([`bench/instances.ts`](../bench/instances.ts)); no real data is used.

**Instances.** 30 people plus one owner. Each person gets a random busy rate between 15% and
50% and is busy in each cell with that probability. Each group has 3–10 random members, needs
the owner with probability 1/2, and needs two consecutive slots with probability 0.3.
"weekly" is a 5-day x 6-slot grid; "range" is N days x 10 slots (like the date-range mode
restricted to daytime hours).

**Columns.**
- *zero gap*: share of instances where the solver with default limits reached the MIP optimum.
- *gap*: MIP optimum minus the solver's total attendance (people).
- *greedy zero gap*: the same, for the greedy start alone (node budget 0).
- *truncated*: share of instances where the node budget (200,000) was hit.
- *gap > 0, not truncated*: instances where the top-24 candidate cut, not the node budget,
  lost optimality.
- Times are wall-clock in Node on the machine below, not on Cloudflare Workers.
  HiGHS time includes parsing the LP text.

- date: 2026-11-08 / node v26.10.0 / Apple M5 / commit 311dd90
- B&B: default limits (node budget 200,000, 24 candidates per group). Greedy: the same code with node budget 0.
- Exact: HiGHS (MIP, no limits) on the same candidate windows, enumerated independently of the app code.

| instances | n | zero gap | mean gap (people) | max gap | max rel. gap | greedy zero gap | truncated | gap > 0, not truncated | nodes p50 / p95 / max | B&B ms p50 / p95 / max | HiGHS ms p50 / max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| weekly 5x6, 6 groups | 100 | 100% | 0.00 | 0 | 0.0% | 74% | 0% | 0 | 1 / 431 / 14941 | 0.3 / 0.9 / 2.5 | 3.6 / 42.1 |
| weekly 5x6, 10 groups | 100 | 99% | 0.02 | 2 | 2.9% | 43% | 1% | 0 | 397 / 54609 / 200001 | 0.6 / 6.6 / 18.2 | 5.1 / 29.3 |
| weekly 5x6, 14 groups | 100 | 91% | 0.21 | 5 | 6.8% | 12% | 15% | 0 | 12388 / 200001 / 200001 | 2.6 / 30.7 / 44.1 | 6.3 / 31.0 |
| range 20x10, 12 groups | 30 | 93% | 0.10 | 2 | 2.6% | 87% | 10% | 0 | 1 / 200001 / 200001 | 5.5 / 20.6 / 21.5 | 31.8 / 63.7 |
| range 40x10, 12 groups | 30 | 100% | 0.00 | 0 | 0.0% | 93% | 0% | 0 | 1 / 29912 / 140019 | 12.2 / 19.7 / 20.6 | 70.0 / 112.1 |
| range 61x10, 16 groups | 30 | 100% | 0.00 | 0 | 0.0% | 97% | 0% | 0 | 1 / 1 / 3665 | 23.8 / 39.1 / 40.8 | 169.6 / 344.4 |
