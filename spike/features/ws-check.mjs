// Hibernatable vs regular WebSockets on a celld node: survival across hibernation, and how long each cell takes to
// adopt a new deployment while its socket stays open. Usage: node ws-check.mjs <phase> where phase is idle or deploy.
const base = "127.0.0.1:8795";
const phase = process.argv[2];

function open(cell, path) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://${base}/cell/${cell}/${path}`);
		const replies = [];
		let waiter;
		ws.onmessage = (event) => {
			replies.push(String(event.data));
			waiter?.();
		};
		ws.onopen = () =>
			resolve({
				ws,
				async ask(text, ms = 5000) {
					const before = replies.length;
					ws.send(text);
					await new Promise((done) => {
						waiter = done;
						setTimeout(done, ms);
					});
					return replies.length > before ? replies[replies.length - 1] : `no reply (socket state ${ws.readyState})`;
				},
			});
		ws.onerror = reject;
	});
}

const version = async (cell) => (await (await fetch(`http://${base}/cell/${cell}/version`)).json()).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

const hib = await open(`wsh-${phase}`, "ws-hib");
const reg = await open(`wsr-${phase}`, "ws-regular");
console.log(stamp(), "hib:", await hib.ask("a"), "| regular:", await reg.ask("a"));

if (phase === "idle") {
	await sleep(12_000);
	console.log(stamp(), "after 12 s idle (eviction after 5 s): hib:", await hib.ask("b"), "| regular:", await reg.ask("b"));
	const log = await (await fetch(`http://${base}/cell/wsh-${phase}/log`)).json();
	console.log("hib cell log:", log.map((r) => r.what).join(", "));
	const rlog = await (await fetch(`http://${base}/cell/wsr-${phase}/log`)).json();
	console.log("regular cell log:", rlog.map((r) => r.what).join(", "));
}

if (phase === "deploy") {
	console.log(stamp(), "ready: deploy version 2 now");
	const started = Date.now();
	const seen = {};
	while (Object.keys(seen).length < 2 && Date.now() - started < 150_000) {
		for (const [name, cell] of [["hib", `wsh-${phase}`], ["regular", `wsr-${phase}`]]) {
			if (!seen[name] && (await version(cell)) === "2") seen[name] = Date.now();
		}
		await sleep(250);
	}
	const first = Math.min(...Object.values(seen));
	for (const [name, at] of Object.entries(seen)) console.log(`${name} cell on v2 ${((at - first) / 1000).toFixed(1)} s after the first`);
	console.log(stamp(), "after deploy: hib:", await hib.ask("c"), "| regular:", await reg.ask("c"));
}
process.exit(0);
