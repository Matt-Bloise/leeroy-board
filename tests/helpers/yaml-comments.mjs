// Strips comments from workflow text for the secrets guard (tests/unit/workflow-secrets.test.mjs).
// KISS on purpose: a line is a comment only when its first non-space character is `#`. Nothing after an inline `#` is ever stripped,
// so a `secrets.X` anywhere else on a line always counts as present (quotes, escapes, `}}` in strings and multiline scalars cannot hide it).
// The cost is strictness: a trailing comment that names a secret is read as a reference. Put such a pointer on its own comment line.
export const stripComments = (text) => text.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)).join("\n");
