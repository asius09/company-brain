import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  type ScryptOptions,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { getEnv } from '../config/env';

type ScryptAsync = (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

/**
 * `promisify` resolves the *first* `scrypt` overload, which drops the options
 * argument from its type. The cost parameters must be passed through on verify
 * (they are stored in the hash), so widen the signature explicitly.
 */
const scrypt = promisify(scryptCb) as ScryptAsync;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/**
 * Secret-at-rest helpers. Tenant AI keys and OAuth tokens are encrypted with
 * AES-256-GCM using `ENCRYPTION_KEY`; nothing reversible is ever stored in clear.
 */

function masterKey(): Buffer {
  return Buffer.from(getEnv().ENCRYPTION_KEY, 'hex');
}

/** Encrypts a UTF-8 string. Returns `v1.<iv>.<tag>.<ciphertext>` (all base64url). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Inverse of `encrypt`. Throws when the payload was tampered with. */
export function decrypt(payload: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = payload.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error('Malformed ciphertext');
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Encrypts an object as JSON. */
export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

/** Decrypts a payload produced by `encryptJson`. */
export function decryptJson<T = unknown>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}

/** Decrypts without throwing — for optional/legacy columns. */
export function tryDecryptJson<T = unknown>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  try {
    return decryptJson<T>(payload);
  } catch {
    return null;
  }
}

/** Encrypts selected fields of an object, leaving the rest in clear. */
export function encryptFields<T extends Record<string, unknown>>(
  value: T,
  fields: readonly (keyof T & string)[],
): { encrypted: Record<string, string>; public: Record<string, unknown> } {
  const encrypted: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (fields.includes(key) && val != null) {
      encrypted[key] = encrypt(String(val));
    } else if (val != null) {
      rest[key] = val;
    }
  }
  return { encrypted, public: rest };
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

/** scrypt password hash. Format: `scrypt$N$r$p$<salt-b64>$<key-b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;

  const [scheme, nRaw, rRaw, pRaw, saltRaw, keyRaw] = stored.split('$');
  if (scheme !== 'scrypt' || !saltRaw || !keyRaw) return false;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const expected = Buffer.from(keyRaw, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltRaw, 'base64url'), expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });

  return timingSafeEqual(expected, actual);
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/** URL-safe random token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateId(): string {
  return randomUUID();
}

/** SHA-256, for values already carrying sufficient entropy (API keys, session tokens). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** HMAC-SHA256 with the master key — used for deterministic lookups. */
export function keyedHash(value: string): string {
  return createHmac('sha256', masterKey()).update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
