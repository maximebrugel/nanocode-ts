# Board load results

`npm run bench:board` runs [`bench/board-load.ts`](board-load.ts): a swarm-shaped load against one
`node:sqlite` file opened with `nanocode-ts/node` `Sql.open`.

## Shape

- A swarm is a root task plus 20 children. The first 4 children need the root, and every later child needs
  1 or 2 of the 6 children before it, so each swarm is a small DAG about 6 levels deep.
- Every task in a swarm carries the label `project: <swarm>`, so partition routing puts the whole swarm, needs
  included, in one partition (`load/p0` … `load/pN`). The audit checks that no swarm spans two partitions.
- The coordinator posts each swarm as one `group` and keeps 2 swarms per worker in flight for 45 s, then drains.
- M worker processes each run `Board.pool` with concurrency 4, a 3 s lease and a 25 ms poll. Each task sleeps
  5–50 ms. 2% of tasks get a steer from the coordinator as soon as they are claimed; the worker reads and heeds it.
- Every 10 s the coordinator SIGKILLs one worker and starts a new one in its place (4 kills per cell).

## Measurements

- **claims/s**: claim events in the log over the time from the first post to the last finish, re-claims included.
- **latency**: per task, from its post to its finish in the log, in ms.
- **takeover**: from a worker's SIGKILL to another worker's claim of a task it held, in ms.
- **retries**: `SQLITE_BUSY`/locked errors, then all failed SQL transactions per 1,000 write transactions. On one
  file every failure was a lost append race (`UNIQUE constraint failed: nanocode_log.scope, nanocode_log.seq`),
  which the log retries.
- **refresh**: `board.refresh()` p50 / p99 in ms, and refresh time as a share of total worker wall time.
- **violations**: an audit of the raw `nanocode_log` rows after each run: every task finishes exactly once with
  `done`; no task is claimed before all its needs are done, after its finish, or while another worker's lease is
  live; no swarm spans partitions; the drain finishes; no worker exits on its own.

## Machine

- Box: `nanoco-ef11` under an `nc-build` bench lease of 6 cores (`taskset -c 6-11`), 2026-11-20
- CPU: AMD EPYC 9254 24-Core Processor
- Node: v26.13.1
- nanocode-ts: d3d23e0 (master at run time) plus the bench as landed in 0b12a49

## Results

| partitions | workers | tasks | claims/s | latency p50 / p95 / p99 ms | takeover p50 / max ms (n) | busy / retries per 1k writes | refresh p50 / p99 ms / share | violations |
|---|---|---|---|---|---|---|---|---|
| 1 | 4 | 21693 | 479.4 | 176 / 336 / 424 | 2986 / 3001 (13) | 0 / 296.1 | 0.0794 / 1.78 / 2.3% | 0 |
| 1 | 8 | 35028 | 773.4 | 198 / 405 / 521 | 2971 / 2997 (14) | 0 / 387.3 | 0.0708 / 8.91 / 5.5% | 0 |
| 1 | 16 | 32403 | 715.4 | 219 / 494 / 651 | 2979 / 2996 (7) | 0 / 464.1 | 0.1 / 20 / 8.1% | 0 |
| 4 | 4 | 20265 | 448.1 | 166 / 361 / 508 | 2987 / 3004 (16) | 0 / 222.6 | 0.398 / 5.62 / 9.3% | 0 |
| 4 | 8 | 33600 | 742.2 | 201 / 441 / 587 | 2990 / 3027 (15) | 0 / 336.8 | 1.41 / 20 / 22.1% | 0 |
| 4 | 16 | 30681 | 676.8 | 330 / 819 / 1125 | 2962 / 2997 (10) | 0 / 425.9 | 2.82 / 56.2 / 26.6% | 0 |
| 8 | 4 | 20538 | 454.1 | 165 / 362 / 542 | 2998 / 3009 (15) | 0 / 197.9 | 0.631 / 8.91 / 14.2% | 0 |
| 8 | 8 | 28371 | 625.4 | 238 / 556 / 840 | 2961 / 3000 (12) | 0 / 328.8 | 2.51 / 39.8 / 36.8% | 0 |
| 8 | 16 | 29610 | 644.9 | 430 / 1092 / 1660 | 2984 / 3212 (12) | 0 / 427.4 | 5.01 / 89.1 / 39.9% | 0 |

Each cell ran 46–47 s of wall time; the whole matrix took 7.5 minutes.

## Findings

- **Correctness held in every cell.** About 252,000 tasks across 9 cells and 36 kills: each finished exactly once,
  none was claimed before its needs were done or while a live lease held it, and no swarm crossed partitions.
- **Takeover is the lease.** A killed worker's tasks are claimed again 2.96–3.2 s after the kill, matching the 3 s
  lease. Swarms that lose a worker pay it: their p99 runs up to about 3.3 s at 4 workers.
- **No `SQLITE_BUSY`.** Contention shows up as append races instead: 200–460 lost races per 1,000 writes, rising
  with workers.
- **Partitions cost more than they give on one file.** Every refresh scans every partition, so refresh time grows
  with partitions × workers: at 16 workers it is 8% of worker time with 1 partition, 27% with 4 and 40% with 8
  (p99 20 → 56 → 89 ms). Throughput at 8 workers falls from 773 to 742 to 625 claims/s, and task p99 at 16 workers
  rises from 651 to 1,125 to 1,660 ms.
- **Throughput peaks at 8 workers on 6 cores.** Going from 8 to 16 workers lowers claims/s at 1 and 4 partitions
  (773 → 715, 742 → 677) and leaves 8 partitions flat (625 → 645), while p99 latency grows in all three.
- At 16 workers many steers come back `Terminal` (89% at 1 partition, 33% at 8): the task finished before the
  steer landed. The bench counts those as expected, not as violations.

## Reproduce

```sh
npm ci && npm run build:ts
npm run bench:board                                         # the full matrix
npm run bench:board -- --partitions 8 --workers 16          # one cell
```

Flags: `--children`, `--concurrency`, `--inflight`, `--kill-every-ms`, `--lease-ms`, `--poll-ms`,
`--post-ms`, `--drain-ms`, `--seed`, `--steer`, `--work-min-ms`, `--work-max-ms`. Each run writes its JSON to
`output/bench/board-load/`.
