import argparse, json, os, re, threading, time, urllib.error, urllib.parse, urllib.request, uuid

ENDED_BADLY = ("failed", "cancelled", "interrupted")
PARTITIONED = re.compile(r"^pyramid2_(partition|node|turns|lease|board)")


def http(method, url, token, body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"authorization": "Bearer " + token, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        payload, status = error.read(), error.code
    try:
        return status, json.loads(payload or b"null")
    except ValueError:
        return status, payload.decode(errors="replace")


def pct(values, p):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * p / 100))], 1)


def dist(values):
    return {"n": len(values), "p50": pct(values, 50), "p95": pct(values, 95), "p99": pct(values, 99),
            "max": round(max(values), 1) if values else None}


def scrape(ops):
    try:
        with urllib.request.urlopen(ops + "/metrics", timeout=10) as response:
            text = response.read().decode(errors="replace")
    except OSError as error:
        return {"error": str(error)}
    out = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, _, value = line.rpartition(" ")
        if PARTITIONED.match(key.split("{", 1)[0]):
            try:
                out[key] = float(value)
            except ValueError:
                pass
    return out


GAUGES = re.compile(r"^pyramid2_(turns_active|lease_epoch|lease_phase)")


def delta(before, after):
    # Counters as after - before; gauges as [before, after] (a gauge delta such as turns_active 7 -> 0 is not
    # the gauge going negative).
    out = {}
    for node in after:
        b, a = before.get(node, {}), after[node]
        out[node] = {k: ([b.get(k), v] if GAUGES.match(k.split("{", 1)[0]) else round(v - b.get(k, 0), 3))
                     for k, v in a.items() if k != "error" and v != b.get(k, 0)}
        if "error" in a:
            out[node]["error"] = a["error"]
    return out


class Run:
    def __init__(self):
        self.lock = threading.Lock()
        self.errors, self.samples = {}, []
        self.ack, self.claim, self.root, self.spawn_to_child, self.child_run, self.child_total = [], [], [], [], [], []
        self.threads_by_node, self.turns_done, self.children_done = {}, 0, 0
        self.ends = []

    def error(self, kind, detail):
        with self.lock:
            self.errors[kind] = self.errors.get(kind, 0) + 1
            if len(self.samples) < 20:
                self.samples.append("%s: %s" % (kind, str(detail)[:300]))


class Swarm:
    def __init__(self, run, index, nodes, args):
        self.run, self.index, self.args = run, index, args
        self.order = nodes[index % len(nodes):] + nodes[:index % len(nodes)]
        self.cond = threading.Condition()
        self.frames, self.cursor, self.thread, self.turn = [], None, None, None
        self.dump = open(os.path.join(args.dump, "swarm-%d.jsonl" % index), "w") if args.dump else None

    def call(self, method, path, body=None):
        last = None
        for node in self.order:
            try:
                status, reply = http(method, node + "/v1" + path, self.args.token, body)
            except OSError as error:
                last = ("connect", error)
                continue
            if status >= 500:
                last = ("http_%d" % status, reply)
                continue
            return node, status, reply
        raise ConnectionError(last)

    def follow(self):
        attempt = 0
        while True:
            node = self.order[attempt % len(self.order)]
            attempt += 1
            query = "?" + urllib.parse.urlencode({"after": self.cursor}) if self.cursor else ""
            request = urllib.request.Request("%s/v1/threads/%s/events%s" % (node, self.thread, query), headers={
                "authorization": "Bearer " + self.args.token, "accept": "text/event-stream"})
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    cursor, data = None, []
                    for raw in response:
                        line = raw.decode().rstrip("\r\n")
                        if line.startswith("id:"):
                            cursor = line[3:].strip()
                        elif line.startswith("data:"):
                            data.append(line[5:].lstrip())
                        elif not line and data:
                            self.apply(cursor, json.loads("\n".join(data)))
                            cursor, data = None, []
            except (OSError, ValueError):
                pass
            time.sleep(min(1.0, 0.05 * attempt))

    def apply(self, cursor, frame):
        now = time.monotonic()
        with self.cond:
            self.frames.append((now, frame))
            if cursor:
                self.cursor = cursor
            self.cond.notify_all()
        if self.dump:
            self.dump.write(json.dumps({"t": now, "frame": frame}) + "\n")
            self.dump.flush()

    def root_end(self, start=0):
        status, answered = {}, set()
        for _, frame in self.frames[start:]:
            body = frame.get("data") or {}
            if frame.get("type") == "turn.updated" and body.get("id"):
                status[body["id"]] = body.get("status")
            elif frame.get("type") == "message.updated" and body.get("role") == "assistant" and body.get("turn_id"):
                answered.add(body["turn_id"])
        turn = next(iter(status), None)
        state = status.get(turn)
        if state in ENDED_BADLY or state == "succeeded" and turn in answered:
            return state
        return None

    def go(self, start):
        try:
            node, status, body = self.call("POST", "/threads", {"request_id": str(uuid.uuid4())})
        except ConnectionError as error:
            return self.run.error("create_unreachable", error)
        if status not in (200, 201) or not isinstance(body, dict):
            return self.run.error("create_http_%d" % status, body)
        self.thread = body["thread"]["id"]
        with self.run.lock:
            self.run.threads_by_node[node] = self.run.threads_by_node.get(node, 0) + 1
        threading.Thread(target=self.follow, daemon=True).start()
        start.wait()
        deadline = time.monotonic() + self.args.duration
        while self.once() and time.monotonic() < deadline:
            pass

    def once(self):
        self.turn = str(uuid.uuid4())  # request id; the server names the turn <thread>.<n>
        prompt = "e2e:swarm %d swarm-%s-%d" % (self.args.children, self.args.tag, self.index)
        with self.cond:
            first = len(self.frames)
        sent = time.monotonic()
        try:
            _, status, body = self.call("POST", "/threads/%s/turns" % self.thread, {"turn_id": self.turn, "input": prompt})
        except ConnectionError as error:
            return self.run.error("send_unreachable", error)
        if status not in (200, 201, 202):
            return self.run.error("send_http_%d" % status, body)
        acked = time.monotonic()
        with self.cond:
            self.cond.wait_for(lambda: self.root_end(first) or time.monotonic() > acked + self.args.wait_s,
                               timeout=self.args.wait_s + 1)
            ended = self.root_end(first)
            frames = self.frames[first:]
        if ended is None:
            return self.run.error("turn_timeout", self.thread)
        if ended != "succeeded":
            return self.run.error("turn_" + ended, self.thread)
        self.measure(sent, acked, frames)
        return True

    def measure(self, sent, acked, frames):
        # Server times (frame data "at", ms) where present; client receive times otherwise.
        running, posted, seen, settled = None, [], {}, {}
        for t, frame in frames:
            body = frame.get("data") or {}
            at = body.get("at") / 1000.0 if isinstance(body.get("at"), (int, float)) else None
            if frame.get("type") == "turn.updated" and body.get("status") == "running":
                running = running or t
            if frame.get("type") != "tool.updated":
                continue
            name, row, state = body.get("name"), str(body.get("id") or ""), body.get("status")
            if name == "spawn_agent" and state == "running":
                posted.append(at or t)
            if name == "subagent":
                if state == "running":
                    seen.setdefault(row, at or t)
                elif state == "succeeded":
                    settled.setdefault(row, at or t)
        ended = frames[-1][0]
        order = sorted(seen, key=lambda r: int(r.rsplit(":", 1)[1]) if r.rsplit(":", 1)[1].isdigit() else 0)
        with self.run.lock:
            self.run.ack.append((acked - sent) * 1000)
            if running:
                self.run.claim.append((running - sent) * 1000)
            self.run.root.append((ended - sent) * 1000)
            for i, row in enumerate(order):
                if i < len(posted):
                    self.run.spawn_to_child.append(max(0.0, seen[row] - posted[i]) * 1000)
                if row in settled:
                    self.run.child_run.append((settled[row] - seen[row]) * 1000)
            self.run.turns_done += 1
            self.run.children_done += len(settled)
            self.run.ends.append(ended)


def board_poll(node, token, stop, seen):
    after = 0
    status, body = http("GET", node + "/v1/board/events?after=0&limit=500", token)
    while status == 200 and isinstance(body, dict) and body.get("events"):
        after = body.get("last") or after
        status, body = http("GET", node + "/v1/board/events?after=%d&limit=500" % after, token)
    seen["start_seq"] = after
    while not stop.is_set():
        try:
            status, body = http("GET", node + "/v1/board/events?after=%d&limit=500" % after, token)
        except OSError:
            status, body = 0, None
        if status != 200 or not isinstance(body, dict):
            seen["errors"] = seen.get("errors", 0) + 1
            time.sleep(0.5)
            continue
        for event in body.get("events", []):
            kind = (event.get("change") or {}).get("kind")
            seen.setdefault("kinds", {})[kind] = seen.get("kinds", {}).get(kind, 0) + 1
        after = body.get("last") or after
        if not body.get("events"):
            time.sleep(0.25)
    seen["end_seq"] = after


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--nodes", required=True)
    parser.add_argument("--ops-offset", type=int, default=2)
    parser.add_argument("--swarms", type=int, required=True)
    parser.add_argument("--children", type=int, default=8)
    parser.add_argument("--wait-s", type=float, default=120)
    parser.add_argument("--duration", type=float, default=0, help="keep each slot running swarms for this many seconds")
    parser.add_argument("--tag", default=uuid.uuid4().hex[:8])
    parser.add_argument("--dump")
    args = parser.parse_args()
    with open(os.environ["PYRAMID2_TOKEN_FILE"]) as f:
        args.token = f.read().strip()
    nodes = args.nodes.split(",")
    ops = {n: re.sub(r":(\d+)$", lambda m: ":%d" % (int(m.group(1)) + args.ops_offset), n) for n in nodes}
    run, start, stop, board = Run(), threading.Event(), threading.Event(), {}
    swarms = [Swarm(run, i, nodes, args) for i in range(args.swarms)]
    workers = [threading.Thread(target=s.go, args=(start,), daemon=True) for s in swarms]
    for w in workers:
        w.start()
    poller = threading.Thread(target=board_poll, args=(nodes[0], args.token, stop, board), daemon=True)
    poller.start()
    time.sleep(2.0)
    before = {n: scrape(o) for n, o in ops.items()}
    t0 = time.monotonic()
    start.set()
    for w in workers:
        w.join(args.duration + args.wait_s + 60)
    elapsed = (max(run.ends) if run.ends else time.monotonic()) - t0
    time.sleep(1.0)
    stop.set()
    poller.join(5)
    after = {n: scrape(o) for n, o in ops.items()}
    turns = run.turns_done * (1 + args.children)
    print(json.dumps({
        "tag": args.tag, "swarms": args.swarms, "children": args.children, "nodes": nodes,
        "elapsed_s": round(elapsed, 2), "swarms_done": run.turns_done, "children_settled": run.children_done,
        "turns_per_s": round(turns / elapsed, 2) if elapsed > 0 else None,
        "swarms_per_s": round(run.turns_done / elapsed, 3) if elapsed > 0 else None,
        "ack_ms": dist(run.ack), "root_claim_ms": dist(run.claim), "spawn_to_child_ms": dist(run.spawn_to_child),
        "child_run_ms": dist(run.child_run), "root_turn_ms": dist(run.root),
        "threads_by_node": run.threads_by_node, "errors": run.errors, "error_samples": run.samples,
        "board": board, "metrics_delta": delta(before, after)}), flush=True)


if __name__ == "__main__":
    main()
