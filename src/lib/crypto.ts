/**
 * Encrypt / decrypt credential passwords with WebCrypto AES-GCM.
 * Plaintext passwords are never written to durable storage.
 * Key material comes from CREDENTIAL_ENC_KEY or a deterministic derivation
 * of BOT_TOKEN (dev/test fallback only).
 */

const ENC_PREFIX = "v1:";
const ALGO = "AES-GCM";
const IV_LEN = 12;

let cachedKey: CryptoKey | null = null;
let cachedKeySrc = "";

function keySource(): string {
  const fromEnv =
    (typeof process !== "undefined" && process.env.CREDENTIAL_ENC_KEY?.trim()) ||
    (typeof process !== "undefined" && process.env.BOT_TOKEN?.trim()) ||
    "dev-credential-key";
  return fromEnv;
}

async function getKey(): Promise<CryptoKey> {
  const src = keySource();
  if (cachedKey && cachedKeySrc === src) return cachedKey;
  const raw = new TextEncoder().encode(src);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  cachedKey = await crypto.subtle.importKey("raw", hash, { name: ALGO }, false, [
    "encrypt",
    "decrypt",
  ]);
  cachedKeySrc = src;
  return cachedKey;
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt a plaintext password for durable storage. */
export async function encryptPassword(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const cipher = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return ENC_PREFIX + b64(iv) + ":" + b64(cipher);
}

/** Decrypt a stored ciphertext back to the password for delivery. */
export async function decryptPassword(stored: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error("unsupported credential encoding");
  }
  const rest = stored.slice(ENC_PREFIX.length);
  const [ivB64, ctB64] = rest.split(":");
  if (!ivB64 || !ctB64) throw new Error("corrupt credential encoding");
  const key = await getKey();
  const iv = fromB64(ivB64);
  const ct = fromB64(ctB64);
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
    key,
    ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer,
  );
  return new TextDecoder().decode(plain);
}

/** Clear cached key (tests that swap env). */
export function resetCryptoCache(): void {
  cachedKey = null;
  cachedKeySrc = "";
}
