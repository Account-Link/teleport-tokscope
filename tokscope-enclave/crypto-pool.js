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
const CALL_TIMEOUT_MS = 10_000;

class CryptoPool {
  constructor(workerCount) {
    const n = Number.isFinite(workerCount) && workerCount > 0
      ? workerCount
      : parseInt(process.env.TEE_CRYPTO_WORKERS || String(DEFAULT_WORKER_COUNT), 10);
    this.workerCount = n > 0 ? n : DEFAULT_WORKER_COUNT;
    /** @type {Array<WorkerEntry|null>} */
    this.workers = new Array(this.workerCount).fill(null);
    this.nextIdx = 0;
    /** @type {Buffer|null} */
    this.key = null;
    /** @type {Promise<void>|null} */
    this.readyPromise = null;
    this.shuttingDown = false;
  }

  /**
   * Set the encryption key and (re)initialize all workers.
   * Resolves when every worker has acknowledged the key.
   * Called from server.ts initDStack() right after getKey('watch-history-encryption').
   */
  async setKey(keyBuffer) {
    const buf = Buffer.from(keyBuffer);
    if (buf.length !== 32) {
      throw new Error(`CryptoPool.setKey: expected 32-byte key, got ${buf.length}`);
    }
    this.key = buf;

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
    return this.key !== null
      && this.workers.every((w) => w !== null)
      && this.readyPromise !== null;
  }

  async encrypt(data) {
    await this.waitUntilReady();
    const entry = this._pickWorker();
    return this._sendTo(entry, { op: 'encrypt', data });
  }

  async decrypt(hex) {
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
module.exports = new CryptoPool();
