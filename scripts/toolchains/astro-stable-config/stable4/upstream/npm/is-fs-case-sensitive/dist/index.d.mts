import fs from 'fs';

/**
 * Subset of Node.js fs module methods required for case-sensitivity detection.
 * This allows custom fs implementations to be passed for testing purposes.
 */
type FsSubset = {
    existsSync: typeof fs.existsSync;
    writeFileSync: typeof fs.writeFileSync;
    unlinkSync: typeof fs.unlinkSync;
};
/**
 * Detects whether the filesystem is case-sensitive.
 *
 * Uses a fast, I/O-free primary method that checks if the specified directory
 * path can be accessed with inverted case. Falls back to writing a temporary
 * file if the primary method is inconclusive.
 *
 * Different mount points can have different case-sensitivity settings, so this
 * function checks the filesystem where the specified directory resides.
 *
 * @param directoryPath - The directory path to check. Defaults to
 * `process.cwd()`. Different mount points can have different case-sensitivity.
 * @param fsInstance - Custom filesystem implementation (primarily for
 * testing). Defaults to Node.js `fs` module.
 * @param useCache - Whether to cache the result per directory. Defaults to
 * `true`. When enabled, subsequent calls for the same directory return
 * instantly without re-checking.
 * @returns `true` if the filesystem is case-sensitive, `false` otherwise
 *
 * @example
 * ```ts
 * import { isFsCaseSensitive } from 'is-fs-case-sensitive'
 *
 * // Check current working directory's filesystem
 * if (isFsCaseSensitive()) {
 *   console.log('Case-sensitive filesystem (likely Linux)')
 * } else {
 *   console.log('Case-insensitive filesystem (likely macOS/Windows)')
 * }
 *
 * // Check specific directory
 * const isHomeCaseSensitive = isFsCaseSensitive('/home/user')
 * ```
 */
declare const isFsCaseSensitive: (directoryPath?: string, fsInstance?: FsSubset, useCache?: boolean) => boolean;

export { isFsCaseSensitive };
