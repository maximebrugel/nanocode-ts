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

## Waking pools on Postgres

`Board.pool` takes `wake`, a subscription that makes the pool poll as soon as it fires, with `pollMs` kept as
the fallback. On Postgres, `nanocode-ts/postgres` gives one: every host sends `pg_notify('nanocode_log', <schema>)`
after it commits a write to `nanocode_log` (at most one every `notifyMs`, 10 ms by default), and `Sql.wake(host)`
LISTENs on that channel and calls the pool once per 5 ms burst. node:sqlite has no cross-process notify, so pools
there leave `wake` unset and keep polling.

**Idle pools** (`test/board-pool-wake.test.ts`): two processes, each a pool with `pollMs` 5000, drain 20 tasks
(10 roots and 10 that need one) posted after both are idle. With `wake` they finish in 74 ms and 80 ms (two runs);
without it they wait for the next poll, 4,976 ms and 5,001 ms.

**Busy pools** (`npm run bench:board -- --sql postgres --workers 8 --partitions 1,8 --poll-ms <25|1000>
--wake <off|on>`): Postgres 16 on loopback in an 8-core lease of a 48-core AMD EPYC host shared with other jobs,
default flags otherwise, zero violations in every cell. Two rounds on 2026-11-20: round A sent one notification per
committed write (0d9bb85), round B is the throttled sender that landed.

| round | poll ms | partitions | wake | claims/s | task p50 / p99 ms |
|---|---|---|---|---|---|
| A | 25 | 1 | off | 448.9 | 383 / 1,273 |
| A | 25 | 1 | on | 373.1 | 468 / 1,059 |
| A | 25 | 8 | off | 528.9 | 276 / 1,183 |
| A | 25 | 8 | on | 533.9 | 290 / 827 |
| A | 1000 | 1 | off | 289.5 | 594 / 1,983 |
| A | 1000 | 1 | on | 170.0 | 596 / 2,720 |
| A | 1000 | 8 | off | 434.6 | 338 / 1,527 |
| A | 1000 | 8 | on | 413.0 | 347 / 1,481 |
| B | 25 | 1 | off | 441.6 | 364 / 1,105 |
| B | 25 | 1 | on | 375.3 | 448 / 1,121 |
| B | 25 | 8 | off | 461.2 | 322 / 1,169 |
| B | 25 | 8 | on | 502.8 | 305 / 851 |
| B | 1000 | 1 | off | 388.4 | 448 / 1,414 |
| B | 1000 | 1 | on | 340.0 | 461 / 1,044 |
| B | 1000 | 8 | off | 406.0 | 365 / 1,467 |
| B | 1000 | 8 | on | 485.4 | 310 / 967 |

- **Wake matters when pools wait, not when they are full.** The bench keeps every pool busy (16 tasks in flight
  for 4 slots each), a pool polls whenever a run ends, and a full pool ignores wakes, so `pollMs` barely sets
  latency there: without wake, 1000 ms instead of 25 ms costs 12–35% of throughput, not a second per task.
- **At 8 partitions wake lowers the tail.** Task p99 falls 27–34% (1,169 → 851 and 1,467 → 967 ms in round B) and
  throughput holds or rises (461 → 503, 406 → 485 claims/s).
- **At 1 partition wake costs throughput.** Every worker appends at the same log tail, and polls woken by the
  others' writes add to those races: 15% fewer claims/s in round B (442 → 375, 388 → 340) and p50 up 3–23%, though
  p99 holds or falls. Round A's per-write notification was worse at `--poll-ms 1000` (290 → 170 claims/s, in a
  cell whose read p99 was 63 ms against 6 ms elsewhere, so part of it is the shared host); the 10 ms throttle
  landed after it.
- Cells vary by up to a third between rounds on this shared host (1 partition, 1000 ms, off: 290 and 388
  claims/s), so differences under about 15% in one round are noise.

## Reproduce

```sh
npm ci && npm run build:ts
npm run bench:board                                         # the full matrix
npm run bench:board -- --partitions 8 --workers 16          # one cell
```

Flags: `--children`, `--concurrency`, `--inflight`, `--kill-every-ms`, `--lease-ms`, `--poll-ms`,
`--post-ms`, `--drain-ms`, `--seed`, `--steer`, `--work-min-ms`, `--work-max-ms`, `--sql <sqlite|postgres>`, and
`--wake <off|on>` (Postgres only). Each run writes its JSON to
`output/bench/board-load/`.

# Board in a Durable Object

`npm run bench:board-do` runs [`bench/board-do.ts`](board-do.ts): the Board the way a swarm deploys it, one Board
per Cloudflare Durable Object over `nanocode-ts/cloudflare`'s `Sql.create(ctx.storage)`, served locally by workerd.
[`bench/board-do.worker.ts`](board-do.worker.ts) is bundled with rolldown and configured like
`test/board-cloudflare.test.ts`: SQLite-backed object storage on local disk, one object per URL path.

## Shape and measurements

- **Load**: each cell gets a fresh object. A lead posts 120 swarms (a root plus 20 children in the DAG shape of
  `bench:board`), each as one `group`, keeping 2 per client in flight. K concurrent clients (K = 1, 4, 16) loop
  over fetch: `claim` (in the object: `refresh`, `ready`, then `claim` on a random ready task), `renew`, then
  `finish` (`refresh`, `steers`, `heed` any steer, `finish`). The lead steers about 2% of tasks as soon as
  they are claimed (35 of 2,520 per cell landed; every one was heeded). Leases are 30 s and nothing is killed.
- Two ways to hold the board: **one** handle for the whole object, as a swarm's object holds its board, and
  **actors**, one handle per client in the same object (as `test/board-cloudflare.test.ts` does), each with
  its own fold.
- **claims/s** over the cell's wall time; **latency** per call as the client sees it over fetch; **in-object**
  mean time per call inside `fetch`; **refresh** mean and its share of in-object time; **SQL** share of in-object
  time, from timing every `transaction` of the object's SQL host.
- **Replay**: one object's log grows to each size with the same ops (post, claim, renew, 2% steer and heed,
  finish). At each size the object restarts with `ctx.abort()` 5 times; each wake times `Board.open` over the
  stored log, the first `tasks()`, a second `tasks()`, and a first write (post, claim and finish one task).
  Medians of the 5.
- **Storage**: `ctx.storage.sql.databaseSize` and the summed size of the `nanocode_log` bodies.
- **Correctness** after every cell and every replay size, from the raw `nanocode_log` rows: every posted task has
  exactly one `finish` event, with `done`; the clients saw exactly one accepted finish per task; and the board's
  own view has every task done.
- In-object times use workerd's clock, which runs in real time at 1 ms resolution (a 114 ms busy loop reads
  114 ms): means over thousands of calls are sound, in-object percentiles would only be whole milliseconds.

## Machine

- Box: `pyrami-99d0` under an `nc-build` bench lease of 4 cores (`taskset -c 0-3`), shared with other leases
  (48 of 48 cores leased, load about 49), 2026-11-20. workerd and the Node driver share the 4 cores.
- CPU: AMD EPYC 9254 24-Core Processor
- Node: v22.23.5; workerd 1.20261120.1 (`workerd 2026-11-20`)
- nanocode-ts: af29755 (master at run time) plus the bench at 74a6658 (landed as 8420513)

## Load

| handles | K | claims/s | claim p50 / p95 / p99 ms | renew p50 / p95 / p99 ms | finish p50 / p95 / p99 ms | in-object claim / renew / finish ms | refresh mean ms / share | SQL share | append races | violations |
|---|---|---|---|---|---|---|---|---|---|---|
| one | 1 | 137.2 | 1.84 / 6.05 / 8.81 | 1.56 / 5.79 / 8.00 | 1.71 / 5.63 / 7.91 | 0.48 / 0.19 / 0.37 | 0.14 / 27% | 32% | 0 | 0 |
| one | 4 | 235.3 | 4.71 / 12.0 / 16.8 | 4.10 / 11.4 / 16.9 | 4.27 / 11.4 / 16.0 | 0.47 / 0.14 / 0.29 | 0.12 / 27% | 33% | 0 | 0 |
| one | 16 | 241.6 | 18.8 / 34.6 / 48.5 | 17.9 / 33.8 / 110 | 17.7 / 34.0 / 48.0 | 0.85 / 0.13 / 0.25 | 0.12 / 19% | 21% | 0 | 0 |
| actors | 1 | 199.8 | 1.31 / 3.11 / 5.24 | 1.06 / 4.65 / 6.66 | 1.21 / 2.93 / 5.20 | 0.39 / 0.20 / 0.30 | 0.13 / 30% | 37% | 143 | 0 |
| actors | 4 | 225.1 | 4.43 / 9.33 / 16.8 | 4.33 / 9.40 / 15.2 | 4.24 / 9.08 / 17.4 | 0.58 / 0.56 / 0.46 | 0.23 / 28% | 35% | 2,521 | 0 |
| actors | 16 | 129.1 | 37.7 / 62.0 / 150 | 37.1 / 60.7 / 136 | 36.8 / 60.6 / 136 | 1.61 / 0.95 / 0.85 | 0.61 / 36% | 19% | 2,520 | 0 |

Every cell: 2,520 tasks, 10,152 log events. Append races are `turn_log_append` transactions that lost the
sequence race to another handle and were retried by the log; none failed a call.

## Replay after a restart

| events | tasks | database | per 1k events | open ms | first `tasks()` ms | warm `tasks()` ms | first write ms | wake total ms | violations |
|---|---|---|---|---|---|---|---|---|---|
| 1,033 | 256 | 213 KB | 206 KB | 19.4 | 3.9 | 3.0 | 5.4 | 32 | 0 |
| 2,576 | 639 | 516 KB | 200 KB | 43.9 | 9.2 | 7.1 | 8.9 | 78 | 0 |
| 5,061 | 1,253 | 1.00 MB | 198 KB | 80.2 | 17.6 | 13.3 | 9.0 | 122 | 0 |
| 10,070 | 2,497 | 1.98 MB | 197 KB | 161 | 33.4 | 26.6 | 9.7 | 233 | 0 |
| 25,047 | 6,198 | 4.96 MB | 198 KB | 406 | 83.1 | 67.6 | 8.5 | 565 | 0 |
| 50,040 | 12,377 | 9.96 MB | 199 KB | 842 | 168 | 139 | 15.2 | 1,163 | 0 |
| 100,053 | 24,751 | 20.1 MB | 201 KB | 1,683 | 322 | 282 | 23.8 | 2,305 | 0 |

Open is measured over fetch and includes one round trip (about 1 ms); the time inside the object is within
1–5 ms of it. Growth between sizes, as (open time ratio) / (event ratio), is 0.91, 0.93, 1.01, 1.01, 1.04, 1.00.
The restart itself (`ctx.abort()` and the first request to the new instance) takes 3–8 ms.

## Findings

- **Correctness held everywhere.** 15,120 tasks over 6 load cells and 24,751 in the replay object: each finished
  exactly once, as `done`, and the board's view agreed.
- **Replay is linear, with no cliff up to 100k events, but nothing bounds it.** `Board.open` costs about 16.8 ms
  per 1k events, and the first full read another 3.2 ms per 1k. Since a swarm reopens the board on every wake, a
  wake costs 0.23 s at 10k events (about 120 swarms of 21 tasks), 1.16 s at 50k and 2.3 s at 100k before any
  work. There is no snapshot or compaction, so a long-lived object pays for its whole history on each wake.
- **`tasks()` is O(tasks)**: about 11 µs per task warm (282 ms at 24,751 tasks). A first write after a wake grows
  too, from 5 to 24 ms over 1k–100k events, three round trips included.
- **Storage is about 200 KB per 1k events** (≈200 bytes per event), flat from 1k to 100k: the log bodies are
  157–162 bytes per event, one row per event, and SQLite adds about 25%.
- **One handle per object peaks near 240 claims/s at K = 4–16 here.** The board's own time per task (claim,
  renew and finish inside the object) is about 1.0–1.2 ms, so at K = 16 the object is busy about 30% of the wall
  time; the rest of each call's 18 ms p50 is queueing on workerd's request path (fetch, the namespace stub and the
  object's input gate) on 4 shared cores. Latency grows with K as that queue does.
- **Refresh with one handle is overhead without news:** each still scans the log, 0.12–0.14 ms, 19–27% of the
  object's time. A swarm object that is the board's only writer could skip it.
- **Many handles in one object fall off at K = 16:** 129 claims/s against 225 at K = 4, p99 136–150 ms, refresh
  mean 0.61 ms (each handle folds every other handle's writes), and one append race per task. The one-handle
  layout swarms uses does not have this.
- Box noise is real here (a fully leased box): the one-handle K = 1 cell ran first and slower than the actors
  K = 1 cell with the same work, which reads as warm-up and noise rather than a difference in the layouts.

## Reproduce

```sh
npm ci && npm run build:ts
npm run bench:board-do                                                # load (K = 1, 4, 16 × one, actors) and replay
npm run bench:board-do -- --phases replay --sizes 10000,50000,100000  # wake cost against log size
npm run bench:board-do -- --phases load --modes actors --clients 4,16 # the many-handles drop at K = 16
```

Flags: `--children`, `--clients`, `--lease-ms`, `--modes`, `--phases`, `--restarts`, `--seed`, `--sizes`,
`--steer`, `--swarms`, `--keep true` (keep the workerd storage dir). Each run writes its JSON to
`output/bench/board-do/`; the process exits 1 if any audit finds a violation.
