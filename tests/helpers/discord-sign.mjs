// Signs Discord interaction requests with a throwaway Ed25519 key generated in memory on every run.
// No real key exists anywhere in the repo. Pass publicKeyHex to the handler as env.DISCORD_PUBLIC_KEY.
import { generateKeyPairSync, sign } from "node:crypto";

export function createDiscordSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");

  // Returns a Request exactly as Discord would send it: raw JSON body plus the two signature headers.
  function signedRequest(payload, { timestamp = Math.floor(Date.now() / 1000), url = "https://worker.test/discord", tamper = false } = {}) {
    const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
    const ts = String(timestamp);
    const signature = sign(null, Buffer.from(ts + rawBody), privateKey).toString("hex");
    return new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": tamper ? signature.replace(/^./, (c) => (c === "0" ? "1" : "0")) : signature,
        "X-Signature-Timestamp": ts,
      },
      body: rawBody,
    });
  }

  return { publicKeyHex, signedRequest };
}
