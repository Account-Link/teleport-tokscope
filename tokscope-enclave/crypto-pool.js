/**
 * crypto-pool.js — main-thread Worker pool for TEE watch-history crypto.
 *
 * Responsibilities:
 *  - Spawn N crypto-worker.js Workers (N = TEE_CRYPTO_WORKERS, default 3).
 *  - Distribute the DStack-derived watch-history key to every worker.
 *  - Round-robin dispatch of encrypt/decrypt requests.
 *  - Per-call timeout: kill worker on timeout, respawn, reject in-flight.
 *  - Auto-respawn on worker crash; re-deliver key to new worker.
 *  - Graceful shutdown via shutdown().
 *
 * The public API (`encrypt`, `decrypt`, `setKey`, `waitUntilReady`, `isReady`,
 * `shutdown`) is all async/Promise-based. All CPU-heavy work happens inside
 * the worker threads.
 */

'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { log } = require('./lib/log');

const WORKER_SCRIPT = path.resolve(__dirname, 'crypto-worker.js');
const DEFAULT_WORKER_COUNT = 3;
// 30s allows 10-page batch decrypts on heavy users to finish without killing
// the worker. Stays under EnclaveClient's 90s axios budget.
const CALL_TIMEOUT_MS = 30_000;

class CryptoPool {
  /**
   * @param {number} [workerCount] - Number of crypto worker threads to spawn.
   *   - `undefined` → use TEE_CRYPTO_WORKERS env (default 3). Normal case.
   *   - `0`         → DISABLED MODE (v1.2.1+). No workers spawn, setKey/
   *                   waitUntilReady no-op-resolve so startup gating stays
   *                   happy, but encrypt/decrypt/decryptAndDedup throw a
   *                   loud error if anyone calls them. Used by the AUTH
   *                   process after the dual-process split — auth routes
   *                   never touch watch-history crypto (verified by grep
   *                   in server.ts), so worker-thread overhead and main-
   *                   thread postMessage churn are pure waste there.
   *   - positive N  → explicit override (tests).
   */
  constructor(workerCount) {
    // Allow explicit 0 to mean "disabled"; undefined means "use env default".
    const explicit = Number.isFinite(workerCount);
    const n = explicit
      ? workerCount
      : parseInt(process.env.TEE_CRYPTO_WORKERS || String(DEFAULT_WORKER_COUNT), 10);
    this.workerCount = n >= 0 ? n : DEFAULT_WORKER_COUNT;
    this.disabled = this.workerCount === 0;
    /** @type {Array<WorkerEntry|null>} */
    this.workers = new Array(this.workerCount).fill(null);
    this.nextIdx = 0;
    /** @type {Buffer|null} */
    this.key = null;
    /** @type {Promise<void>|null} */
    this.readyPromise = null;
    this.shuttingDown = false;
    if (this.disabled) {
      log.ok('TEE', 'crypto_pool_disabled', { reason: 'auth_mode_or_explicit_zero' });
    }
  }

  /**
   * Set the encryption key and (re)initialize all workers.
   * Resolves when every worker has acknowledged the key.
   * Called from server.ts initDStack() right after getKey('watch-history-encryption').
   *
   * v1.2.1: in disabled mode (auth process), stores the key for isReady()
   * semantics, resolves readyPromise immediately, and spawns zero workers.
   * This keeps tee-crypto.js's startup gate (waitForWorkersReady) unblocked
   * in auth mode without spawning unnecessary worker threads.
   */
  async setKey(keyBuffer) {
    const buf = Buffer.from(keyBuffer);
    if (buf.length !== 32) {
      throw new Error(`CryptoPool.setKey: expected 32-byte key, got ${buf.length}`);
    }
    this.key = buf;

    if (this.disabled) {
      // No workers to send the key to; mark ready so startup gating passes.
      this.readyPromise = Promise.resolve();
      return this.readyPromise;
    }

    // (Re)spawn any missing workers
    for (let i = 0; i < this.workerCount; i++) {
      if (!this.workers[i]) this._spawnWorker(i);
    }

    this.readyPromise = Promise.all(
      this.workers.map((w) => this._sendTo(w, { op: 'setKey', key: this.key }))
    ).then(() => {
      log.ok('TEE', 'crypto_pool_ready', { workers: this.workerCount });
    }).catch((err) => {
      log.fail('TEE', 'crypto_pool_init_failed', { err: err && err.message ? err.message : String(err) });
      throw err;
    });

    return this.readyPromise;
  }

  /** Returns a Promise that resolves when setKey has completed successfully. */
  waitUntilReady() {
    if (!this.readyPromise) {
      return Promise.reject(new Error('CryptoPool: setKey() was never called'));
    }
    return this.readyPromise;
  }

  isReady() {
    if (this.disabled) {
      // "Ready" in the disabled sense: key installed, ready to REFUSE requests.
      // Callers that gate actual crypto work should not be reached on this process
      // (auth routes don't touch watch-history crypto), but returning true here
      // keeps startup/health checks truthful about init status.
      return this.key !== null && this.readyPromise !== null;
    }
    return this.key !== null
      && this.workers.every((w) => w !== null)
      && this.readyPromise !== null;
  }

  async encrypt(data) {
    if (this.disabled) {
      throw new Error('CryptoPool: encrypt() called on disabled pool (TOKSCOPE_MODE=auth). This is a routing bug — auth process should not reach watch-history crypto.');
    }
    await this.waitUntilReady();
    const entry = this._pickWorker();
    return this._sendTo(entry, { op: 'encrypt', data });
  }

  async decrypt(hex) {
    if (this.disabled) {
      throw new Error('CryptoPool: decrypt() called on disabled pool (TOKSCOPE_MODE=auth). This is a routing bug — auth process should not reach watch-history crypto.');
    }
    await this.waitUntilReady();
    const entry = this._pickWorker();
    return this._sendTo(entry, { op: 'decrypt', hex });
  }

  /**
   * v1.2.0: decrypt a batch of hex pages and dedup videos in the worker.
   * Main thread pays structured-clone cost ONCE for the compact result
   * instead of once per page for a 1 MB parsed object.
   *
   * @param {string[]} hexes
   * @param {string[]} seenIds
   * @returns {Promise<{newVideos: any[], newlyAddedIds: string[], totalRawVideos: number, pagesFailed: number}>}
   */
  async decryptAndDedup(hexes, seenIds) {
    if (this.disabled) {
      throw new Error('CryptoPool: decryptAndDedup() called on disabled pool (TOKSCOPE_MODE=auth). This is a routing bug — auth process should not reach watch-history crypto.');
    }
    await this.waitUntilReady();
    const entry = this._pickWorker();
    return this._sendTo(entry, { op: 'decryptAndDedup', hexes, seenIds });
  }

  async shutdown() {
    this.shuttingDown = true;
    const terminates = this.workers
      .filter((w) => w)
      .map((w) => w.worker.terminate().catch(() => {}));
    this.workers = new Array(this.workerCount).fill(null);
    await Promise.all(terminates);
  }

  // ---------- internals ----------

  _spawnWorker(index) {
    let worker;
    try {
      worker = new Worker(WORKER_SCRIPT);
    } catch (err) {
      log.fail('TEE', 'crypto_pool_worker_spawn_failed', { index, err: err.message });
      throw err;
    }

    /** @type {WorkerEntry} */
    const entry = { worker, pending: new Map(), reqId: 0, index };

    worker.on('message', (m) => {
      if (!m || typeof m.id !== 'number') return;
      const p = entry.pending.get(m.id);
      if (!p) return; // late response after timeout / worker death
      entry.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.err || 'Crypto worker error'));
    });

    worker.on('error', (err) => {
      log.fail('TEE', 'crypto_pool_worker_error', { index, err: err.message });
    });

    worker.on('exit', (code) => {
      if (this.shuttingDown) return;
      log.fail('TEE', 'crypto_pool_worker_died', { index, exit_code: code });

      // Reject any in-flight requests bound to this worker
      for (const [, p] of entry.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Crypto worker ${index} died (exit=${code})`));
      }
      entry.pending.clear();

      this.workers[index] = null;
      // Respawn after a short backoff to avoid tight crash loops
      setTimeout(() => this._respawn(index), 500);
    });

    this.workers[index] = entry;
  }

  _respawn(index) {
    if (this.shuttingDown) return;
    if (this.workers[index]) return; // already respawned
    log.warn('TEE', 'crypto_pool_worker_respawn', { index });
    try {
      this._spawnWorker(index);
    } catch {
      // _spawnWorker logged; retry shortly
      setTimeout(() => this._respawn(index), 2000);
      return;
    }
    if (this.key) {
      this._sendTo(this.workers[index], { op: 'setKey', key: this.key })
        .then(() => log.ok('TEE', 'crypto_pool_worker_rekeyed', { index }))
        .catch((err) => log.fail('TEE', 'crypto_pool_worker_rekey_failed', {
          index, err: err && err.message ? err.message : String(err),
        }));
    }
  }

  _pickWorker() {
    // Round-robin over non-null entries
    const live = this.workers.filter((w) => w !== null);
    if (live.length === 0) {
      throw new Error('CryptoPool: no live workers');
    }
    const entry = live[this.nextIdx % live.length];
    this.nextIdx = (this.nextIdx + 1) % Number.MAX_SAFE_INTEGER;
    return entry;
  }

  _sendTo(entry, msg) {
    return new Promise((resolve, reject) => {
      const id = ++entry.reqId;
      const timer = setTimeout(() => {
        if (!entry.pending.delete(id)) return;
        reject(new Error(`CryptoPool: worker ${entry.index} timed out on op=${msg.op}`));
        // Kill the stuck worker; 'exit' handler will respawn + reject any other in-flights
        try { entry.worker.terminate(); } catch { /* ignore */ }
      }, CALL_TIMEOUT_MS);
      entry.pending.set(id, { resolve, reject, timer });
      try {
        entry.worker.postMessage({ id, ...msg });
      } catch (err) {
        clearTimeout(timer);
        entry.pending.delete(id);
        reject(err);
      }
    });
  }
}

// Export a singleton so callers (tee-crypto.js, server.ts) share one pool.
//
// v1.2.1 — Crypto worker pool is data-process-only.
// The pool exists exclusively to offload AES-GCM encrypt/decrypt of
// watch-history payloads (~500 KB-1 MB each) off the main event loop. Only
// data-process routes (/api/enclave/{encrypt,decrypt}-watch-history{,-v2},
// /migrate/*) ever reach these code paths. Spawning 3 worker threads in the
// auth process would waste memory (~30-50 MB per worker) and muddy the
// "auth has its own clean event loop" invariant — worker-thread postMessage
// callbacks ARE main-thread work. Zero workers in auth = zero main-thread
// crypto pings ever.
//
// Why throw on encrypt/decrypt calls in auth mode (instead of silently
// falling back to synchronous crypto)? A silent fallback would hide a
// programmer error: if a new auth-side route ever reached for this pool,
// we want a loud failure at dev time, not a mysterious auth-process
// event-loop regression in prod.
const MODE = (process.env.TOKSCOPE_MODE || 'all').toLowerCase();
const POOL_ENABLED = MODE === 'data' || MODE === 'all';
module.exports = new CryptoPool(POOL_ENABLED ? undefined : 0);
