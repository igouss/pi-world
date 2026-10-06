/**
 * The wire contract of the REST API and the WebSocket, shared by the cells and the web UI.
 * Everything here is plain JSON.
 */
import type { Check } from "../check/check.ts";
import type { CatalogueEntry, Outcome } from "../world/world-vm.ts";

export type { Check, RemovedCheck } from "../check/check.ts";
export type { ChecksState } from "../revision/documents.ts";
export type { Revision } from "../revision/revision.ts";
export type { DataRow } from "../world/data-port.ts";
export type { DevelopResult } from "../world/world.ts";

export interface WorldListing {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;
}

export type FunctionInfo = CatalogueEntry;

export interface WorldSummary {
	readonly id: string;
	readonly name: string;
	readonly revision: number;
	readonly functions: readonly FunctionInfo[];
	readonly checks: readonly Check[];
	readonly hasApp: boolean;
	readonly model: string;
}

/** A direct call's or an evaluation's result; `failure` says why it failed. */
export type CallResult = Outcome;

export interface ToolCallItem {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
}

export type TranscriptItem =
	| { readonly kind: "user"; readonly id: number; readonly text: string; readonly at: number }
	| {
			readonly kind: "assistant";
			readonly id: number;
			readonly text: string;
			readonly thinking: string;
			readonly toolCalls: readonly ToolCallItem[];
			readonly error?: string;
			readonly at: number;
	  }
	| { readonly kind: "tool"; readonly id: number; readonly callId: string; readonly name: string; readonly text: string; readonly isError: boolean }
	| { readonly kind: "notice"; readonly id: number; readonly text: string };

export interface LiveTool {
	readonly callId: string;
	readonly name: string;
	readonly status: "pending" | "running" | "done";
	readonly output: string;
}

export interface Transcript {
	readonly items: readonly TranscriptItem[];
	readonly busy: boolean;
	/** The answer being streamed, if any. */
	readonly streaming?: { readonly text: string; readonly thinking: string; readonly toolCalls: readonly ToolCallItem[] };
	readonly retry?: { readonly at: number; readonly error: string };
	readonly tools: readonly LiveTool[];
	readonly queued: number;
}

export type ServerFrame =
	| { readonly type: "transcript"; readonly transcript: Transcript }
	| { readonly type: "world"; readonly world: WorldSummary };

export interface AccountStatus {
	readonly state: "none" | "oauth" | "token";
	readonly expires?: number;
	readonly pendingLogin: boolean;
}

export const MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5", "claude-fable-5-1"];
export const DEFAULT_MODEL: string = "claude-sonnet-5-5";
