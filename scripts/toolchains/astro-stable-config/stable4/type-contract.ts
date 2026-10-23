import {
  readTsconfig, parseTsconfig, getTsconfig, findTsconfig,
  createPathsMatcher, createFilesMatcher,
  type TsconfigResult, type TsConfigResult, type TsConfigJsonResolved, type Cache,
} from '__PROVIDER__';
import type * as Canonical from './declarations/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Sync = Assert<Equal<ReturnType<typeof readTsconfig>, TsconfigResult>>;
type SourceContract = Assert<Equal<TsconfigResult, Canonical.TsconfigResult>>;
type StableConfig = Assert<Equal<TsConfigJsonResolved, Canonical.TsConfigJsonResolved>>;
type StableParse = Assert<Equal<typeof parseTsconfig, typeof Canonical.parseTsconfig>>;
const cache: Cache<string> = new Map<string, string>();
const result: TsconfigResult = readTsconfig('tsconfig.json', cache);
const stable: TsConfigResult = result;
const config: TsConfigJsonResolved = result.config;
const sources: string[] = result.sources;
const path: string = result.path;
// @ts-expect-error The synchronous contract must not become Promise-shaped.
const promise: Promise<TsconfigResult> = readTsconfig('tsconfig.json');
// @ts-expect-error Sources are mandatory on the additive consumer result.
const missing: TsconfigResult = { path: '', config: {} };
// @ts-expect-error Invalid cache values must not acquire an any overload.
readTsconfig('tsconfig.json', new Map<string, number>());
parseTsconfig(path, cache);
getTsconfig(path, 'tsconfig.json', cache);
findTsconfig(path, 'tsconfig.json', cache);
createPathsMatcher(stable);
createFilesMatcher(stable, true);
void [config, sources, promise, missing];
