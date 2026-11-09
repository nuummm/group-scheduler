# Benchmark: branch and bound vs. exact MIP

Produced by `pnpm bench` ([`bench/run.ts`](../bench/run.ts)). Instances are generated from
seeds ([`bench/instances.ts`](../bench/instances.ts)); no real data is used.

**Instances.** 30 people plus one owner. Each person gets a random busy rate between 15% and
50% and is busy in each cell with that probability. Each group has 3–10 random members (drawn
without replacement) and, with probability 1/2, also the owner as a required member, and needs two consecutive slots with probability 0.3.
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

- date: 2026-11-09 / node v26.10.0 / Apple M5 / commit 0233781
- B&B: default limits (node budget 200,000, 24 candidates per group). Greedy: the same code with node budget 0.
- Exact: HiGHS (MIP, no limits) on the same candidate windows, enumerated independently of the app code.

| instances | n | zero gap | mean gap (people) | max gap | max rel. gap | greedy zero gap | truncated | gap > 0, not truncated | nodes p50 / p95 / max | B&B ms p50 / p95 / max | HiGHS ms p50 / max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| weekly 5x6, 6 groups | 100 | 100% | 0.00 | 0 | 0.0% | 76% | 0% | 0 | 1 / 622 / 5487 | 0.2 / 0.4 / 1.1 | 2.1 / 34.0 |
| weekly 5x6, 10 groups | 100 | 99% | 0.01 | 1 | 1.5% | 53% | 3% | 0 | 410 / 119050 / 200001 | 0.3 / 4.8 / 12.0 | 2.4 / 8.6 |
| weekly 5x6, 14 groups | 100 | 91% | 0.11 | 2 | 2.5% | 22% | 17% | 0 | 7759 / 200001 / 200001 | 0.9 / 14.1 / 20.6 | 3.0 / 15.2 |
| range 20x10, 12 groups | 30 | 100% | 0.00 | 0 | 0.0% | 93% | 0% | 0 | 1 / 2862 / 3705 | 2.6 / 3.1 / 3.3 | 15.7 / 40.1 |
| range 40x10, 12 groups | 30 | 100% | 0.00 | 0 | 0.0% | 97% | 0% | 0 | 1 / 1 / 2066 | 5.5 / 6.3 / 7.0 | 35.8 / 59.3 |
| range 61x10, 16 groups | 30 | 100% | 0.00 | 0 | 0.0% | 97% | 0% | 0 | 1 / 1 / 385 | 11.5 / 13.4 / 15.2 | 79.6 / 207.8 |
