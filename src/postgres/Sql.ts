import postgres from 'postgres'
import type * as Contracts from '../Contracts.ts'

/** A Postgres database as a Contracts.SqlHost, shareable by processes on any number of machines. */
export type Host = Omit<Contracts.SqlHost, 'transaction'> & {
  /** The schema every statement runs in (its search_path), or undefined for the server's default. */
  readonly schema: string | undefined
  transaction(
    kind: Contracts.SqlKind,
    operation: string,
    statements: Contracts.Statement[],
    access?: Contracts.SqlAccess,
  ): Promise<Contracts.SqlValue[][][]>
  close(): Promise<void>
}

export type Options = {
  /** Runs every statement in this schema, creating it if missing (default: the server's search_path). */
  schema?: string
  /** Connections in this host's pool (default: postgres.js's). */
  max?: number
  /** The largest bound string or blob, in bytes, the runtime may store (default unlimited). */
  valueLimit?: number
  /** The shortest gap, in ms, between two nanocode_log notifications this host sends (default 10). */
  notifyMs?: number
}

const twins: ReadonlyMap<string, string> = new Map([
  [
    'CREATE TABLE IF NOT EXISTS nanocode_log (scope TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (scope, seq)) WITHOUT ROWID',
    'CREATE TABLE IF NOT EXISTS nanocode_log (scope TEXT NOT NULL, seq BIGINT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (scope, seq))',
  ],
  [
    "SELECT CAST(seq AS TEXT), body FROM nanocode_log WHERE scope = ?1 AND seq >= COALESCE((SELECT seq FROM nanocode_log INDEXED BY nanocode_log_snapshots WHERE scope = ?1 AND substr(body, 1, 1) = 's' ORDER BY seq DESC LIMIT 1), 0) ORDER BY seq",
    "SELECT CAST(seq AS TEXT), body FROM nanocode_log WHERE scope = $1::text AND seq >= COALESCE((SELECT seq FROM nanocode_log WHERE scope = $1::text AND substr(body, 1, 1) = 's' ORDER BY seq DESC LIMIT 1), 0) ORDER BY nanocode_log.seq",
  ],
  [
    'SELECT CAST(seq AS TEXT), body FROM nanocode_log WHERE scope = ?1 AND seq >= CAST(?2 AS INTEGER) AND seq < CAST(?3 AS INTEGER) ORDER BY seq',
    'SELECT CAST(seq AS TEXT), body FROM nanocode_log WHERE scope = $1::text AND seq >= CAST($2::text AS BIGINT) AND seq < CAST($3::text AS BIGINT) ORDER BY nanocode_log.seq',
  ],
  [
    'INSERT INTO nanocode_log (scope, seq, body) VALUES (?1, CAST(?2 AS INTEGER), ?3)',
    'INSERT INTO nanocode_log (scope, seq, body) VALUES ($1::text, CAST($2::text AS BIGINT), $3::text)',
  ],
  [
    'UPDATE nanocode_log SET body = ?3 WHERE scope = ?1 AND seq = CAST(?2 AS INTEGER)',
    'UPDATE nanocode_log SET body = $3::text WHERE scope = $1::text AND seq = CAST($2::text AS BIGINT)',
  ],
  [
    'UPDATE nanocode_log SET seq = CAST(?3 AS INTEGER), body = substr(CAST(body AS BLOB), 1, length(CAST(body AS BLOB)) - CAST(?4 AS INTEGER)) || ?5 WHERE scope = ?1 AND seq = CAST(?2 AS INTEGER) RETURNING CAST(seq AS TEXT)',
    'UPDATE nanocode_log SET seq = CAST($3::text AS BIGINT), body = substr(body, 1, length(body) - CAST($4::text AS INTEGER)) || $5::text WHERE scope = $1::text AND seq = CAST($2::text AS BIGINT) RETURNING CAST(seq AS TEXT)',
  ],
  [
    'DELETE FROM nanocode_log WHERE scope = ?1 AND seq >= CAST(?2 AS INTEGER) AND seq < CAST(?3 AS INTEGER)',
    'DELETE FROM nanocode_log WHERE scope = $1::text AND seq >= CAST($2::text AS BIGINT) AND seq < CAST($3::text AS BIGINT)',
  ],
])

const sqliteOnly = /\bWITHOUT\s+ROWID\b|\bINDEXED\s+BY\b|\bAS\s+BLOB\b|\bPRAGMA\b|\bINSERT\s+OR\b/i

/**
 * The Postgres text for a statement the runtime sent: nanocode's own Postgres twin of each
 * nanocode_log statement, else the statement with its ?N and ? placeholders numbered $N. Throws
 * on SQLite-only syntax that has no twin.
 */
export function translate(query: string): string {
  const twin = twins.get(query)
  if (twin !== undefined) return twin
  if (sqliteOnly.test(query))
    throw new Error('nanocode-ts/postgres: no Postgres form for SQLite statement: ' + query)
  let next = 0
  let out = ''
  let quote: string | undefined
  for (let index = 0; index < query.length; index++) {
    const char = query[index]!
    if (quote !== undefined) {
      out += char
      if (char === quote) quote = undefined
    } else if (char === "'" || char === '"') {
      quote = char
      out += char
    } else if (char !== '?') out += char
    else {
      let digits = ''
      while (/[0-9]/.test(query[index + 1] ?? '')) digits += query[++index]
      out += '$' + (digits === '' ? String(++next) : digits)
    }
  }
  return out
}

const schemaLock = "SELECT pg_advisory_xact_lock(hashtext('nanocode-ts/postgres schema'))"

/** The channel a host notifies, with its schema as the payload, after it commits a log write. */
export const channel = 'nanocode_log'

const logWrite = /^\s*(?:INSERT|UPDATE|DELETE)\b[^;]*\bnanocode_log\b/i

const connections = new WeakMap<Host, postgres.Sql>()

/**
 * Opens a pool of connections to the Postgres database at url. Writes run in READ COMMITTED
 * transactions, as nanocode's Postgres store does: the log's primary key fences appends, so a lost
 * race fails its transaction as on SQLite. Reads run in one REPEATABLE READ, READ ONLY snapshot.
 * Schema transactions serialize on an advisory lock.
 */
export function open(url: string, options: Options = {}): Host {
  const max = options.max
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1))
    throw new Error('max must be a positive integer')
  const valueLimit = options.valueLimit
  if (valueLimit !== undefined && (!Number.isSafeInteger(valueLimit) || valueLimit < 1))
    throw new Error('valueLimit must be a positive integer')
  const schema = options.schema
  if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema))
    throw new Error('schema must be a plain identifier, got ' + JSON.stringify(schema))
  const notifyMs = options.notifyMs ?? 10
  if (!Number.isFinite(notifyMs) || notifyMs < 0)
    throw new Error('notifyMs must be a non-negative number')

  const sql = postgres(url, {
    ...(max === undefined ? {} : { max }),
    onnotice: () => {},
    ...(schema === undefined ? {} : { connection: { search_path: '"' + schema + '"' } }),
  })
  let ready: Promise<unknown> | undefined =
    schema === undefined
      ? undefined
      : sql.begin(async (tx) => {
          await tx.unsafe(schemaLock)
          await tx.unsafe('CREATE SCHEMA IF NOT EXISTS "' + schema + '"')
        })
  const translated = new Map<string, string>()
  const text = (query: string) => {
    let found = translated.get(query)
    if (found === undefined) {
      found = translate(query)
      translated.set(query, found)
    }
    return found
  }

  // At most one notification per notifyMs: a burst of writes sends one at its start and one after.
  const payload = schema ?? ''
  let notified = 0
  let notifying: ReturnType<typeof setTimeout> | undefined
  const notify = () => {
    if (closed || notifying !== undefined) return
    notifying = setTimeout(
      () => {
        notifying = undefined
        if (closed) return
        notified = Date.now()
        sql`SELECT pg_notify(${channel}, ${payload})`.catch(() => {})
      },
      Math.max(0, notified + notifyMs - Date.now()),
    )
  }

  let closed = false
  const host: Host = {
    schema,
    ...(valueLimit === undefined ? {} : { value_limit: valueLimit }),
    async transaction(_kind, _operation, statements, access = 'write') {
      if (closed) throw new Error('the Postgres host for ' + redact(url) + ' is closed')
      if (ready !== undefined) await ready
      ready = undefined
      const mode = access === 'read' ? 'isolation level repeatable read read only' : ''
      const results = await sql.begin(mode, async (tx) => {
        if (access === 'schema') await tx.unsafe(schemaLock)
        const all: Contracts.SqlValue[][][] = []
        for (const [query, ...values] of statements) {
          const rows = await tx
            .unsafe(text(query), values.map(bind) as never[], { prepare: true })
            .values()
          all.push(rows.map((row) => (row as unknown[]).map(read)))
        }
        return all
      })
      if (access !== 'read' && statements.some(([query]) => logWrite.test(query))) notify()
      return results as unknown as Contracts.SqlValue[][][]
    },
    async close() {
      if (closed) return
      closed = true
      if (notifying !== undefined) clearTimeout(notifying)
      await sql.end({ timeout: 5 })
    },
  }
  connections.set(host, sql)
  return host
}

export type WakeOptions = {
  /** Notifications within this many ms of the first one wake the pool once, at its end (default 5). */
  debounceMs?: number
}

/**
 * A Board.pool wake for a host from open: LISTENs on the nanocode_log channel and calls notify
 * once per burst of log writes committed by any host on the same database and schema. A lost
 * connection is listened again and notifies once, since writes may have landed meanwhile; until
 * then the pool's pollMs still finds work. Returns the subscribe function PoolOptions.wake takes.
 */
export function wake(host: Host, options: WakeOptions = {}): (notify: () => void) => () => void {
  const sql = connections.get(host)
  if (sql === undefined) throw new Error('wake takes a host from nanocode-ts/postgres Sql.open')
  const debounceMs = options.debounceMs ?? 5
  if (!Number.isFinite(debounceMs) || debounceMs < 0)
    throw new Error('debounceMs must be a non-negative number')
  const payload = host.schema ?? ''
  return (notify) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const fire = () => {
      if (stopped || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (!stopped) notify()
      }, debounceMs)
    }
    const listening = sql
      .listen(channel, (value) => value === payload && fire(), fire)
      .catch(() => undefined)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      void listening.then((listened) => listened?.unlisten().catch(() => {}))
    }
  }
}

function bind(value: Contracts.SqlValue) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value
}

function read(value: unknown): Contracts.SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'bigint')
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Uint8Array)
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

function redact(url: string) {
  return url.replace(/\/\/[^@/]*@/, '//')
}
