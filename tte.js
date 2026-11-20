// TripTrack web files (.tte): AES-256-GCM, key = PBKDF2-HMAC-SHA256 over the password.
//   "TTE1" | salt (16) | iterations (uint32 BE) | IV (12) | ciphertext + tag (16)
// Same format as TteCrypto.kt in the app. Works in browsers and in Node 20+ (WebCrypto).

const MAGIC = [0x54, 0x54, 0x45, 0x31];
const HEAD = 4 + 16 + 4 + 12;
const keys = new Map();

export class WrongPassword extends Error {
  constructor() { super('Het wachtwoord klopt niet.'); this.name = 'WrongPassword'; }
}

async function deriveKey(password, salt, iterations, usage) {
  const id = `${usage}|${iterations}|${[...salt].join(',')}|${password}`;
  if (!keys.has(id)) {
    keys.set(id, (async () => {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
    })());
  }
  return keys.get(id);
}

/** Decrypts a .tte file; returns the plaintext (gzip bytes). */
export async function decrypt(buffer, password) {
  const b = new Uint8Array(buffer);
  if (b.length < HEAD + 16 || MAGIC.some((m, i) => b[i] !== m)) throw new Error('Dit is geen TripTrack-webbestand.');
  const salt = b.slice(4, 20);
  const iterations = new DataView(b.buffer, b.byteOffset + 20, 4).getUint32(0);
  const iv = b.slice(24, 36);
  const key = await deriveKey(password, salt, iterations, 'decrypt');
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b.slice(HEAD));
  } catch {
    throw new WrongPassword();
  }
}

/** Encrypts like the app does (used by the test tools). */
export async function encrypt(plain, password, salt, iterations = 310_000) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(HEAD + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, 4);
  new DataView(out.buffer).setUint32(20, iterations);
  out.set(iv, 24);
  out.set(ct, HEAD);
  return out;
}
