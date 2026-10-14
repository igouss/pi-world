/** The node this project's fleet serves from: the default for `pw`, `sync-beads` and `deploy`. */
const NODE: string = "http://oracle-arm.mist-walleye.ts.net:8787";

/** The server to talk to: `PW_SERVER`, else the node, without a trailing slash. */
export function serverFromEnv(): string {
	return (process.env.PW_SERVER ?? NODE).replace(/\/$/, "");
}
