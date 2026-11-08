# Group session assignment: formulation and solver

This note describes the problem solved by [`src/lib/assignment.ts`](../src/lib/assignment.ts),
the branch-and-bound search used to solve it, and how the search is checked.

## Problem

An event has a grid of **columns** (weekdays, or dates) and **slots** (periods, or hours).
Every participant marks the cells in which they are busy. There are several **groups**
(seminars, study groups, recurring meetings, ...). A participant may belong to several groups.

Each group needs one session per week (or per period) that occupies `span` consecutive slots
in one column. The rules are:

1. **One group per cell.** Two sessions never share a cell, even when their members do not
   overlap. In practice the room and the person running the sessions are shared, so two
   sessions at the same time cannot both happen. Overlapping membership therefore only
   affects how many people can attend, not feasibility.
2. **Required attendees.** A group may name a role (for example the owner) whose members
   must be free. Windows where a required person is busy are not candidates at all; this is
   a hard constraint, not a penalty.
3. **Human decisions win.** A group that a person has placed by hand (pinned, or dragged to a
   cell) is never moved. Its cells are removed from everyone else's options, and conflicts
   between two hand-placed groups are reported instead of being silently resolved.

The objective is the total number of attendees over all placed groups (person-sessions).

## Formulation

For group $g$ with span $\ell_g$, members $M_g$ and required members $R_g \subseteq M_g$:

- a **window** $p$ is a column $d$ and a start slot $s$ such that slots $s, \dots, s+\ell_g-1$
  exist and are consecutive; $C(p)$ is its set of cells;
- $F_g(p) = \{ m \in M_g : m \text{ is free in every cell of } C(p) \}$ are the members who can attend;
- the feasible windows are $P_g = \{ p : R_g \subseteq F_g(p),\ |F_g(p)| \ge 1 \}$,
  minus windows that overlap a hand-placed group;
- the weight of a window is $w_{g,p} = |F_g(p)|$.

With a binary variable $x_{g,p}$ for "group $g$ is held in window $p$":

$$
\begin{aligned}
\max\quad & \sum_{g} \sum_{p \in P_g} w_{g,p}\, x_{g,p} \\
\text{s.t.}\quad & \sum_{p \in P_g} x_{g,p} \le 1 && \text{for every group } g \\
& \sum_{g} \sum_{p \in P_g :\, k \in C(p)} x_{g,p} \le 1 && \text{for every cell } k \\
& x_{g,p} \in \{0, 1\}.
\end{aligned}
$$

A group may stay unplaced (all its $x$ are 0); the app reports why.

### Complexity

- If every group has span 1, each window is a single cell and the problem is a maximum-weight
  bipartite matching between groups and cells, solvable in polynomial time (for example with
  the Hungarian method). The tests use exactly this as an oracle.
- With longer spans, each group chooses at most one interval from its own set of intervals,
  and chosen intervals in the same column must not overlap. This is a weighted form of the
  job interval selection problem, which is NP-hard in general (Spieksma, 1999). I have not
  proven that hardness survives the restrictions specific to this app (one span per group,
  windows taken from a grid), so the solver simply does not assume a polynomial algorithm.

Instances in practice are small (a 5 x 6 weekly grid, around ten groups). A branch-and-bound
search with explicit limits runs synchronously inside the Durable Object, without shipping an
LP/MIP solver (WebAssembly) in the request path.

## Solver

Depth-first branch and bound, no external solver:

1. **Candidates.** For each group, enumerate windows, drop infeasible ones, and sort by weight
   (descending), then by column and slot (earliest first). Keep the top 24 per group
   (`MAX_PLACEMENTS_PER_SEMINAR`).
2. **Order.** Groups with the fewest candidates are branched on first (a fail-first rule);
   ties go to the larger group.
3. **Initial incumbent.** A greedy pass places each group in its best non-conflicting window.
4. **Bound.** At depth $i$, the upper bound is the current score plus the best weight of every
   remaining group, ignoring conflicts. A branch is pruned when this bound cannot beat the
   incumbent.
5. **Branching.** Try each non-conflicting window in weight order, then the branch where the
   group is left unplaced (so that giving up one group to place all the others is found).
6. **Limits.** The search stops after 200,000 nodes (`NODE_BUDGET`) and returns the best
   solution found so far, with `truncated: true` so the UI can say the result may not be
   optimal. Groups left unplaced get one last linear pass over the candidates that were cut
   by the top-24 limit.

The bound is weak (it ignores conflicts entirely), so hard instances can hit the node limit;
see the benchmark below.

## Verification

[`src/lib/assignment.oracle.test.ts`](../src/lib/assignment.oracle.test.ts) compares the
solver with exact solutions computed by code that does not share anything with the app
(candidates are re-enumerated in the test):

| check | instances | result |
|---|---|---|
| Bitmask DP over occupied cells, solver run without limits | 200 random boards: 2–3 columns, 4–6 slots, 1–5 groups, spans 1–3 | objective equal on all 200, no truncation |
| Same 200 boards with the default limits | as above | objective equal on all 200, no truncation |
| Hungarian method, all spans 1 | 50 random 5 x 6 weekly boards, 4–8 groups | objective equal on all 50 |
| Feasibility of every returned solution | all of the above | no shared cells, correct spans, required members free, attendee lists recomputed |

The solutions themselves are not compared, because optima are often not unique.
The oracle tests fail if the "leave unplaced" branch is removed, if the pruning rule is made
too aggressive, or if the overlap check only compares start slots (each was tried by
temporarily changing the solver).

## Benchmark against an exact MIP

`pnpm bench` ([`bench/`](../bench)) generates seeded random instances, solves them with the
default solver (limits on), with its greedy start alone, and with
[HiGHS](https://highs.dev/) (via the `highs` npm package, no limits) on the MIP above.
The full table, with the machine and commit it was produced on, is in
[benchmark.md](benchmark.md). Summary:

- On weekly 5 x 6 grids with 6 or 10 groups, the default solver matched the MIP optimum in
  100% and 99% of instances.
- With 14 groups on the same grid (tight: many two-slot groups competing for 30 cells), it
  matched in 91% of instances, hit the node limit in 15%, and was at most 5 attendees
  (6.8%) below the optimum.
- Every instance with a non-zero gap had hit the node limit; the top-24 candidate cut never
  caused a gap in these runs.
- The greedy start alone matched the optimum in only 12–74% of the weekly instances, so the
  search does real work there.

## Known limitations

- **Objective.** Maximizing total attendance can prefer one large, partially attended group
  over two small, fully attended ones. A lexicographic objective (first the number of fully
  attended groups, then attendance) would match how people judge a timetable more closely.
- **Bound.** The bound ignores conflicts, so tight instances exhaust the node budget. A
  matching-based bound (exact when all spans are 1) would prune much more.
- **CPU budget.** The result is cached until data changes, so polling does not re-run the
  search, but one recomputation on a tight instance can take tens of milliseconds on a laptop.
