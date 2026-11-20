import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Board as NodeBoard, Sql as NodeSql } from 'nanocode-ts/node'
import { Board, Sql } from 'nanocode-ts/postgres'

const url = process.env.DATABASE_URL
const pollMs = 5_000
const count = 20
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Role = { url: string; schema: string; scope: string; actor: string; wake: boolean }

async function child(role: Role) {
  const emit = (line: object) => process.stdout.write(JSON.stringify(line) + '\n')
  const sql = Sql.open(role.url, { schema: role.schema, max: 2 })
  const board = await Board.open({
    sql,
    scope: role.scope,
    actor: 'agent:' + role.actor,
    charter: false,
  })
  let ready = false
  const announce = () => {
    if (ready) return
    ready = true
    emit({ e: 'ready' })
  }
  const pool = Board.pool(board, {
    concurrency: 2,
    leaseMs: 30_000,
    pollMs,
    wake: role.wake
      ? (notify) =>
          // The first notify is the LISTEN taking effect, so the process is ready for wakes.
          Sql.wake(sql)(() => {
            announce()
            notify()
          })
      : undefined,
    async run() {
      await sleep(5)
      return { done: role.actor }
    },
  })
  if (!role.wake) {
    while (pool.stats().polls === 0) await sleep(5)
    await sleep(100)
    announce()
  }
  process.on('SIGTERM', () => {
    void pool
      .stop()
      .then(() => board.close())
      .then(() => sql.close())
      .then(() => process.exit(0))
  })
}

if (process.env.NC_WAKE_CHILD) {
  await child(JSON.parse(process.env.NC_WAKE_CHILD) as Role)
} else {
  describe('Board.pool wake', () => {
    test('a notify polls at once; the pool unsubscribes when it stops', async () => {
      const root = mkdtempSync(join(tmpdir(), 'nc-board-wake-'))
      after(() => rmSync(root, { recursive: true, force: true }))
      const sql = NodeSql.open(join(root, 'wake.sqlite'))
      const board = await NodeBoard.open({ sql, scope: 'wake', actor: 'agent:solo' })
      let notify: (() => void) | undefined
      let unsubscribed = 0
      const done: string[] = []
      const pool = NodeBoard.pool(board, {
        concurrency: 2,
        leaseMs: 30_000,
        pollMs,
        wake(fire) {
          notify = fire
          return () => unsubscribed++
        },
        async run(task) {
          done.push(task.id)
          return { done: 'solo' }
        },
      })
      while (pool.stats().polls === 0) await sleep(5)
      await sleep(50)
      const polls = pool.stats().polls
      assert.ok((await board.post({ id: 'a', spec: 'woken' })).ok)
      const started = Date.now()
      notify!()
      while (done.length === 0) {
        assert.ok(Date.now() - started < 2_000, 'notify did not poll')
        await sleep(5)
      }
      assert.ok(pool.stats().polls > polls)
      await pool.stop()
      assert.equal(unsubscribed, 1)
      notify!()
      await board.close()
      sql.close()
    })
  })

  if (!url) {
    test('Board.pool wake over Postgres', { skip: 'DATABASE_URL is not set' }, () => {})
  } else {
    const schemas: string[] = []
    const children = new Set<ChildProcess>()
    after(async () => {
      for (const proc of children) proc.kill('SIGKILL')
      const admin = Sql.open(url)
      try {
        for (const schema of schemas)
          await admin.transaction(
            'log',
            'drop',
            [['DROP SCHEMA IF EXISTS ' + schema + ' CASCADE']],
            'schema',
          )
      } finally {
        await admin.close()
      }
    })

    const start = (role: Role) => {
      const args = [
        ...process.execArgv.filter((arg) => !arg.startsWith('--test')),
        fileURLToPath(import.meta.url),
      ]
      const proc = spawn(process.execPath, args, {
        env: { ...process.env, NC_WAKE_CHILD: JSON.stringify(role) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.add(proc)
      let err = ''
      proc.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()))
      const ready = new Promise<void>((resolve, reject) => {
        createInterface({ input: proc.stdout! }).on('line', (line) => {
          if (line.includes('"ready"')) resolve()
        })
        proc.on('close', (code) => reject(new Error('child exited ' + code + '\n' + err)))
      })
      const exited = new Promise<void>((resolve) => proc.on('close', () => resolve()))
      return {
        ready,
        async stop() {
          proc.kill('SIGTERM')
          await Promise.race([exited, sleep(5_000)])
          proc.kill('SIGKILL')
          children.delete(proc)
        },
      }
    }

    // Two processes, each a pool with pollMs 5000, drain 20 tasks (10 roots and 10 that need one).
    const drain = async (wake: boolean) => {
      const schema = 'nc_board_wake_' + (wake ? 'on_' : 'off_') + process.pid
      schemas.push(schema)
      const scope = 'wake'
      const sql = Sql.open(url, { schema })
      const board = await Board.open({ sql, scope, actor: 'agent:parent' })
      const granted = await board.grant(
        { who: [{ kind: 'kind', id: 'agent' }], can: { '*': ['manage'] } },
        { key: 'grant-agents' },
      )
      assert.ok(granted.ok, JSON.stringify(granted))
      const workers = ['left', 'right'].map((actor) => start({ url, schema, scope, actor, wake }))
      await Promise.all(workers.map((worker) => worker.ready))
      const ids = Array.from({ length: count }, (_, index) => 't' + index)
      const started = Date.now()
      for (const [index, id] of ids.entries()) {
        const needs = index < count / 2 ? [] : ['t' + (index - count / 2)]
        assert.ok((await board.post({ id, spec: 'task ' + index, needs })).ok)
      }
      let finished = 0
      while (finished < count) {
        assert.ok(Date.now() - started < 3 * pollMs, 'drain timed out at ' + finished)
        await sleep(10)
        await board.refresh()
        finished = 0
        for (const id of ids) if ((await board.task(id))?.phase === 'done') finished++
      }
      const elapsed = Date.now() - started
      await Promise.all(workers.map((worker) => worker.stop()))
      await board.close()
      await sql.close()
      return elapsed
    }

    describe('Board.pool wake over Postgres', { timeout: 120_000 }, () => {
      test('with wake two processes drain 20 tasks well under pollMs', async () => {
        const elapsed = await drain(true)
        process.stdout.write('# wake drain ' + elapsed + ' ms\n')
        assert.ok(elapsed < pollMs / 5, 'drained in ' + elapsed + ' ms')
      })

      test('without wake the same drain waits for the next poll', async () => {
        const elapsed = await drain(false)
        process.stdout.write('# poll drain ' + elapsed + ' ms\n')
        assert.ok(elapsed > pollMs / 2, 'drained in ' + elapsed + ' ms')
      })
    })
  }
}
