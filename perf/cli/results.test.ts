import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStamp } from "./paths.ts";
import { results, scenarioOf } from "./results.ts";

describe("results", () => {
	it("names the scenario of a file written with fileStamp, hyphens in the scenario's id included", () => {
		expect(scenarioOf(`slow-overload-${fileStamp(new Date("2026-10-14T01:28:18.123Z"))}.json`)).toBe("slow-overload");
	});

	it("keeps only the newest result of each scenario and target", () => {
		const root = mkdtempSync(join(tmpdir(), "perf-results-"));
		mkdirSync(join(root, "dev"));
		mkdirSync(join(root, "node"));
		const write = (kind: string, scenario: string, at: string) =>
			writeFileSync(join(root, kind, `${scenario}-${fileStamp(new Date(at))}.json`), JSON.stringify({ scenario, startedAt: at, verdicts: [] }));
		write("dev", "read-call", "2026-10-14T01:00:00Z");
		write("dev", "read-call", "2026-10-14T02:00:00Z");
		write("dev", "lost-update", "2026-10-14T01:30:00Z");
		write("node", "read-call", "2026-10-14T00:30:00Z");
		const picked = results([root]).map((r) => `${r.scenario}@${r.startedAt}`).sort();
		expect(picked).toEqual(["lost-update@2026-10-14T01:30:00Z", "read-call@2026-10-14T00:30:00Z", "read-call@2026-10-14T02:00:00Z"]);
	});
});
