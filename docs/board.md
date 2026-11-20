# Board

The Board is a shared task list for agents. Several processes, or several agents in one process, post tasks, claim them under a lease and finish them, all through one append-only log in SQL. This page is the nanocode-ts API. For how the log folds into tasks, see [nanocode's docs/board.md](https://github.com/nanocodexyz/nanocode/blob/master/docs/board.md).

A write the board refuses does not throw. It returns `{ ok: false, rejection }`, and `rejection.kind` says why (`Waiting`, `Held`, `NotHolder`, `Full`, `Steer`, `UnknownNeed` and so on). Check `ok` after every write.

## Open a board

`Board.open({ sql, scope, actor, partitions?, module?, charter? })` opens one handle over a `SqlHost`. `scope` names the board and `actor` is who writes (`agent:lead`), so give each worker its own handle. A handle charters the scope when it opens (`charter: false` skips that). The handle that chartered it can let others in with `grant`, as the example does for every `agent:` actor.

Node, a SQLite file that several processes can share (needs `node:sqlite`, Node 22.5+):

```ts
import { Board, Sql } from 'nanocode-ts/node'

const sql = Sql.open('board.sqlite') // WAL; a write waits up to busyTimeoutMs (10 s) for the lock
const board = await Board.open({ sql, scope: 'demo', actor: 'agent:lead' })
```

Cloudflare, inside a SQLite-backed Durable Object (pass the wasm module, as the Worker bundle imports it):

```ts
import { Board } from 'nanocode-ts'
import { Sql } from 'nanocode-ts/cloudflare'
import wasm from 'nanocode-ts/nanocode_wasm.wasm'

const board = await Board.open({
  sql: Sql.create(this.ctx.storage),
  scope: 'demo',
  actor: 'agent:lead',
  module: wasm,
})
```

For tests, `await Board.memorySql()` is an in-memory host (Node only). Share one host between handles to share a board. `board.close()` closes a handle, and `sql.close()` closes the Node or memory host.

## Post

```ts
await board.post(
  {
    id: 'summarize',
    spec: 'summarize both halves',
    needs: ['fetch-a', 'fetch-b'],
    terms: { retry: { maxAttempts: 2, backoffMs: 50 } },
  },
  { key: 'post:summarize' },
)
```

- `needs` are task ids that must be done first. Claiming earlier is `Waiting`, and `rejection.value` is the unmet need. A need that does not exist is `UnknownNeed` and the task is not posted.
- `terms.retry` turns a `{ failed }` finish into a rescheduled task while attempts remain, with the backoff doubling each time. The other terms are `assignee`, `dueAtMs`, `every`, `cron` and `onFail`.
- `key` makes a write safe to repeat: the same key returns the first verdict (same `seq`) instead of writing again. A repost of an identical task is accepted as a no-op, and a different `spec` under an existing id is `Exists`.

`NewTask` also takes `parent` and `labels`. `cancel(id, reason)` and `reply(id, body)` act on a task.

## Claim, renew, release, finish

```ts
const claimed = await board.claim('summarize', { leaseMs: 30_000 })
if (!claimed.ok) return // Waiting, Held, Full, ...
const { claim, untilMs, tookOver } = claimed
await board.renew('summarize', claim, 30_000)
await board.release('summarize', claim, 'giving it back')
await board.finish('summarize', claim, { done: 'two lines' }) // or { failed: 'why' }
```

A claim holds the task until `untilMs`, and the holder renews to keep it. Once the lease lapses, anyone can claim the task and gets `tookOver: true`. The old holder's renew, release and finish are then refused (`NotHolder`), so a stalled worker cannot overwrite its replacement. Every call takes an optional `atMs` for tests.

`cap` bounds concurrency. `claim(id, { leaseMs, cap: 4 })` is refused with `Full` (and `rejection.cap`) when 4 other tasks are held, counting only live leases and only within one partition. This is the number form. Board.ts has no label form yet.

## Steer and heed

`steer(id, text)` sends a message to a task. The holder reads it with `steers(id, claim)`, which returns `{ seq, by, body, atMs, to }`, and acknowledges it with `heed(id, claim, seq)`, up to and including `seq`. While a steer is unheeded, `finish` is refused with `Steer`, so a message sent mid-run is never skipped.

## Reads

`ready()`, `task(id)`, `tasks()` and `held()` read the local fold, the log as this handle has seen it. Your own writes show at once. Another process's show up only after `await board.refresh()`. `ready({ label: [key, value] })` filters by label.

## Board.work

```ts
const outcome = await board.work('summarize', { leaseMs: 30_000 }, async (lease, steers) => {
  // lease.signal aborts if the lease is lost
  return { done: 'two lines' }
})
```

`work` claims the task, renews every third of the lease, hands `step` the steers pending at the claim, then heeds the last one and finishes with what `step` returned. It throws `LeaseLost` if the claim, a renewal or the finish is refused.

## Board.pool

`Board.pool` is a worker pool: it refreshes, claims ready tasks, runs your function, renews, heeds and finishes.

```ts
const pool = Board.pool(board, {
  concurrency: 2, // runs at once
  leaseMs: 30_000,
  pollMs: 100,
  run: async (task, lease) => {
    for (const steer of await lease.steers()) await lease.heed(steer.seq)
    return { done: 'ok' } // or { failed: 'why' }; a throw is a failure
  },
})
```

`label: [key, value]` limits the pool to tasks with that label, and `idleMs` retires it after that long with nothing to do. `lease` has `signal`, `tookOver`, `steers()` and `heed(seq)`. A run that did not heed its steers still finishes: the pool heeds the last one and retries. `pool.idle()` waits for a poll that finds nothing running or ready, `pool.stats()` counts `claimed`, `done`, `failed`, `lost`, `released`, `delivered`, `unheard`, `retries` and `errors`, and `pool.stop()` aborts the runs and releases their claims. The pool claims without a `cap`.

## Partitions

`partitions: 4` splits the log into 4 (the default is 1). A task lives in one partition: its `thread` or else `project` label picks it, a child follows its parent, and otherwise its id does. `needs` resolve inside the task's partition, so a need on a task in another partition is `UnknownNeed`. Give tasks that depend on each other a shared `project` label or a parent. A move between partitions is not supported.

## Example

[examples/board-pool](../examples/board-pool/index.ts) has a lead post a four-task graph while two `Board.pool` workers drain it on one SQLite file, with one steer. Run it with `npm run example:board-pool`. This output is from Node 26:

```text
+  87ms  lead  post   plan
+  88ms  lead  post   fetch-a
+  89ms  lead  post   fetch-b
+  89ms  lead  post   summarize
+ 106ms  w1    start  plan
+ 256ms  w1    done   plan
+ 258ms  w1    start  fetch-a
+ 274ms  w2    start  fetch-b
+ 409ms  w1    done   fetch-a
+ 424ms  w2    done   fetch-b
+ 425ms  w2    start  summarize
+ 438ms  lead  steer  summarize
+ 827ms  w2    steer  summarize: keep it to two lines
+ 828ms  w2    done   summarize
+ 829ms  lead  result fetch-a: {"done":"w1 finished fetch-a"}
+ 829ms  lead  result fetch-b: {"done":"w2 finished fetch-b"}
+ 829ms  lead  result plan: {"done":"w1 finished plan"}
+ 829ms  lead  result summarize: {"done":"w2 finished summarize"}
w1 {"state":"stopped","running":0,"claimed":2,"done":2,"failed":0,"lost":0,"released":0,"delivered":0,"unheard":0,"retries":0,"polls":37,"errors":0}
w2 {"state":"stopped","running":0,"claimed":2,"done":2,"failed":0,"lost":0,"released":0,"delivered":1,"unheard":0,"retries":0,"polls":37,"errors":0}
```

`w1` and `w2` split the two fetches once `plan` is done, `summarize` waits for both, and the lead's steer arrives while `w2` holds it. `w2` reads it, heeds it and finishes.
