#!/bin/sh
# Model-check every configuration of WorldConcurrency and compare each result with the one expected of it.
# Exits non-zero when any result differs. Logs go to $TLA_OUT (default: a fresh temporary directory).
set -u

here=$(cd "$(dirname "$0")" && pwd)
out=${TLA_OUT:-$(mktemp -d)}
mkdir -p "$out"
command -v tlc >/dev/null || { echo "tlc not found on PATH (TLA+ tools)" >&2; exit 2; }

# config, expected result ("green", "invariant:<name>", "action:<name>", "temporal" or "deadlock"), extra TLC flags
expectations='
deployed                        green
deployed-wait                   green
deployed-event-loop             green
deployed-liveness               green
deployed-pool-vm-count          green
deployed-p5-await               invariant:NoLostUpdate
deployed-p5-noawait             invariant:NoLostUpdate
deployed-p5-serializable        invariant:Serializable
fixed                           green
fixed-wait                      green
fixed-p5                        green
fixed-p5-noawait                green
fixed-liveness                  green
fixed-readonly                  green
deployed-readonly               invariant:ReadsExisted
bug-partial-commit              invariant:WritesAllOrNone
bug-partial-commit-rows         invariant:RowsFromOneCommit
bug-commit-on-failure           invariant:FailedWritesNothing
bug-commit-before-blob          invariant:HeadBlobPresent
bug-unguarded-commit            invariant:OneCommitPerRevision
bug-unguarded-accepted          invariant:AcceptedKept
bug-unguarded-history           action:HistoryKept
bug-unguarded-main              invariant:MainAtHead
bug-head-before-commit          invariant:CallsOnCommittedHeaps
bug-head-before-commit-current  invariant:CurrentIsCommitted
bug-main-vm                     invariant:CallsOnCommittedHeaps
bug-slot-off-by-one             invariant:SlotsBounded
bug-idle-any-revision           invariant:HandedAtAskedRevision
bug-no-free                     invariant:SlotsBounded
bug-free-drops-waiter           temporal                         -deadlock
fixed-bug-partial-commit        invariant:WritesAllOrNone
fixed-bug-commit-on-failure     invariant:FailedWritesNothing
fixed-bug-commit-before-blob    invariant:HeadBlobPresent
fixed-bug-unguarded-commit      invariant:OneCommitPerRevision
fixed-bug-head-before-commit    invariant:CallsOnCommittedHeaps
fixed-bug-main-vm               invariant:CallsOnCommittedHeaps
fixed-bug-idle-any-revision     invariant:HandedAtAskedRevision
fixed-bug-no-free               invariant:SlotsBounded
fixed-bug-skip-readonly-validation invariant:ReadsExisted
fixed-bug-workbench-trusts-vm   invariant:WorkbenchAtHead
fixed-bug-no-validate           invariant:NoLostUpdate
fixed-bug-no-validate-serial    invariant:Serializable
fixed-bug-conflict-commits      invariant:ConflictWritesNothing
fixed-bug-timeout-keeps-waiter  invariant:RefusedNeverGranted
fixed-bug-timeout-no-grant      temporal                         -deadlock
'

# Every .cfg must have an expectation, so a new configuration is never skipped silently.
for cfg in "$here"/*.cfg; do
	name=$(basename "$cfg" .cfg)
	echo "$expectations" | awk -v n="$name" '$1 == n { found = 1 } END { exit !found }' || { echo "no expectation for $name.cfg" >&2; exit 2; }
done

rm -f "$out/failures"
printf '%-31s %-9s %-21s %-36s %12s %12s %6s %6s\n' config version bug result generated distinct trace secs
echo "$expectations" | while read -r name expected flags; do
	[ -n "$name" ] || continue
	log="$out/$name.log"
	started=$(date +%s)
	(cd "$here" && tlc -workers 1 ${flags:-} -metadir "$out/meta-$name" -config "$name.cfg" WorldConcurrency) >"$log" 2>&1
	secs=$(( $(date +%s) - started ))
	if grep -q 'Model checking completed. No error has been found.' "$log"; then
		result=green
	elif line=$(grep -m1 -E '^Error: Invariant [A-Za-z0-9_]+ is violated' "$log"); then
		result="invariant:$(echo "$line" | sed -E 's/^Error: Invariant ([A-Za-z0-9_]+) is violated.*/\1/')"
	elif line=$(grep -m1 -E '^Error: Action property [A-Za-z0-9_]+ is violated' "$log"); then
		result="action:$(echo "$line" | sed -E 's/^Error: Action property ([A-Za-z0-9_]+) is violated.*/\1/')"
	elif grep -q '^Error: Temporal properties were violated' "$log"; then
		result=temporal
	elif grep -q '^Error: Deadlock reached' "$log"; then
		result=deadlock
	else
		result="error(see $log)"
	fi
	bug=$(sed -n -E 's/^ *Bug = "([^"]*)".*/\1/p' "$here/$name.cfg")
	version=$(sed -n -E 's/^ *Version = "([^"]*)".*/\1/p' "$here/$name.cfg")
	counts=$(grep -E '^[0-9]+ states generated, [0-9]+ distinct states found' "$log" | tail -1)
	generated=$(echo "$counts" | sed -E 's/^([0-9]+) states generated.*/\1/')
	distinct=$(echo "$counts" | sed -E 's/^[0-9]+ states generated, ([0-9]+) distinct.*/\1/')
	trace=$(grep -c -E '^State [0-9]+:' "$log")
	mark=""
	[ "$result" = "$expected" ] || { mark="  EXPECTED $expected"; echo "$name" >>"$out/failures"; }
	printf '%-31s %-9s %-21s %-36s %12s %12s %6s %6s%s\n' "$name" "$version" "$bug" "$result" "${generated:--}" "${distinct:--}" "$trace" "$secs" "$mark"
done

echo "logs: $out"
if [ -s "$out/failures" ]; then
	echo "results differ from expectations: $(tr '\n' ' ' <"$out/failures")" >&2
	exit 1
fi
