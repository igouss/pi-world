/** One holder at a time, in arrival order. Keeps world operations from interleaving at their awaits. */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();

	run<T>(body: () => Promise<T>): Promise<T> {
		const result = this.tail.then(body);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
