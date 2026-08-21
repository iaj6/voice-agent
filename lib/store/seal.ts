/**
 * Crypto-shredding: destroying content by destroying the key that reads it.
 *
 * The record is append-only by design. `audit_entry` rejects UPDATE and DELETE
 * at the schema level, sessions are referenced `on delete restrict`, and the
 * trail is hash-chained — which is exactly what a regulated trail should be, and
 * exactly what leaves no way to honour a destruction date. Deleting rows is not
 * available; nor is rewriting them.
 *
 * So the content is sealed and the key is what gets destroyed. The row stays,
 * the hash stays, the chain still verifies — because the hash is computed over
 * the *sealed* bytes, not the plaintext — and the content is unrecoverable. That
 * pairing is what a regulator asks for: prove this record existed, and prove its
 * content is gone.
 *
 * **The threat model is deletion, not confidentiality.** Keys live in the same
 * database as the ciphertext, so anyone who can read the data can read the keys
 * while they exist. That is not an oversight: what this defends against is being
 * unable to prove destruction, and a key row that is deleted is destroyed. A real
 * deployment holds these in a KMS or HSM so the database alone is not enough —
 * that is a deployment decision, and the sealed format does not change when it is
 * made. See docs/RETENTION.md D4.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
export const KEY_BYTES = 32;

/**
 * A sealed value, as stored.
 *
 * Self-describing on purpose. A row read years from now has to say what it is
 * without the code that wrote it being available to ask, and "this is sealed and
 * its key is gone" has to be distinguishable from "this is corrupt".
 */
export interface SealedValue {
  readonly __sealed: 1;
  /** Which key opens it. Present after destruction, which is the point. */
  readonly key: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

export function isSealed(value: unknown): value is SealedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SealedValue).__sealed === 1
  );
}

export function newKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function seal(value: unknown, keyId: string, key: Buffer): SealedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(value ?? null), "utf8"),
    cipher.final(),
  ]);
  return {
    __sealed: 1,
    key: keyId,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Thrown when the key that would open a value has been destroyed. */
export class ShreddedError extends Error {
  // Declared, not a parameter property: Node runs these sources directly in
  // strip-only mode, which does not support them. The bundler is happy either
  // way, so this only shows up when the tests run.
  readonly keyId: string;

  constructor(keyId: string) {
    super(
      `The key for ${keyId} has been destroyed, so this content cannot be read. ` +
        "The record and its audit trail remain intact and still verify.",
    );
    this.keyId = keyId;
  }
}

export function unseal(sealed: SealedValue, key: Buffer | null): unknown {
  if (!key) throw new ShreddedError(sealed.key);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}

/**
 * Opens a sealed value, or returns a marker when the key is gone.
 *
 * Reading a shredded record must not throw. A coordinator opening a destroyed
 * check-in should see that it was destroyed, not a stack trace — and the audit
 * trail has to stay readable and verifiable after shredding, which is most of
 * why this design was chosen over deleting rows.
 */
export const SHREDDED = { __shredded: true } as const;

export function unsealOrMark(sealed: SealedValue, key: Buffer | null): unknown {
  try {
    return unseal(sealed, key);
  } catch {
    return SHREDDED;
  }
}
