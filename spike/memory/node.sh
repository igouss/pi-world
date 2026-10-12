#!/bin/sh
# Measure the memory one world costs a deployed node: the celld process's resident set, read over ssh, before and after
# worlds that have each run a call. The worlds are named measure-N and are forgotten from the directory afterwards.
# Usage: sh spike/memory/node.sh BASE_URL SSH_HOST [WORLDS]
set -eu
base="$1"
host="$2"
count="${3:-10}"
rss() { ssh -o BatchMode=yes "$host" 'ps -o rss= -C celld | sort -n | tail -1' | tr -d ' '; }
ids=""
world() {
	id="$(curl -s -X POST -H 'content-type: application/json' -d "{\"name\":\"measure-$1\"}" "$base/api/worlds" | sed 's/.*"id":"\([^"]*\)".*/\1/')"
	curl -s -o /dev/null -X POST -H 'content-type: application/json' \
		-d '{"source":"function count(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }","summary":"count"}' "$base/api/worlds/$id/develop"
	curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"args":[1]}' "$base/api/worlds/$id/call/count"
	ids="$ids $id"
}
forget() {
	for id in $ids; do curl -s -o /dev/null -X DELETE "$base/api/worlds/$id"; done
}
trap forget EXIT
world 0
sleep 2
before="$(rss)"
i=1
while [ "$i" -le "$count" ]; do
	world "$i"
	i=$((i + 1))
done
sleep 2
after="$(rss)"
echo "celld RSS with 1 measured world: $((before / 1024)) MB; with $((count + 1)): $((after / 1024)) MB; per world: $(((after - before) / count)) KB"
