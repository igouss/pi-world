import { InvalidArgumentError } from "@commander-js/extra-typings";

/** An option's value as a whole number above zero; commander reports anything else as an invalid argument. */
export function positiveInteger(text: string): number {
	if (!/^[1-9][0-9]*$/.test(text)) throw new InvalidArgumentError(`not a positive whole number: ${text}`);
	return Number(text);
}
