import * as hdr from "hdr-histogram-js";

/** Latencies in microseconds, from 1 µs to 10 minutes, at three significant digits. */
const LOWEST_US: number = 1;
const HIGHEST_US: number = 600_000_000;
const DIGITS: 3 = 3;

export interface Percentiles {
	readonly count: number;
	readonly minMs: number;
	readonly p50Ms: number;
	readonly p90Ms: number;
	readonly p99Ms: number;
	readonly p999Ms: number;
	readonly maxMs: number;
	readonly meanMs: number;
}

/** An HdrHistogram of latencies, recorded in microseconds and reported in milliseconds. */
export class Latencies {
	private readonly histogram: hdr.Histogram = hdr.build({
		lowestDiscernibleValue: LOWEST_US,
		highestTrackableValue: HIGHEST_US,
		numberOfSignificantValueDigits: DIGITS,
		bitBucketSize: 64,
		useWebAssembly: false,
	});

	recordMs(ms: number): void {
		this.histogram.recordValue(Math.min(HIGHEST_US, Math.max(LOWEST_US, Math.round(ms * 1000))));
	}

	add(other: Latencies): void {
		this.histogram.add(other.histogram);
	}

	get count(): number {
		return this.histogram.totalCount;
	}

	percentiles(): Percentiles {
		const h = this.histogram;
		const at = (p: number): number => (h.totalCount === 0 ? 0 : h.getValueAtPercentile(p) / 1000);
		return {
			count: h.totalCount,
			minMs: h.totalCount === 0 ? 0 : h.minNonZeroValue / 1000,
			p50Ms: at(50),
			p90Ms: at(90),
			p99Ms: at(99),
			p999Ms: at(99.9),
			maxMs: h.maxValue / 1000,
			meanMs: h.mean / 1000,
		};
	}

	/** The compressed, base64 HdrHistogram encoding, so a result can be re-analysed or merged later. */
	encode(): string {
		return hdr.encodeIntoCompressedBase64(this.histogram);
	}

	static decode(encoded: string): Latencies {
		const latencies = new Latencies();
		latencies.histogram.add(hdr.decodeFromCompressedBase64(encoded, 64, false));
		return latencies;
	}
}
