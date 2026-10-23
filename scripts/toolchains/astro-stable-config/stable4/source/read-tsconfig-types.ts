import type { TsConfigResult } from './types.js';

/** The synchronous consumer contract, with exact configs visited by extends. */
export type TsconfigResult = TsConfigResult & {
	/** Root first, then actual recursive traversal order; duplicates removed. */
	sources: string[];
};
