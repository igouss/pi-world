#!/bin/sh
# Measure the memory one world costs a celld node: the server's resident set before and after worlds that have each
# run a call (so each has its own runtime isolate), and before and after one world runs 8 calls at once (8 VMs).
# Run from the repo root after `npm run build`: sh spike/memory/cell.sh [port]
set -eu
port="${1:-8797}"
base="http://127.0.0.1:$port"
log="$(mktemp)"
celld dev . --port "$port" >"$log" 2>&1 &
stop() {
	for pid in $(pgrep -f -- "127.0.0.1:$port"); do
		[ "$(cat "/proc/$pid/comm" 2>/dev/null)" = celld ] && kill "$pid"
	done
}
trap stop EXIT
until curl -s -o /dev/null "$base/api/version"; do sleep 1; done
server="$(pgrep -f -- "--no-control-plane .*--listen 127.0.0.1:$port" | head -1)"
rss() { awk '/VmRSS/ { print $2 }' "/proc/$server/status"; }
world() {
	id="$(curl -s -X POST -H 'content-type: application/json' -d "{\"name\":\"m$1\"}" "$base/api/worlds" | sed 's/.*"id":"\([^"]*\)".*/\1/')"
	curl -s -o /dev/null -X POST -H 'content-type: application/json' \
		-d '{"source":"define(\"count\", (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s; });","summary":"count"}' \
		"$base/api/worlds/$id/develop"
	curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"args":[1]}' "$base/api/worlds/$id/call/count"
	echo "$id"
}
world 0 >/dev/null
sleep 2
before="$(rss)"
for i in 1 2 3 4 5 6 7 8 9 10; do world "$i" >/dev/null; done
sleep 2
after="$(rss)"
echo "server RSS with 1 world: $((before / 1024)) MB; with 11: $((after / 1024)) MB; per world: $(((after - before) / 10)) KB"
# A world's calls share one single-threaded isolate, so 8 compute-bound calls would run one after another. Calls that
# await another world each hold a VM while they wait, so 8 of them keep 8 VMs alive at once.
slow="$(world slow)"
busy="$(world busy)"
curl -s -o /dev/null -X POST -H 'content-type: application/json' \
	-d "{\"source\":\"define(\\\"wait\\\", () => worlds.call(\\\"$slow\\\", \\\"count\\\", 30000000));\",\"summary\":\"wait\"}" \
	"$base/api/worlds/$busy/develop"
sleep 2
idle="$(rss)"
for i in 1 2 3 4 5 6 7 8; do
	curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"args":[]}' "$base/api/worlds/$busy/call/wait" &
done
sleep 4
peak="$(rss)"
echo "worlds waiting: $((idle / 1024)) MB; one world holding 8 calls: $((peak / 1024)) MB; per held call: $(((peak - idle) / 8)) KB"
stop
