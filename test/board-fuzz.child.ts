import * as fs from 'node:fs'
import { Board, Sql } from 'nanocode-ts/node'

type Config = {
  child: number
  generation: number
  journal: string
  path: string
  scope: string
  seed: number
  untilMs: number
}

type Held = { claim: string; id: string }

const config = JSON.parse(process.argv[2]!) as Config
const actor = 'agent:c' + config.child
const random = generator(config.seed)
const sql = Sql.open(config.path)
const board = await Board.open({ sql, scope: config.scope, actor })
const held = new Map<string, Held>()
let known: string[] = []
let live: string[] = []
let count = 0

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

function below(n: number) {
  return Math.floor(random() * n)
}

function pick<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[below(items.length)]
}

function record(entry: object) {
  fs.appendFileSync(
    config.journal,
    JSON.stringify({ child: config.child, generation: config.generation, ...entry }) + '\n',
  )
}

function verdict(kind: string, fields: object, result: Board.Verdict) {
  record(
    result.ok
      ? { kind, ok: true, event: result.event, seq: result.seq, ...fields }
      : { kind, ok: false, rejection: result.rejection.kind, ...fields },
  )
  return result
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function look() {
  await board.refresh()
  const tasks = await board.tasks()
  known = tasks.map((task) => task.id)
  live = tasks
    .filter((task) => task.phase === 'open' || task.phase === 'claimed')
    .map((task) => task.id)
  for (let i = 0; i < 4; i++) {
    const task = pick(tasks)
    if (task && (task.phase === 'done' || task.phase === 'failed'))
      record({ kind: 'seen', id: task.id, outcome: task.outcome, phase: task.phase })
  }
  return tasks
}

async function post() {
  const id = 'c' + config.child + 'g' + config.generation + 'n' + count
  const needs = [...new Set(Array.from({ length: below(4) }, () => pick(known.slice(-30))))].filter(
    (need) => need !== undefined,
  )
  const key = random() < 0.35 ? 'post-' + below(12) : undefined
  const labels = key === undefined ? {} : { key: actor + '#' + key }
  const result = await board.post(
    { id, labels, needs, spec: 'fuzz ' + id },
    key === undefined ? {} : { key },
  )
  verdict('post', { id, key: key === undefined ? null : actor + '#' + key, needs }, result)
  if (result.ok && key === undefined) {
    known.push(id)
    live.push(id)
  }
}

async function claim() {
  const ready = random() < 0.6 ? await board.ready() : []
  const id = pick(ready)?.id ?? (random() < 0.8 ? pick(live) : pick(known))
  if (id === undefined || held.has(id)) return
  const leaseMs = 50 + below(251)
  const result = await board.claim(
    id,
    random() < 0.1 ? { cap: 1 + below(4), leaseMs } : { leaseMs },
  )
  if (!result.ok) {
    record({ kind: 'claim', ok: false, id, rejection: result.rejection.kind })
    if (result.rejection.kind === 'Terminal') live = live.filter((other) => other !== id)
    return
  }
  record({
    kind: 'claim',
    ok: true,
    id,
    claim: result.claim,
    seq: result.seq,
    tookOver: result.tookOver,
  })
  held.set(id, { claim: result.claim, id })
}

async function pending(lease: Held) {
  return board.steers(lease.id, lease.claim).catch((error: unknown) => {
    record({ kind: 'steers', ok: false, id: lease.id, message: String(error) })
    return null
  })
}

async function heed(lease: Held) {
  const steers = await pending(lease)
  if (!steers) return false
  const upto = random() < 0.15 ? 1 + below(Math.max(1, steers[0]?.seq ?? 1)) : pick(steers)?.seq
  if (upto === undefined) return true
  const result = verdict(
    'heed',
    { id: lease.id, claim: lease.claim, upto },
    await board.heed(lease.id, lease.claim, upto),
  )
  return result.ok || result.rejection.kind === 'Steer'
}

async function work() {
  const lease = pick([...held.values()])
  if (!lease) return claim()
  const roll = random()
  if (roll < 0.2) {
    const result = verdict(
      'renew',
      { id: lease.id, claim: lease.claim },
      await board.renew(lease.id, lease.claim, 50 + below(251)),
    )
    if (!result.ok) held.delete(lease.id)
  } else if (roll < 0.3) {
    verdict(
      'release',
      { id: lease.id, claim: lease.claim },
      await board.release(lease.id, lease.claim, 'fuzz'),
    )
    held.delete(lease.id)
  } else if (roll < 0.55) {
    if (!(await heed(lease))) held.delete(lease.id)
  } else {
    const steers = await pending(lease)
    const last = steers?.at(-1)
    if (last && random() < 0.9)
      verdict(
        'heed',
        { id: lease.id, claim: lease.claim, upto: last.seq },
        await board.heed(lease.id, lease.claim, last.seq),
      )
    const tag = 'c' + config.child + 'g' + config.generation + 'o' + count
    const outcome = random() < 0.7 ? { done: tag } : { failed: tag }
    const result = verdict(
      'finish',
      { id: lease.id, claim: lease.claim, outcome },
      await board.finish(lease.id, lease.claim, outcome),
    )
    if (result.ok || result.rejection.kind !== 'Steer') held.delete(lease.id)
    if (result.ok) live = live.filter((other) => other !== lease.id)
  }
}

async function steer() {
  const id =
    (random() < 0.5 ? pick([...held.keys()]) : undefined) ??
    (random() < 0.8 ? pick(live) : pick(known))
  if (id === undefined) return
  const key = random() < 0.4 ? 'steer-' + below(10) : undefined
  const body =
    key === undefined
      ? 'c' + config.child + 'g' + config.generation + 's' + count
      : actor + '#' + key
  const lease = held.get(id)
  const options = {
    ...(key === undefined ? {} : { key }),
    ...(lease && random() < 0.5 ? { claim: lease.claim } : {}),
  }
  verdict(
    'steer',
    { id, body, key: key === undefined ? null : actor + '#' + key },
    await board.steer(id, body, options),
  )
}

try {
  await look()
  while (Date.now() < config.untilMs) {
    count++
    const roll = random()
    if (roll < 0.25) await post()
    else if (roll < 0.4) await claim()
    else if (roll < 0.7) await work()
    else if (roll < 0.9) await steer()
    else await look()
    const pause = random()
    if (pause < 0.03) await sleep(100 + below(300))
    else if (pause < 0.5) await sleep(below(15))
  }
  await board.close()
  sql.close()
  record({ kind: 'end' })
} catch (error) {
  record({ kind: 'error', message: String((error as Error)?.stack ?? error) })
  process.exitCode = 1
}
