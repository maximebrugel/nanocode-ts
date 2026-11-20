import assert from 'node:assert/strict'
import * as childProcess from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Board, Sql } from 'nanocode-ts/node'

type Entry = {
  body?: string
  child: number
  claim?: string
  event?: string
  generation: number
  id?: string
  key?: string | null
  kind: string
  message?: string
  needs?: string[]
  ok?: boolean
  outcome?: Board.Outcome
  phase?: string
  rejection?: string
  seq?: number
  upto?: number
}

type Run = {
  child: number
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
  generation: number
  killed: boolean
  proc: childProcess.ChildProcess
}

// Four processes (board-fuzz.child.ts) write one SQLite board at random for FUZZ_MS (18 s by
// default; set it higher for a long run), some SIGKILLed and restarted, then a fresh handle checks
// the invariants against their journals. FUZZ_SEED fixes the random choices (timing still varies);
// a failure prints it.
const seed = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : crypto.randomInt(2 ** 31)
const runMs = process.env.FUZZ_MS ? Number(process.env.FUZZ_MS) : 18_000
const children = 4
const scope = 'fuzz'
const script = fileURLToPath(new URL('./board-fuzz.child.ts', import.meta.url))

function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function group<T>(items: readonly T[], by: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = by(item)
    if (key === undefined) continue
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

function start(dir: string, file: string, child: number, generation: number, untilMs: number): Run {
  const config = {
    child,
    generation,
    journal: path.join(dir, 'journal-' + child + '-' + generation + '.jsonl'),
    path: file,
    scope,
    seed: (seed * 31 + child) * 31 + generation,
    untilMs,
  }
  const proc = childProcess.spawn(
    process.execPath,
    [
      ...process.execArgv.filter((arg) => !arg.startsWith('--test')),
      script,
      JSON.stringify(config),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  proc.stderr!.on('data', (chunk) => (stderr += chunk))
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (resolve) => proc.on('close', (code, signal) => resolve({ code, signal, stderr })),
  )
  return { child, exit, generation, killed: false, proc }
}

function journals(dir: string) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('journal-'))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Entry),
    )
}

function check(
  entries: readonly Entry[],
  tasks: readonly Board.Task[],
  steers: ReadonlyMap<string, readonly Board.Steer[]>,
  killed: ReadonlySet<string>,
) {
  const violations: string[] = []
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const ok = entries.filter((entry) => entry.ok === true)
  const of = (kind: string) => ok.filter((entry) => entry.kind === kind)
  const finishes = group(of('finish'), (entry) => entry.id)
  const show = (value: unknown) => JSON.stringify(value)

  for (const entry of entries) {
    if (entry.kind === 'error') violations.push('child ' + entry.child + ' threw: ' + entry.message)
    if (entry.rejection === 'Unknown') violations.push('Unknown rejection: ' + show(entry))
  }

  // One call lands one event, so only the repeats of one keyed write share a seq.
  for (const [seq, same] of group(ok, (entry) => String(entry.seq)))
    if (
      new Set(same.map((entry) => entry.event)).size > 1 ||
      (same.length > 1 && new Set(same.map((entry) => entry.kind + ' ' + entry.key)).size > 1) ||
      (same.length > 1 && same.some((entry) => !entry.key))
    )
      violations.push('seq ' + seq + ' went to several writes: ' + show(same))

  for (const posted of of('post'))
    if (!posted.key && !byId.has(posted.id!))
      violations.push('post ' + posted.id + ' was acknowledged but made no task: ' + show(posted))

  for (const [id, done] of finishes) {
    const task = byId.get(id)
    if (done.length > 1) violations.push(id + ' finished more than once: ' + show(done))
    const outcome = done[0]!.outcome!
    const phase = 'done' in outcome ? 'done' : 'failed'
    if (task?.phase !== phase || show(task.outcome) !== show(outcome))
      violations.push(id + ' finished ' + show(outcome) + ' but is now ' + show(task))
  }

  for (const entry of entries.filter(
    (entry) => entry.kind === 'seen' || entry.kind === 'watched',
  )) {
    const task = byId.get(entry.id!)
    if (task?.phase !== entry.phase || show(task.outcome) !== show(entry.outcome))
      violations.push(entry.id + ' was seen ' + show(entry) + ' but is now ' + show(task))
  }

  for (const task of tasks) {
    const unmet = task.needs.filter((need) => byId.get(need)?.phase !== 'done')
    if (unmet.length > 0 && task.attempts > 0)
      violations.push(
        task.id + ' was claimed with needs ' + show(unmet) + ' not done: ' + show(task),
      )
    if ((task.phase === 'done' || task.phase === 'failed') && task.attempts === 0)
      violations.push(task.id + ' finished without a claim: ' + show(task))
    if (
      (task.phase === 'done' || task.phase === 'failed') &&
      (steers.get(task.id) ?? []).length > 0
    )
      violations.push(task.id + ' finished with unheeded steers: ' + show(steers.get(task.id)))
  }

  for (const claim of of('claim')) {
    for (const need of byId.get(claim.id!)?.needs ?? []) {
      const finished = finishes.get(need)?.[0]
      if (finished && finished.seq! > claim.seq!)
        violations.push(
          claim.id +
            ' was claimed at ' +
            claim.seq +
            ' before ' +
            need +
            ' finished at ' +
            finished.seq,
        )
    }
  }

  for (const [key, posts] of group(of('post'), (entry) => entry.key ?? undefined)) {
    if (new Set(posts.map((entry) => entry.seq)).size > 1)
      violations.push('keyed post ' + key + ' landed at several seqs: ' + show(posts))
  }
  for (const [key, made] of group(tasks, (task) => task.labels.key))
    if (made.length > 1)
      violations.push('keyed post ' + key + ' made ' + show(made.map((task) => task.id)))

  for (const [body, sent] of group(of('steer'), (entry) => entry.body))
    if (new Set(sent.map((entry) => entry.seq)).size > 1)
      violations.push('steer ' + body + ' landed at several seqs: ' + show(sent))

  const heeded = new Map<string, number>()
  for (const [id, heeds] of group(of('heed'), (entry) => entry.id)) {
    const ordered = heeds.toSorted((a, b) => a.seq! - b.seq!)
    for (let i = 1; i < ordered.length; i++)
      if (ordered[i]!.upto! <= ordered[i - 1]!.upto!)
        violations.push(id + ' heed ran backwards: ' + show([ordered[i - 1], ordered[i]]))
    heeded.set(id, Math.max(...ordered.map((entry) => entry.upto!)))
  }

  const bodies = new Map<string, number>()
  for (const [id, list] of steers) {
    for (let i = 0; i < list.length; i++) {
      const steer = list[i]!
      if (i > 0 && steer.seq <= list[i - 1]!.seq)
        violations.push(id + ' steers out of order: ' + show(list))
      if (steer.seq <= (heeded.get(id) ?? 0))
        violations.push(
          id + ' still holds steer ' + steer.seq + ' after a heed up to ' + heeded.get(id),
        )
      if (bodies.has(steer.body))
        violations.push(
          'steer ' +
            steer.body +
            ' is pending twice: ' +
            bodies.get(steer.body) +
            ' and ' +
            steer.seq,
        )
      bodies.set(steer.body, steer.seq)
    }
  }
  for (const sent of of('steer')) {
    const task = byId.get(sent.id!)
    if (sent.key || killed.has(sent.id!) || sent.seq! <= (heeded.get(sent.id!) ?? 0)) continue
    if (task?.phase !== 'open' && task?.phase !== 'claimed') continue
    if (
      !(steers.get(sent.id!) ?? []).some(
        (steer) => steer.seq === sent.seq && steer.body === sent.body,
      )
    )
      violations.push(sent.id + ' lost steer ' + show(sent) + ': ' + show(steers.get(sent.id!)))
  }

  return violations
}

test('the fuzz checker flags broken histories', () => {
  const task = (id: string, fields: Partial<Board.Task>) =>
    ({
      attempts: 1,
      id,
      labels: {},
      needs: [],
      phase: 'done',
      outcome: { done: 'x' },
      ...fields,
    }) as Board.Task
  const entry = (fields: Partial<Entry>): Entry => ({
    child: 0,
    generation: 0,
    ok: true,
    kind: 'post',
    ...fields,
  })
  const tasks = [
    task('a', { outcome: { done: 'second' } }),
    task('b', { needs: ['c'], phase: 'claimed', outcome: undefined }),
    task('c', { attempts: 0, phase: 'open', outcome: undefined }),
    task('k1', {
      labels: { key: 'agent:c0#post-1' },
      phase: 'open',
      attempts: 0,
      outcome: undefined,
    }),
    task('k2', {
      labels: { key: 'agent:c0#post-1' },
      phase: 'open',
      attempts: 0,
      outcome: undefined,
    }),
  ]
  const entries = [
    entry({ kind: 'finish', id: 'a', seq: 5, outcome: { done: 'first' } }),
    entry({ kind: 'finish', id: 'a', seq: 6, outcome: { done: 'second' } }),
    entry({ kind: 'steer', id: 'c', body: 's1', seq: 7 }),
    entry({ kind: 'steer', id: 'c', body: 's1', seq: 8 }),
    entry({ kind: 'heed', id: 'c', upto: 8, seq: 9 }),
    entry({ kind: 'heed', id: 'c', upto: 7, seq: 10 }),
    entry({ kind: 'renew', id: 'b', seq: 10 }),
    entry({ kind: 'post', id: 'gone', seq: 11 }),
  ]
  const violations = check(entries, tasks, new Map(), new Set())
  for (const expected of [
    'a finished more than once',
    'b was claimed with needs ["c"] not done',
    'keyed post agent:c0#post-1 made ["k1","k2"]',
    'steer s1 landed at several seqs',
    'c heed ran backwards',
    'seq 10 went to several writes',
    'post gone was acknowledged but made no task',
  ])
    assert.ok(
      violations.some((violation) => violation.startsWith(expected)),
      expected + ' in ' + JSON.stringify(violations),
    )
})

test(
  'Board fuzz: ' + children + ' processes on one SQLite file, FUZZ_SEED=' + seed,
  { timeout: runMs + 120_000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-fuzz-'))
    const file = path.join(dir, 'board.sqlite')
    const random = generator(seed)
    const sql = Sql.open(file)
    const live = await Board.open({ sql, scope, actor: 'agent:checker' })
    let passed = false
    try {
      const granted = await live.grant(
        { who: [{ kind: 'kind', id: 'agent' }], can: { '*': ['manage'] } },
        { key: 'grant-agents' },
      )
      assert.ok(granted.ok, JSON.stringify(granted))

      const untilMs = Date.now() + runMs
      const runs: Run[] = []
      const current = Array.from({ length: children }, (_, child) =>
        start(dir, file, child, 0, untilMs),
      )
      runs.push(...current)
      const watched: Entry[] = []
      while (Date.now() < untilMs - 1_000) {
        await sleep(100 + Math.floor(random() * 200))
        await live.refresh()
        for (const task of await live.tasks())
          if ((task.phase === 'done' || task.phase === 'failed') && random() < 0.05)
            watched.push({
              child: -1,
              generation: 0,
              id: task.id,
              kind: 'watched',
              outcome: task.outcome!,
              phase: task.phase,
            })
        if (random() < 0.1) {
          const child = Math.floor(random() * children)
          const victim = current[child]!
          victim.killed = true
          victim.proc.kill('SIGKILL')
          await victim.exit
          await sleep(Math.floor(random() * 200))
          current[child] = start(dir, file, child, victim.generation + 1, untilMs)
          runs.push(current[child])
        }
      }

      const deadline = setTimeout(() => runs.forEach((run) => run.proc.kill('SIGKILL')), 60_000)
      const exits = await Promise.all(runs.map((run) => run.exit))
      clearTimeout(deadline)
      for (const [i, exit] of exits.entries())
        if (!runs[i]!.killed && exit.code !== 0)
          assert.fail(
            'child ' +
              runs[i]!.child +
              ' generation ' +
              runs[i]!.generation +
              ' exited ' +
              (exit.code ?? exit.signal) +
              ':\n' +
              exit.stderr,
          )

      await sleep(400)
      const atMs = Date.now()
      await live.refresh()
      const liveTasks = (await live.tasks(atMs)).toSorted((a, b) => a.id.localeCompare(b.id))
      const replaySql = Sql.open(file)
      const replay = await Board.open({ sql: replaySql, scope, actor: 'agent:checker' })
      try {
        const tasks = (await replay.tasks(atMs)).toSorted((a, b) => a.id.localeCompare(b.id))
        assert.deepEqual(
          tasks,
          liveTasks,
          'replaying the log gives other tasks than the live handle',
        )
        const steers = new Map<string, Board.Steer[]>()
        for (const task of tasks) {
          const replayed = await replay.steers(task.id)
          assert.deepEqual(replayed, await live.steers(task.id), task.id + ' replays other steers')
          if (replayed.length > 0) steers.set(task.id, replayed)
        }

        const entries = [...journals(dir), ...watched]
        const killed = new Set(
          entries
            .filter(
              (entry) =>
                entry.kind === 'claim' &&
                entry.ok &&
                runs.some(
                  (run) =>
                    run.killed && run.child === entry.child && run.generation === entry.generation,
                ),
            )
            .map((entry) => entry.id!),
        )
        const violations = check(entries, tasks, steers, killed)
        for (const task of tasks.filter((task) => task.phase === 'claimed')) {
          if (task.stage === 'held' || task.untilMs! > atMs)
            violations.push(
              task.id + ' is still held after every lease lapsed: ' + JSON.stringify(task),
            )
          const taken = await replay.claim(task.id, { leaseMs: 60_000, atMs })
          if (!taken.ok || !taken.tookOver)
            violations.push(
              task.id + ' could not be taken over after its lease lapsed: ' + JSON.stringify(taken),
            )
        }

        const count = (kind: string) =>
          entries.filter((entry) => entry.kind === kind && entry.ok).length
        t.diagnostic(
          'seed ' +
            seed +
            ': ' +
            tasks.length +
            ' tasks, ' +
            runs.length +
            ' processes (' +
            runs.filter((run) => run.killed).length +
            ' killed), ' +
            count('claim') +
            ' claims, ' +
            count('finish') +
            ' finishes, ' +
            count('steer') +
            ' steers, ' +
            count('heed') +
            ' heeds, ' +
            tasks.filter((task) => task.phase === 'done').length +
            ' done, ' +
            tasks.filter((task) => task.phase === 'failed').length +
            ' failed',
        )
        const rejected = new Map<string, number>()
        for (const entry of entries.filter((entry) => entry.ok === false)) {
          const name = entry.kind + ':' + (entry.rejection ?? 'error')
          rejected.set(name, (rejected.get(name) ?? 0) + 1)
        }
        t.diagnostic('rejections ' + JSON.stringify(Object.fromEntries([...rejected].toSorted())))
        assert.deepEqual(violations.slice(0, 20), [], violations.length + ' invariant violations')
        assert.ok(count('finish') > 0 && count('heed') > 0, 'the run finished and heeded nothing')
        passed = true
      } finally {
        await replay.close()
        replaySql.close()
      }
    } catch (error) {
      throw new Error(
        'FUZZ_SEED=' +
          seed +
          ' FUZZ_MS=' +
          runMs +
          ' failed; journals and board kept in ' +
          dir +
          '\n' +
          String((error as Error)?.stack ?? error),
      )
    } finally {
      await live.close()
      sql.close()
      if (passed) fs.rmSync(dir, { recursive: true, force: true })
    }
  },
)
