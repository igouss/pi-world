import { useState } from "preact/hooks";

/**
 * Run a UI action and keep its error message for display. `run` returns an event handler, so a form's onSubmit and a
 * button's onClick share one path; the error clears when the action starts again.
 */
export function useAction(): { error: string; run: (action: () => Promise<void>) => (event?: Event) => Promise<void> } {
	const [error, setError] = useState("");
	const run = (action: () => Promise<void>) => async (event?: Event) => {
		event?.preventDefault();
		setError("");
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	return { error, run };
}
