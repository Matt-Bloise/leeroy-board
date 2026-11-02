// USER_SALT and KEY_SALT are Worker secrets (not [vars]). When one is missing or too short the Worker fails closed:
// the paths that need it refuse with a clear error instead of falling back to an unsalted hash. Pure: no env writes.
export const SALT_MIN_LENGTH = 16;

export function saltProblems(env, names = ["USER_SALT", "KEY_SALT"]) {
  return names.filter((n) => !env || !env[n] || String(env[n]).length < SALT_MIN_LENGTH);
}

export class SaltMissingError extends Error {
  constructor(missing) {
    super(`Worker secret ${missing.join(", ")} is not configured (set it with wrangler secret put)`);
    this.name = "SaltMissingError";
    this.missing = missing;
  }
}

// Throws SaltMissingError naming the secret; never the value.
export function requireSalt(env, name) {
  const missing = saltProblems(env, [name]);
  if (missing.length) throw new SaltMissingError(missing);
  return String(env[name]);
}

// Body for a 503 response.
export const saltErrorBody = (missing) => ({ error: "salt_not_configured", message: `Worker secret ${missing.join(", ")} is not configured`, missing });
