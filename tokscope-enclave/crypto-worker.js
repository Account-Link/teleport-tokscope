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

/**
 * v1.2.0: Decrypt a batch of hex-encoded pages, dedup videos across pages
 * against an initial seenIds set. All work (AES + JSON.parse + dedup loop)
 * happens in this worker thread — main thread receives only a compact
 * result instead of one ~1 MB parsed object per page.
 *
 * Per-page failures are caught and counted (does NOT fail the whole batch)
 * — matches the existing per-page semantics in server.ts:2289.
 *
 * @param {string[]} hexes - list of iv|authTag|ciphertext hex strings
 * @param {string[]} seenIdsIn - existing video IDs from prior batches
 * @returns {{newVideos: any[], newlyAddedIds: string[], totalRawVideos: number, pagesFailed: number}}
 */
function doDecryptAndDedup(hexes, seenIdsIn) {
  const seen = new Set(seenIdsIn || []);
  const newVideos = [];
  const newlyAddedIds = [];
  let totalRawVideos = 0;
  let pagesFailed = 0;
  for (const hex of hexes) {
    try {
      const decrypted = doDecrypt(hex);
      // v1.2.1.1.5: align field-name fallback chain with the encrypt path
      // (server.ts already uses aweme_list || itemList || videos). Future-proof
      // against TikTok format shifts.
      const videos = decrypted?.aweme_list || decrypted?.itemList || decrypted?.videos || [];
      // v1.2.1.1.5: TikTok's watch-history response includes a parallel
      // aweme_watch_history array of millisecond-string timestamps aligned by
      // index with aweme_list. Stitch each timestamp onto its video so the
      // helper transform can surface watchedAt instead of always returning null.
      // Pre-fix: aweme_watch_history was decrypted but discarded — every video
      // returned watchedAt: null even though the data was in the encrypted blob.
      const watchTimestamps = Array.isArray(decrypted?.aweme_watch_history)
        ? decrypted.aweme_watch_history
        : null;
      if (Array.isArray(videos)) {
        totalRawVideos += videos.length;
        for (let i = 0; i < videos.length; i++) {
          const v = videos[i];
          if (watchTimestamps && watchTimestamps[i] !== undefined && watchTimestamps[i] !== null) {
            const ts = parseInt(watchTimestamps[i], 10);
            if (!isNaN(ts) && ts > 0) {
              v.watched_at = new Date(ts).toISOString();
            }
          }
          const id = String(v.aweme_id || v.video_id || v.id || '');
          if (id && !seen.has(id)) {
            seen.add(id);
            newlyAddedIds.push(id);
            newVideos.push(v);
          }
        }
      }
    } catch (e) {
      pagesFailed++;
    }
  }
  return { newVideos, newlyAddedIds, totalRawVideos, pagesFailed };
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

    if (op === 'decryptAndDedup') {
      // v1.2.0: batch decrypt + dedup in worker thread. Keeps main-thread
      // structured-clone cost at O(newVideos) instead of O(hexes * 1MB).
      respond(id, { ok: true, result: doDecryptAndDedup(msg.hexes, msg.seenIds) });
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
