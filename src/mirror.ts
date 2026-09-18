import { diag } from "@opentelemetry/api";

type ExportResult = { code: number; error?: Error };
type Exporter = {
	export(spans: unknown[], callback: (result: ExportResult) => void): void;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
};

/**
 * Preserve the concrete primary exporter (the upstream batch processor owns it)
 * while sending each already-sanitized batch to the other configured collectors.
 * Each HTTP exporter owns its retries, timeout and concurrency limit. A slow or
 * failed secondary must never hold the primary's callback or cause it to resend.
 * Lifecycle methods still wait for every destination, including pending mirrors.
 */
export function mirrorExports<E>(primary: E, additional: E[]): E {
	if (additional.length === 0) return primary;
	const exporter = primary as unknown as Exporter;
	const mirrors = additional as unknown as Exporter[];
	const send = exporter.export.bind(primary);
	const report = (result: ExportResult) => {
		if (result.code !== 0)
			diag.error("[onepatch/rum] additional trace export failed", result.error);
	};
	exporter.export = (spans, callback) => {
		for (const mirror of mirrors) {
			try {
				mirror.export(spans, report);
			} catch (error) {
				report({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
			}
		}
		send(spans, callback);
	};
	for (const method of ["forceFlush", "shutdown"] as const) {
		const original = exporter[method].bind(primary);
		exporter[method] = async () => {
			const results = await Promise.allSettled([
				Promise.resolve().then(original),
				...mirrors.map((mirror) => Promise.resolve().then(() => mirror[method]())),
			]);
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		};
	}
	return primary;
}
