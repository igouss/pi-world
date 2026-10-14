import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";

interface Sent {
	readonly url: string;
	readonly method: string;
	readonly body: unknown;
	readonly contentType: string | undefined;
}

/** A fetch that records each request and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown): { readonly fetcher: typeof fetch; readonly sent: Sent[] } {
	const sent: Sent[] = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		const contentType: string | undefined = (init.headers as Record<string, string>)["content-type"];
		sent.push({ url, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(String(init.body)), contentType });
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
	return { fetcher, sent };
}

/** A fetch that answers every request with `status` and the raw `text`. */
function rawFetch(status: number, text: string, statusText: string = ""): typeof fetch {
	return (async () => new Response(text, { status, statusText })) as typeof fetch;
}

describe("the API client", () => {
	it("sends a call to the server it was made for, with the arguments as JSON", async () => {
		const { fetcher, sent } = fakeFetch(200, { ok: true, value: 3 });
		const result = await createClient("http://node:8787", fetcher).call("kit-e9911c", "add one", [2]);
		expect(result).toEqual({ ok: true, value: 3 });
		expect(sent).toEqual([{ url: "http://node:8787/api/worlds/kit-e9911c/call/add%20one", method: "POST", body: { args: [2] }, contentType: "application/json" }]);
	});

	it("uses the page's own origin when its base is empty", async () => {
		const { fetcher, sent } = fakeFetch(200, []);
		await createClient("", fetcher).worlds();
		expect(sent).toEqual([{ url: "/api/worlds", method: "GET", body: undefined, contentType: undefined }]);
	});

	it("throws the server's error for a failing status", async () => {
		const { fetcher } = fakeFetch(404, { error: "no world nope" });
		await expect(createClient("", fetcher).world("nope")).rejects.toThrow("no world nope");
	});

	it("returns a refusal the server answers with a failing status but no error, so the caller reads its reason", async () => {
		const refusal = { status: "refused", rejection: { reason: "never seen failing" } };
		const { fetcher } = fakeFetch(422, refusal);
		await expect(createClient("", fetcher).proposeCheck("w", { name: "n", expression: "true", counterexample: "" })).resolves.toEqual(refusal);
	});

	it("gives each message a fresh request id, so only a retry of the same send is deduplicated", async () => {
		const { fetcher, sent } = fakeFetch(200, { submission: 1 });
		const client = createClient("", fetcher);
		await client.send("w", "hello");
		await client.send("w", "hello");
		const [first, second] = sent.map((s) => (s.body as { requestId: string }).requestId);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(second).not.toBe(first);
	});

	it("develops a source with its summary", async () => {
		const { fetcher, sent } = fakeFetch(200, { status: "accepted" });
		await createClient("", fetcher).develop("w", "function f() {}", "add f");
		expect(sent[0]).toMatchObject({ url: "/api/worlds/w/develop", method: "POST", body: { source: "function f() {}", summary: "add f" } });
	});

	it("proposes a check with its generator as an object", async () => {
		const { fetcher, sent } = fakeFetch(200, { status: "enrolled" });
		await createClient("", fetcher).proposeCheck("w", { name: "n", expression: "f(input)", counterexample: "x", generator: { int: [0, 9] } });
		expect(sent[0]).toMatchObject({ url: "/api/worlds/w/checks", method: "POST", body: { name: "n", generator: { int: [0, 9] } } });
	});

	it("encodes a data prefix and a check name into the path", async () => {
		const { fetcher, sent } = fakeFetch(200, []);
		const client = createClient("", fetcher);
		await client.data("w", "link:a b");
		await client.removeCheck("w", "no loss/ever", "obsolete");
		expect(sent).toMatchObject([
			{ url: "/api/worlds/w/data?prefix=link%3Aa%20b", method: "GET" },
			{ url: "/api/worlds/w/checks/no%20loss%2Fever", method: "DELETE", body: { reason: "obsolete" } },
		]);
	});

	it("pages a newest-first list below a number", async () => {
		const { fetcher, sent } = fakeFetch(200, []);
		const client = createClient("", fetcher);
		await client.rejections("w");
		await client.rejections("w", 7);
		expect(sent.map((s) => s.url)).toEqual(["/api/worlds/w/rejections", "/api/worlds/w/rejections?before=7"]);
	});

	it("returns a failed call with its failure and incident, not an error", async () => {
		const failed = { ok: false, failure: "threw", error: "TypeError: boom", incident: 4 };
		const { fetcher } = fakeFetch(422, failed);
		await expect(createClient("", fetcher).call("w", "f", [])).resolves.toEqual(failed);
	});

	it("throws a failing status whose body names no error, with the status", async () => {
		await expect(createClient("", rawFetch(500, "{}")).worlds()).rejects.toThrow("HTTP 500");
	});

	it("throws a body that is not JSON with the status and the start of the body", async () => {
		await expect(createClient("", rawFetch(502, "<html>Bad Gateway</html>", "Bad Gateway")).worlds()).rejects.toThrow(
			"HTTP 502 Bad Gateway: <html>Bad Gateway</html>",
		);
	});

	it("throws a successful status whose body is not JSON", async () => {
		await expect(createClient("", rawFetch(200, "OK")).worlds()).rejects.toThrow("HTTP 200: OK");
	});

	it("throws a failing status whose body is JSON null, with the status", async () => {
		await expect(createClient("", rawFetch(500, "null")).worlds()).rejects.toThrow("HTTP 500");
	});

	it("cuts a long body that is not JSON to its first 200 characters", async () => {
		const page: string = `<html>${"x".repeat(300)}</html>`;
		await expect(createClient("", rawFetch(502, page)).worlds()).rejects.toThrow(new Error(`HTTP 502: ${page.slice(0, 200)}`));
	});

	it("drops a trailing slash from its base", async () => {
		const { fetcher, sent } = fakeFetch(200, []);
		await createClient("http://node:8787/", fetcher).worlds();
		expect(sent[0]?.url).toBe("http://node:8787/api/worlds");
	});
});
