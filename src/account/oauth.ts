/**
 * Claude Pro/Max OAuth, as pi does it: Claude Code's public client, PKCE, and the copy-code redirect, so login works
 * from a browser that is not on the server. Refresh rotates the refresh token.
 *
 * pi-ai has this flow, but loads it through a variable dynamic import that a Worker bundle cannot follow, and the
 * module also starts a `node:http` callback server. So the copy-code half is here, with pi-ai's constants.
 */
const CLIENT_ID: string = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL: string = "https://claude.ai/oauth/authorize";
const TOKEN_URL: string = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI: string = "https://platform.claude.com/oauth/code/callback";
const SCOPES: string = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** Refresh this long before the server's expiry. */
const EXPIRY_MARGIN_MS: number = 5 * 60 * 1000;

export interface OAuthCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
}

export interface Pkce {
	readonly verifier: string;
	readonly challenge: string;
}

export async function createPkce(): Promise<Pkce> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function authorizeUrl(pkce: Pkce): string {
	const params = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		state: pkce.verifier,
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Accepts what the copy-code page shows (`code#state`) or the whole redirect URL. */
export function parseAuthorization(input: string): { code?: string; state?: string } {
	const value = input.trim();
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// not a URL
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

export async function exchangeCode(code: string, state: string, verifier: string): Promise<OAuthCredential> {
	return tokenRequest({ grant_type: "authorization_code", client_id: CLIENT_ID, code, state, redirect_uri: REDIRECT_URI, code_verifier: verifier });
}

export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
	return tokenRequest({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credential.refresh });
}

export function isExpiring(credential: OAuthCredential, now: number): boolean {
	return now >= credential.expires;
}

async function tokenRequest(body: Record<string, string>): Promise<OAuthCredential> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Anthropic token endpoint answered ${response.status}: ${text.slice(0, 300)}`);
	const data = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
	return { type: "oauth", access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 - EXPIRY_MARGIN_MS };
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
