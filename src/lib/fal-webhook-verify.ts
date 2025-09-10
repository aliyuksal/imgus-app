// lib/fal-webhook-verify.ts
import crypto from "node:crypto";
import * as sodium from "libsodium-wrappers";
import type { NextRequest } from "next/server";

/**
 * FAL Webhook imza doğrulama.
 * İmzalanan mesaj: request_id + "\n" + user_id + "\n" + timestamp + "\n" + sha256(rawBodyHex)
 * Header'lar:
 *  - x-fal-webhook-request-id
 *  - x-fal-webhook-user-id
 *  - x-fal-webhook-timestamp   (epoch seconds)
 *  - x-fal-webhook-signature   (hex)
 */

const JWKS_URL = "https://rest.alpha.fal.ai/.well-known/jwks.json";
let jwksCache: any[] | null = null;
let jwksFetchedAt = 0;

async function getJwks() {
  const now = Date.now();
  if (!jwksCache || now - jwksFetchedAt > 24 * 60 * 60 * 1000) {
    const r = await fetch(JWKS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status}`);
    const json = await r.json();
    jwksCache = json.keys || [];
    jwksFetchedAt = now;
  }
  return jwksCache!;
}

function base64urlToBytes(b64url: string) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

export async function verifyFalWebhook(req: NextRequest, rawBody: Buffer) {
  await sodium.ready;

  const reqId = req.headers.get("x-fal-webhook-request-id");
  const userId = req.headers.get("x-fal-webhook-user-id");
  const ts = req.headers.get("x-fal-webhook-timestamp");
  const sigHex = req.headers.get("x-fal-webhook-signature");
  if (!reqId || !userId || !ts || !sigHex) return false;

  // Timestamp skew (±300s)
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10));
  if (!Number.isFinite(skew) || skew > 300) return false;

  // sha256(rawBody) -> hex
  const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
  const message = Buffer.from([reqId, userId, ts, digest].join("\n"), "utf-8");
  const signature = Buffer.from(sigHex, "hex");

  const keys = await getJwks();
  for (const k of keys) {
    try {
      const pub = base64urlToBytes(k.x); // ed25519 public key (x)
      const ok = sodium.crypto_sign_verify_detached(signature, message, pub);
      if (ok) return true;
    } catch {
      // diğer anahtarı dene
    }
  }
  return false;
}