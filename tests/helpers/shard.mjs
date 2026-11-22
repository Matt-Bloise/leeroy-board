// Sharding of the browser suites across CI jobs (preview-tests.yml, job `browser`, matrix). Pure functions, so tests/unit/browser-shards.test.mjs can pin them.
//   orderedSuites(files)         the suites in run order: live-smoke.mjs first, the rest by name (the order tests/browser/run.mjs always used)
//   parseShard(argv)             null when --shard is absent, else { index, count } from "--shard 1/4" (0-based index); throws on anything else
//   shardOf(list, index, count)  every count-th entry starting at index (round robin by position), so live-smoke (position 0) is the first suite of shard 0 and the shards together hold every suite exactly once
export function orderedSuites(files) {
  return [...files].sort((a, b) => (a === "live-smoke.mjs" ? -1 : b === "live-smoke.mjs" ? 1 : a.localeCompare(b)));
}
export function parseShard(argv) {
  const i = argv.indexOf("--shard");
  if (i < 0) return null;
  const m = /^(\d+)\/(\d+)$/.exec(String(argv[i + 1] === undefined ? "" : argv[i + 1]));
  if (!m) throw new Error("--shard needs i/n, for example --shard 0/4 (0-based index, n shards)");
  const index = Number(m[1]), count = Number(m[2]);
  if (!(count >= 1 && count <= 16) || !(index >= 0 && index < count)) throw new Error(`--shard ${m[1]}/${m[2]}: the index must be below the count, and the count 1 to 16`);
  return { index, count };
}
export function shardOf(list, index, count) {
  return list.filter((_, p) => p % count === index);
}
// The argument list without --shard and its value (child suites do not take it).
export function withoutShard(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === "--shard") { i++; continue; } out.push(argv[i]); }
  return out;
}
