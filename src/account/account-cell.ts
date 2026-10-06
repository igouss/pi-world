import { DurableObject } from "cloudflare:workers";
import type { AccountStatus } from "../api/types.ts";
import { authorizeUrl, createPkce, exchangeCode, isExpiring, parseAuthorization, refreshCredential, verifyToken, type OAuthCredential } from "./oauth.ts";

/** A token pasted by the owner, such as one from `claude setup-token`. It is not refreshed. */
interface PastedToken {
	readonly type: "token";
	readonly access: string;
}

type Credential = OAuthCredential | PastedToken;

interface PendingLogin {
	readonly verifier: string;
	readonly startedAt: number;
}

const LOGIN_WINDOW_MS: number = 15 * 60 * 1000;

/**
 * The one Claude subscription credential of the fleet. Worlds ask it for an access token before each model request;
 * it refreshes in one place, so two worlds never race to rotate the refresh token.
 */
export class AccountCell extends DurableObject {
	private refreshing: Promise<OAuthCredential> | undefined;

	async status(): Promise<AccountStatus> {
		const credential = await this.credential();
		const pending = await this.pending();
		return {
			state: credential?.type ?? "none",
			...(credential?.type === "oauth" ? { expires: credential.expires } : {}),
			pendingLogin: pending !== undefined,
		};
	}

	async startLogin(): Promise<{ url: string }> {
		const pkce = await createPkce();
		await this.ctx.storage.put("pending", { verifier: pkce.verifier, startedAt: Date.now() } satisfies PendingLogin);
		return { url: authorizeUrl(pkce) };
	}

	async finishLogin(input: string): Promise<AccountStatus> {
		const pending = await this.pending();
		if (!pending) throw new Error("no login in progress; start one first");
		const { code, state } = parseAuthorization(input);
		if (!code) throw new Error("that does not look like an authorization code");
		if (state && state !== pending.verifier) throw new Error("the code belongs to a different login attempt; start again");
		const credential = await exchangeCode(code, state ?? pending.verifier, pending.verifier);
		await this.ctx.storage.put("credential", credential);
		await this.ctx.storage.delete("pending");
		return this.status();
	}

	async setToken(token: string): Promise<AccountStatus> {
		const access = token.trim();
		if (!access.startsWith("sk-ant-")) throw new Error("expected a token starting with sk-ant-");
		await verifyToken(access);
		await this.ctx.storage.put("credential", { type: "token", access } satisfies PastedToken);
		await this.ctx.storage.delete("pending");
		return this.status();
	}

	async logout(): Promise<void> {
		await this.ctx.storage.delete(["credential", "pending"]);
	}

	/** A usable access token, refreshed first when it is about to expire. */
	async accessToken(): Promise<string> {
		const credential = await this.credential();
		if (!credential) throw new Error("not logged in to Claude: open the web UI and log in");
		if (credential.type === "token" || !isExpiring(credential, Date.now())) return credential.access;
		this.refreshing ??= refreshCredential(credential)
			.then(async (next) => {
				await this.ctx.storage.put("credential", next);
				return next;
			})
			.finally(() => {
				this.refreshing = undefined;
			});
		return (await this.refreshing).access;
	}

	private async credential(): Promise<Credential | undefined> {
		return this.ctx.storage.get<Credential>("credential");
	}

	private async pending(): Promise<PendingLogin | undefined> {
		const pending = await this.ctx.storage.get<PendingLogin>("pending");
		return pending && Date.now() - pending.startedAt < LOGIN_WINDOW_MS ? pending : undefined;
	}
}
