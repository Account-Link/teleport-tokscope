/**
 * crypto-worker.js — runs inside a Node worker_threads Worker.
 *
 * Purpose: move watch-history AES-256-GCM encryption/decryption off the
 * main event loop to keep QR auth orchestration responsive under scrape load.
 *
 * Wire format (identical to pre-v1.1.9 tee-crypto.js — byte-compatible with
 * already-migrated rows encrypted by v1.1.8):
 *   iv(12) | authTag(16) | ciphertext  -> hex-encoded string
 *
 * Messages (main -> worker):
 *   { id, op: 'setKey',   key: Buffer|Uint8Array|number[] }
 *   { id, op: 'encrypt',  data: any (JSON-serializable) }
 *   { id, op: 'decrypt',  hex:  string }
 *
 * Responses (worker -> main):
 *   { id, ok: true,  result: string | any }
 *   { id, ok: false, err:    string }
 */

'use strict';

const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');

if (!parentPort) {
  throw new Error('crypto-worker.js must be loaded as a Worker (parentPort missing)');
}

/** @type {Buffer | null} */
let watchHistoryKey = null;

function respond(id, payload) {
  parentPort.postMessage({ id, ...payload });
}

/**
 * Byte-compatible with tee-crypto.js:65-78. Uses .slice() to match the
 * exact method used by existing code, even though .subarray() is identical.
 * JSON.stringify happens in the WORKER thread so main stays responsive.
 */
function doEncrypt(data) {
  const plaintext = JSON.stringify(data);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', watchHistoryKey, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('hex');
}

/**
 * Byte-compatible with tee-crypto.js:90-109. JSON.parse in the WORKER
 * thread so main stays responsive.
 */
function doDecrypt(hex) {
  const combined = Buffer.from(hex, 'hex');
  const iv = combined.slice(0, 12);
  const authTag = combined.slice(12, 28);
  const encrypted = combined.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', watchHistoryKey, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

parentPort.on('message', (msg) => {
  const { id, op } = msg || {};
  try {
    if (op === 'setKey') {
      // postMessage may structured-clone a Buffer as Uint8Array; Buffer.from
      // handles Buffer, Uint8Array, and number[] uniformly.
      const buf = Buffer.from(msg.key);
      if (buf.length !== 32) {
        throw new Error(`Expected 32-byte key, got ${buf.length} bytes`);
      }
      watchHistoryKey = buf;
      respond(id, { ok: true });
      return;
    }

    if (!watchHistoryKey) {
      throw new Error('Worker key not initialized; call setKey first');
    }

    if (op === 'encrypt') {
      respond(id, { ok: true, result: doEncrypt(msg.data) });
      return;
    }

    if (op === 'decrypt') {
      // Return parsed JSON directly via structured-clone; main must NOT re-parse.
      respond(id, { ok: true, result: doDecrypt(msg.hex) });
      return;
    }

    throw new Error(`Unknown op: ${op}`);
  } catch (err) {
    respond(id, { ok: false, err: err && err.message ? err.message : String(err) });
  }
});

// When the parent process closes the channel (shutdown), exit cleanly.
parentPort.on('close', () => {
  process.exit(0);
});
