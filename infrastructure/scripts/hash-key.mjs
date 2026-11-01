// Prints the SQL that adds one member. The key is read from stdin (never an argument, so it stays out of shell history) and the
// salt from the KEY_SALT environment variable; neither is written anywhere. Output is one INSERT for `wrangler d1 execute --command`.
//   node hash-key.mjs <slug>      (key on stdin; KEY_SALT in the environment)
//   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   makes a key
import { createHash } from "node:crypto";

const slug = process.argv[2];
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug || "")) { console.error("usage: KEY_SALT=... node hash-key.mjs <slug>   (key on stdin)"); process.exit(2); }
const salt = process.env.KEY_SALT || "";
if (salt.length < 16) { console.error("KEY_SALT must be set and at least 16 characters"); process.exit(2); }
let key = "";
for await (const c of process.stdin) key += c;
key = key.trim();
if (!/^[A-Za-z0-9_-]{22,64}$/.test(key)) { console.error("the key must be 22 to 64 characters of A-Z a-z 0-9 _ -"); process.exit(2); }
const hash = createHash("sha256").update(`${salt}:${key}`).digest("hex");
console.log(`INSERT INTO members (slug, key_hash, created_at) VALUES ('${slug}', '${hash}', '${new Date().toISOString()}') ON CONFLICT(slug) DO UPDATE SET key_hash = excluded.key_hash;`);
