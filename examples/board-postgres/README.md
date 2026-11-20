# Board over Postgres, across processes

[index.ts](index.ts) is a lead, and [worker.ts](worker.ts) is a worker. They share one board in Postgres through `nanocode-ts/postgres`, as processes on separate machines would. Every process opens its own connection pool with `Sql.open(DATABASE_URL, { schema, max: 2 })` and its own actor (`agent:lead`, `agent:w1` and so on), and they meet only in the database.

The lead charters the board, lets every `agent:` actor in, and posts a small graph: `plan`, then three fetches labelled `agent=llm`, then `summarize`. It starts three worker processes. Each runs one `Board.pool` with `concurrency: 1`, a 1.5 s lease and `cap: { max: 2, label: ['agent', 'llm'] }`, so at most two fetches are held at once across all three processes.

When a worker starts `fetch-b`, the lead waits 300 ms and kills it with SIGKILL. The process gets no chance to release its claim, so `fetch-b` stays held until its lease lapses. Another worker then claims it and its lease reports `tookOver: true`. Once `summarize` is held, the lead steers it, and its worker reads the steer and heeds it before finishing. The lead then stops the surviving workers and prints a timeline, the worker each task finished under (`Task.worker`) and each pool's counts. It works in a fresh schema and drops it at the end.

## Run it

It needs `DATABASE_URL` pointing at a Postgres database it may create a schema in. Start a throwaway Postgres 16 in a temp directory from its binaries (the path is Debian and Ubuntu's; Homebrew puts them under `$(brew --prefix postgresql@16)/bin`):

```sh
BIN=/usr/lib/postgresql/16/bin
PG=$(mktemp -d)
$BIN/initdb -D "$PG/data" -U postgres -A trust
$BIN/pg_ctl -D "$PG/data" -l "$PG/log" -w start \
  -o "-c listen_addresses=127.0.0.1 -c port=54329 -c unix_socket_directories=$PG"
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm run example:board-postgres
$BIN/pg_ctl -D "$PG/data" -m fast stop && rm -rf "$PG"
```

Or with Docker:

```sh
docker run --rm -d --name board-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 postgres:16
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm run example:board-postgres
docker stop board-pg
```

Run `npm install` first, which fills `dist/`. worker.ts takes its URL, schema, scope and name as one JSON argument, so the same file can run on another machine against the same server.

## Output

This output is from Node 22.23 and Postgres 16.15 on Linux:

```text
+  113ms  lead  post   plan
+  115ms  lead  post   fetch-a
+  116ms  lead  post   fetch-b
+  117ms  lead  post   fetch-c
+  118ms  lead  post   summarize
+  379ms  w1    start  plan
+  580ms  w1    done   plan
+  586ms  w1    start  fetch-a
+  618ms  w2    start  fetch-b
+  917ms  lead  kill   w2 (SIGKILL) while it holds fetch-b
+ 1587ms  w1    done   fetch-a
+ 1590ms  w1    start  fetch-c
+ 2122ms  lead  lapse  fetch-b: its lease ran out
+ 2145ms  w3    start  fetch-b (took over)
+ 2591ms  w1    done   fetch-c
+ 3145ms  w3    done   fetch-b
+ 3151ms  w3    start  summarize
+ 3160ms  lead  steer  summarize
+ 3952ms  w3    steer  summarize: keep it to two lines
+ 3954ms  w3    done   summarize
+ 3959ms  lead  peak   2 agent=llm tasks held at once (cap 2)

plan       done  agent:w1  {"done":"w1 finished plan"}
fetch-a    done  agent:w1  {"done":"w1 finished fetch-a"}
fetch-b    done  agent:w3  {"done":"w3 finished fetch-b"}
fetch-c    done  agent:w1  {"done":"w1 finished fetch-c"}
summarize  done  agent:w3  {"done":"w3 finished summarize"}

w1 claimed 3, done 3, lost 0, steers 0, errors 0
w2 killed
w3 claimed 2, done 2, lost 0, steers 1, errors 0
```

w2 is killed 300 ms into `fetch-b` and its lease runs out about 1.2 s later. w3 takes the task over and finishes it, and `fetch-b` ends up with `agent:w3` as its worker. The cap shows while w2's claim is still live: w1 and the dead w2 hold two `agent=llm` tasks, so w3 sits idle with `fetch-c` ready until `fetch-a` is done. The steer is sent while w3 holds `summarize`, and it is heeded before the finish. Which worker gets which task changes from run to run, and the `lapse` line shows only when one of the lead's polls lands between the lapse and the takeover.
