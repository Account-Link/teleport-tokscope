import { execSync } from 'child_process';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';

// Configuration
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE || '6');
const ENABLE_PERSISTENT_RECYCLING = process.env.ENABLE_PERSISTENT_RECYCLING !== 'false'; // v19 feature flag

interface Config {
  tcb: {
    container_idle_timeout_ms: number;
  };
}

interface ContainerInfo {
  containerId: string;
  shortId: string;
  ip: string;
  cdpUrl: string;
  browser: Browser | null;
  context: BrowserContext | null;  // v19: Persistent context for recycling
  page: Page | null;               // v19: Persistent page for pre-warming
  sessionCount: number;            // v19: Track usage for lifecycle management
  createdAt: number;
  lastUsed: number;
  status: 'warming' | 'pooled' | 'assigned' | 'released' | 'recycling';  // v19: Added warming, recycling
  sessionId: string | null;
}

class BrowserManager {
  private config: Config = {
    tcb: {
      container_idle_timeout_ms: 600000 // 10 minutes
    }
  };
  private containers = new Map<string, ContainerInfo>();
  private sessionToContainer = new Map<string, string>();
  private containerPool: string[] = [];
  private isInitialized = false;
  private isMaintenanceRunning = false; // NEW: Lock flag for pool maintenance

  initialize(): void {
    this.isInitialized = true;

    console.log('🎭 Browser Manager initialized');
    console.log(`📊 Config: ${Math.round((this.config.tcb?.container_idle_timeout_ms || 600000) / 60000)} min idle timeout`);
    console.log(`📊 Config: ${MIN_POOL_SIZE} container pool size`);

    this.startCleanupInterval();
    this.startPoolMaintenance();
    this.cleanupAllOrphanedContainers(); // Clean up ALL containers from previous instance (running + exited)
  }

  private generateContainerId(): string {
    return `tcb-browser-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  }

  async createContainer(): Promise<string> {
    const containerId = this.generateContainerId();
    const network = process.env.DOCKER_NETWORK || 'xordi-proprietary-modules_enclave-api-network';
    const subnet = process.env.DOCKER_SUBNET || '172.19.0.0/16';

    try {
      console.log(`🚀 Creating browser container: ${containerId}`);

      try {
        execSync(`docker network inspect ${network}`, { stdio: 'ignore' });
      } catch {
        try {
          console.log(`📡 Creating network: ${network}`);
          execSync(`docker network create --driver bridge --subnet ${subnet} ${network}`, { stdio: 'ignore' });
        } catch (error) {
          console.log(`⚠️  Network ${network} creation failed, assuming it exists`);
        }
      }

      // Don't use static IPs - let Docker assign them automatically
      // xordi-network doesn't have user-configured subnet
      const dockerCmd = [
        'docker', 'run', '-d',
        '--name', containerId,
        '--hostname', containerId,
        '--network', network,
        '--env', `CONTAINER_NAME=${containerId}`,
        '--env', `NEKO_DESKTOP_SCREEN=${process.env.NEKO_DESKTOP_SCREEN || '1920x1080@30'}`,
        '--env', `NEKO_DESKTOP_SCALING=${process.env.NEKO_DESKTOP_SCALING || '1.0'}`,
        '--restart', 'no'
      ];

      // Resource limits (configurable via env vars)
      // NOTE: CPU limits disabled - Phala Docker-in-Docker doesn't support CPU tuning
      // Tested: --cpus flag (fails), --cpuset-cpus pinning (no performance gain)
      if (process.env.BROWSER_MEMORY_LIMIT) {
        dockerCmd.push('--memory', process.env.BROWSER_MEMORY_LIMIT);
      }
      if (process.env.BROWSER_MEMORY_RESERVATION) {
        dockerCmd.push('--memory-reservation', process.env.BROWSER_MEMORY_RESERVATION);
      }

      // Proxy is configured JIT when container is assigned for auth
      // Browser uses local relay at 127.0.0.1:1080 (hardcoded in chromium.conf)
      // Relay starts in passthrough mode, configured with IPFoxy when assigned
      console.log(`🌐 Container ${containerId} using local relay (passthrough until assigned)`);

      // Add image name as final argument
      dockerCmd.push(process.env.TCB_BROWSER_IMAGE || 'xordi-proprietary-modules-tcb-browser:latest');

      const result = execSync(dockerCmd.join(' '), { encoding: 'utf8' });
      const shortContainerId = result.trim().substring(0, 12);

      console.log(`⏳ Waiting for container ${containerId} to be ready...`);
      let retries = 0;
      while (retries < 60) {
        try {
          const containerStatus = execSync(`docker inspect --format='{{.State.Status}}' ${containerId}`, { encoding: 'utf8' }).trim();
          if (containerStatus !== 'running') {
            console.log(`Container ${containerId} status: ${containerStatus}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            retries += 2;
            continue;
          }

          execSync(`docker exec ${containerId} supervisorctl status neko`, { stdio: 'ignore' });
          console.log(`📺 Container ${containerId} neko service is ready`);
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 2000));
          retries += 2;
        }
      }

      if (retries >= 60) {
        throw new Error(`Container ${containerId} failed to start within 60 seconds`);
      }

      // Get the container's IP address from Docker
      const containerIP = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`, { encoding: 'utf8' }).trim();
      console.log(`📍 Container IP: ${containerIP}`);

      const cdpUrl = `http://${containerIP}:9223`;
      let browser = null;
      let browserRetries = 0;
      while (browserRetries < 10) {
        try {
          browser = await chromium.connectOverCDP(cdpUrl);
          const page = await browser.newPage();
          await page.close();
          console.log(`🌐 Browser connection successful for ${containerId}`);
          break;
        } catch (error: any) {
          console.log(`🔄 Browser connection attempt ${browserRetries + 1}/10 failed: ${error.message}`);
          browserRetries++;
          if (browserRetries >= 10) {
            throw new Error(`Failed to connect to browser in container ${containerId}: ${error.message}`);
          }
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // v19: Pre-warm container with QR page (if recycling enabled)
      let context: BrowserContext | null = null;
      let page: Page | null = null;
      let finalStatus: ContainerInfo['status'] = 'pooled';

      if (true) {  // Always pre-warm containers for fast QR extraction (recycling controlled by ENABLE_PERSISTENT_RECYCLING flag)
        try {
          console.log(`🔥 Pre-warming container ${containerId.substring(0, 16)}... with QR page...`);
          finalStatus = 'warming';

          // Create persistent context (starts clean, no cookies by default)
          context = await browser!.newContext();
          page = await context.newPage();

          // Navigate to QR page (one-time cost ~6s)
          await page.goto('https://www.tiktok.com/login/qrcode', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });

          // Verify QR container loaded
          await page.waitForSelector('img[alt="qrcode"]', {
            timeout: 10000,
            state: 'visible'
          });

          finalStatus = 'pooled';
          console.log(`✅ Container ${containerId.substring(0, 16)}... pre-warmed (QR page loaded)`);
        } catch (warmError: any) {
          console.error(`⚠️ Pre-warming failed for ${containerId}: ${warmError.message}`);
          console.log(`📦 Container will be available without pre-warming`);
          finalStatus = 'pooled';
          // Continue without pre-warming
        }
      }

      const containerInfo: ContainerInfo = {
        containerId,
        shortId: shortContainerId,
        ip: containerIP,
        cdpUrl,
        browser,
        context,              // v19: Store persistent context
        page,                 // v19: Store persistent page
        sessionCount: 0,      // v19: Initialize session counter
        createdAt: Date.now(),
        lastUsed: Date.now(),
        status: finalStatus,
        sessionId: null
      };

      this.containers.set(containerId, containerInfo);
      this.containerPool.push(containerId);

      console.log(`✅ Browser container ready: ${containerId.substring(0, 16)}... (${containerIP})`);
      return containerId;

    } catch (error: any) {
      console.error(`❌ Failed to create container ${containerId}:`, error.message);

      try {
        execSync(`docker rm -f ${containerId}`, { stdio: 'ignore' });
      } catch {}

      throw error;
    }
  }

  async assignContainer(sessionId: string): Promise<ContainerInfo> {
    if (!this.isInitialized) {
      throw new Error('Browser Manager not initialized');
    }

    if (this.sessionToContainer.has(sessionId)) {
      const existingContainerId = this.sessionToContainer.get(sessionId)!;
      const containerInfo = this.containers.get(existingContainerId);

      if (containerInfo && containerInfo.status === 'assigned') {
        console.log(`♻️  Reusing existing container for session ${sessionId.substring(0, 8)}...`);
        containerInfo.lastUsed = Date.now();
        return containerInfo;
      }
    }

    let containerId = this.containerPool.pop();

    if (!containerId) {
      // Pool exhausted = at capacity. Don't create more containers.
      // Let the request fail so auto-scaler can spin up a new machine.
      throw new Error('No available containers - capacity reached');
    }

    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container ${containerId} not found in registry`);
    }

    containerInfo.status = 'assigned';
    containerInfo.sessionId = sessionId;
    containerInfo.lastUsed = Date.now();

    this.sessionToContainer.set(sessionId, containerId);

    // JIT: Configure IPFoxy proxy now that container is being used for auth
    try {
      await this.configureContainerProxy(containerInfo);
    } catch (proxyError: any) {
      console.error(`❌ Failed to configure proxy: ${proxyError.message}`);
      // Return container to pool since assignment failed
      containerInfo.status = 'pooled';
      this.containerPool.push(containerId);
      this.sessionToContainer.delete(sessionId);
      throw proxyError;
    }

    // Reload existing page through proxy to get fresh QR with residential IP
    if (containerInfo.page) {
      try {
        console.log(`🔄 Reloading QR page through proxy for ${sessionId.substring(0, 8)}...`);
        await containerInfo.page.goto('https://www.tiktok.com/login/qrcode', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        await containerInfo.page.waitForSelector('img[alt="qrcode"]', {
          timeout: 10000,
          state: 'visible'
        });
        console.log(`✅ Container ${containerId.substring(0, 16)}... ready for auth (proxy active)`);
      } catch (reloadError: any) {
        console.error(`❌ Page reload failed: ${reloadError.message}`);
        throw reloadError;
      }
    }

    return containerInfo;
  }

  private async configureContainerProxy(containerInfo: ContainerInfo): Promise<void> {
    const proxyMode = process.env.PROXY_MODE || 'ipfoxy';
    const controlUrl = `http://${containerInfo.ip}:1081/configure`;

    let configPayload: string;
    let logMessage: string;

    if (proxyMode === 'wireguard') {
      // WireGuard mode: Connect to borgcube SOCKS5 buckets
      const wgHost = process.env.WIREGUARD_HOST || '162.251.235.136';
      const wgBasePort = parseInt(process.env.WIREGUARD_BASE_PORT || '10800');
      const wgUser = process.env.WG_PROXY_USER;
      const wgPass = process.env.WG_PROXY_PASS;

      if (!wgUser || !wgPass) {
        throw new Error('WG_PROXY_USER/WG_PROXY_PASS not configured for wireguard mode');
      }

      // Random bucket for QR auth (no sec_user_id yet - will be assigned deterministically after login)
      const bucket = Math.floor(Math.random() * 10);
      const port = wgBasePort + bucket;

      configPayload = JSON.stringify({
        host: wgHost,
        port: port,
        user: wgUser,
        pass: wgPass
      });

      logMessage = `🌐 Container ${containerInfo.containerId.substring(0, 16)}... proxy configured (wireguard bucket ${bucket})`;

    } else {
      // IPFoxy mode (default)
      const ipfoxyAccount = process.env.IPFOXY_ACCOUNT;
      const ipfoxyPassword = process.env.IPFOXY_PASSWORD;

      if (!ipfoxyAccount || !ipfoxyPassword) {
        console.log(`⚠️ IPFoxy credentials not configured, skipping proxy setup`);
        return;
      }

      // Generate unique session ID for this auth request (NO hyphens - IPFoxy rejects them)
      const sessionId = `${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
      const upstreamUser = `customer-${ipfoxyAccount}-cc-US-sessid-${sessionId}-ttl-60`;

      configPayload = JSON.stringify({
        host: 'gate-us.ipfoxy.io',
        port: 58688,
        user: upstreamUser,
        pass: ipfoxyPassword
      });

      logMessage = `🌐 Container ${containerInfo.containerId.substring(0, 16)}... proxy configured (ipfoxy session: ${sessionId})`;
    }

    // POST to relay control endpoint inside container
    const response = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: configPayload
    });

    if (!response.ok) {
      throw new Error(`Relay config failed: ${response.status}`);
    }

    console.log(logMessage);
  }

  async releaseContainer(sessionId: string): Promise<void> {
    if (!this.sessionToContainer.has(sessionId)) {
      console.log(`⚠️  No container assigned to session ${sessionId.substring(0, 8)}...`);
      return;
    }

    const containerId = this.sessionToContainer.get(sessionId)!;
    const containerInfo = this.containers.get(containerId);

    if (containerInfo) {
      containerInfo.status = 'released';
      containerInfo.sessionId = null;
      containerInfo.lastUsed = Date.now();

      // Don't return to pool - mark as 'released' for cleanup to destroy later
      console.log(`🔓 Released container ${containerId.substring(0, 16)}... from session ${sessionId.substring(0, 8)}... (will be cleaned up)`);
    }

    this.sessionToContainer.delete(sessionId);
  }

  /**
   * v19: Recycle container - Nuclear cleanup and return to pool
   * This enables persistent containers that can be reused indefinitely
   */
  async recycleContainer(sessionId: string): Promise<void> {
    if (!ENABLE_PERSISTENT_RECYCLING) {
      // Fallback to destroy behavior if recycling disabled
      console.log(`⚠️ Persistent recycling disabled, destroying container instead`);
      const containerId = this.sessionToContainer.get(sessionId);
      if (containerId) {
        await this.destroyContainer(containerId);
      }
      return;
    }

    if (!this.sessionToContainer.has(sessionId)) {
      console.log(`⚠️ No container assigned to session ${sessionId.substring(0, 8)}...`);
      return;
    }

    const containerId = this.sessionToContainer.get(sessionId)!;
    const containerInfo = this.containers.get(containerId);

    if (!containerInfo) {
      console.log(`⚠️ Container for session ${sessionId} not found in registry`);
      return;
    }

    containerInfo.status = 'recycling';
    console.log(`♻️ Recycling container ${containerId.substring(0, 16)}... (session #${containerInfo.sessionCount})...`);

    try {
      if (!containerInfo.context || !containerInfo.page) {
        throw new Error('Container missing context or page (not pre-warmed)');
      }

      // 1. Nuclear cleanup: Clear ALL browser state
      await containerInfo.context.clearCookies();

      // 2. Clear localStorage, sessionStorage, IndexedDB
      await containerInfo.page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();

        // Clear IndexedDB
        if (window.indexedDB && window.indexedDB.databases) {
          window.indexedDB.databases().then(dbs => {
            dbs.forEach(db => {
              if (db.name) window.indexedDB.deleteDatabase(db.name);
            });
          });
        }
      });

      // 3. Refresh to clean QR page (1-2s, JS cached!)
      await containerInfo.page.goto('https://www.tiktok.com/login/qrcode', {
        waitUntil: 'domcontentloaded',
        timeout: 5000
      });

      // 4. Verify clean state
      await containerInfo.page.waitForSelector('img[alt="qrcode"]', {
        timeout: 10000,
        state: 'visible'
      });

      // 5. Back to pool
      containerInfo.status = 'pooled';
      containerInfo.sessionId = null;
      containerInfo.sessionCount++;
      containerInfo.lastUsed = Date.now();

      // Return to pool
      this.containerPool.push(containerId);
      this.sessionToContainer.delete(sessionId);

      console.log(`✅ Container recycled (${containerInfo.sessionCount} total sessions, pool: ${this.containerPool.length}/${MIN_POOL_SIZE})`);

      // 6. Periodic full restart (prevent memory leaks)
      if (containerInfo.sessionCount >= 100) {
        console.log(`🔄 Container ${containerId.substring(0, 16)}... hit 100 sessions, scheduling replacement...`);
        // Don't await - do in background
        this.replaceContainer(containerId).catch(err =>
          console.error(`Failed to replace container ${containerId}:`, err.message)
        );
      }

    } catch (error: any) {
      console.error(`❌ Recycling failed for ${containerId.substring(0, 16)}...: ${error.message}`);
      console.log(`🗑️ Falling back to destroy and replace`);

      // Fallback: Destroy and replace container
      try {
        await this.destroyContainer(containerId);
        // Pool maintenance will create a new one automatically
      } catch (destroyError: any) {
        console.error(`Failed to destroy failed container:`, destroyError.message);
      }
    }
  }

  /**
   * v19: Replace a container with a fresh one (after 100 sessions or on error)
   */
  private async replaceContainer(containerId: string): Promise<void> {
    console.log(`🔄 Replacing container ${containerId.substring(0, 16)}...`);

    try {
      // Destroy old container
      await this.destroyContainer(containerId);

      // Pool maintenance will create a new one automatically to maintain MIN_POOL_SIZE
      console.log(`✅ Container ${containerId.substring(0, 16)}... removed, pool maintenance will replenish`);
    } catch (error: any) {
      console.error(`Failed to replace container ${containerId}:`, error.message);
    }
  }

  async destroyContainer(containerId: string): Promise<void> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      console.log(`⚠️  Container ${containerId} not found in registry`);
      return;
    }

    console.log(`🗑️  Destroying container: ${containerId.substring(0, 16)}...`);

    if (containerInfo.browser) {
      try {
        await containerInfo.browser.close();
      } catch (error: any) {
        console.log(`⚠️  Failed to close browser for ${containerId}: ${error.message}`);
      }
    }

    try {
      execSync(`docker rm -f ${containerId}`, { stdio: 'ignore' });
    } catch (error: any) {
      console.log(`⚠️  Failed to remove container ${containerId}: ${error.message}`);
    }

    if (containerInfo.sessionId) {
      this.sessionToContainer.delete(containerInfo.sessionId);
    }

    const poolIndex = this.containerPool.indexOf(containerId);
    if (poolIndex > -1) {
      this.containerPool.splice(poolIndex, 1);
    }

    this.containers.delete(containerId);
  }

  private startCleanupInterval(): void {
    const timeoutMs = this.config.tcb?.container_idle_timeout_ms || 600000;

    setInterval(async () => {
      const now = Date.now();
      const toDestroy: string[] = [];

      for (const [containerId, containerInfo] of this.containers.entries()) {
        // Only destroy 'released' containers (used and returned), NOT 'pooled' (warm pool)
        if (containerInfo.status === 'released' && now - containerInfo.lastUsed > timeoutMs) {
          toDestroy.push(containerId);
        }
      }

      for (const containerId of toDestroy) {
        await this.destroyContainer(containerId);
      }

      if (toDestroy.length > 0) {
        console.log(`🧹 Cleaned up ${toDestroy.length} idle containers. Active: ${this.containers.size}`);
      }
    }, 60000); // Check every minute
  }

  private startPoolMaintenance(): void {
    const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

    setInterval(async () => {
      // LOCK: Prevent multiple maintenance cycles from running concurrently
      if (this.isMaintenanceRunning) {
        console.log('⏭️  Pool maintenance already running, skipping cycle...');
        return;
      }

      this.isMaintenanceRunning = true;

      try {
        const currentPoolSize = this.containerPool.length;

        if (currentPoolSize < MIN_POOL_SIZE) {
          const needed = MIN_POOL_SIZE - currentPoolSize;

          console.log(`🔧 Pool below minimum (${currentPoolSize}/${MIN_POOL_SIZE}). Creating ${needed} containers...`);

          // PARALLEL CREATION: Create all needed containers at once (faster)
          const creationPromises: Promise<string>[] = [];

          for (let i = 0; i < needed; i++) {
            creationPromises.push(
              this.createContainer()
                .then(containerId => {
                  console.log(`✅ Pool replenished: ${containerId.substring(0, 16)}... (${this.containerPool.length}/${MIN_POOL_SIZE})`);
                  return containerId;
                })
                .catch((error: any) => {
                  console.error(`❌ Failed to create maintenance container:`, error.message);
                  throw error;
                })
            );
          }

          // Wait for all containers to be created
          const results = await Promise.allSettled(creationPromises);

          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          const failed = results.filter(r => r.status === 'rejected').length;

          console.log(`🎯 Pool maintenance complete: ${succeeded} created, ${failed} failed. Pool size: ${this.containerPool.length}/${MIN_POOL_SIZE}`);
        }
      } catch (error: any) {
        console.error('❌ Pool maintenance error:', error.message);
      } finally {
        // UNLOCK: Allow next maintenance cycle
        this.isMaintenanceRunning = false;
      }
    }, CHECK_INTERVAL_MS);

    console.log(`🔧 Pool maintenance started (min size: ${MIN_POOL_SIZE}, check every ${CHECK_INTERVAL_MS / 1000}s)`);
  }

  private cleanupAllOrphanedContainers(): void {
    try {
      console.log('🧹 Cleaning up ALL tcb-browser containers from previous instance...');

      // Find ALL tcb-browser containers (running or exited) - they're orphans since we just started
      const allContainers = execSync(
        'docker ps -a --filter "name=tcb-browser" -q',
        { encoding: 'utf8' }
      ).trim().split('\n').filter(id => id.length > 0);

      if (allContainers.length === 0) {
        console.log('✅ No orphaned containers found');
        return;
      }

      console.log(`🗑️  Found ${allContainers.length} orphaned containers, force removing...`);

      for (const containerId of allContainers) {
        try {
          execSync(`docker rm -f ${containerId}`, { stdio: 'ignore' });
        } catch (error: any) {
          console.error(`⚠️  Failed to remove ${containerId}:`, error.message);
        }
      }

      console.log(`✅ Cleanup complete - starting fresh`);
    } catch (error: any) {
      console.error('Cleanup of orphaned containers failed:', error.message);
    }
  }

  getContainerBySession(sessionId: string): string | undefined {
    return this.sessionToContainer.get(sessionId);
  }

  getPoolSize(): number {
    return this.containerPool.length;
  }

  getStats(): { total: number; available: number; assigned: number; sessions: number } {
    let available = 0;
    let assigned = 0;

    for (const containerInfo of this.containers.values()) {
      if (containerInfo.status === 'pooled' || containerInfo.status === 'released') available++;
      else assigned++;
    }

    return {
      total: this.containers.size,
      available,
      assigned,
      sessions: this.sessionToContainer.size
    };
  }
}

// HTTP Server setup
import express from 'express';

async function main() {
  const app = express();
  const port = 3001;

  app.use(express.json());

  const browserManager = new BrowserManager();
  browserManager.initialize();

  // Assign a browser container to a session
  app.post('/assign/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      console.log(`🔄 Browser manager received assign request for session: ${sessionId.substring(0, 8)}...`);
      const container = await browserManager.assignContainer(sessionId);
      console.log(`🔄 Browser manager assigned container: ${container.containerId.substring(0, 20)}... (IP: ${container.ip})`);
      res.json({ container });
    } catch (error) {
      console.error('Failed to assign container:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Release a browser container from a session
  app.delete('/release/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      await browserManager.releaseContainer(sessionId);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to release container:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // POST version of release (for compatibility)
  app.post('/release/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      await browserManager.releaseContainer(sessionId);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to release container:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // v19: Recycle container by sessionId (persistent containers)
  app.post('/recycle/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;

      await browserManager.recycleContainer(sessionId);
      res.json({
        success: true,
        message: 'Container recycled and returned to pool',
        poolSize: browserManager.getPoolSize()
      });
    } catch (error) {
      console.error('Recycle endpoint error:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Destroy container by sessionId (for auth containers - legacy/fallback)
  app.post('/destroy/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;

      const containerId = browserManager.getContainerBySession(sessionId);

      if (containerId) {
        await browserManager.destroyContainer(containerId);
        console.log(`🗑️  Destroyed container for session ${sessionId.substring(0, 8)}...`);
        res.json({ success: true, containerId: containerId.substring(0, 16) });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    } catch (error) {
      console.error('Destroy endpoint error:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Destroy a container by containerId (legacy)
  app.delete('/destroy/:containerId', async (req, res) => {
    try {
      const { containerId } = req.params;
      await browserManager.destroyContainer(containerId);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to destroy container:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Pre-warm container pool (optional - pool maintenance auto-fills)
  app.post('/warmup', async (req, res) => {
    try {
      const { poolSize } = req.body;
      const targetSize = poolSize || MIN_POOL_SIZE;

      console.log(`🔥 Warmup request received: create ${targetSize} containers`);

      const results = {
        requested: targetSize,
        created: 0,
        failed: 0,
        errors: [] as string[]
      };

      // Create containers sequentially (safer than parallel)
      for (let i = 0; i < targetSize; i++) {
        try {
          const containerId = await browserManager.createContainer();
          // Add to pool via releaseContainer to maintain pool properly
          await browserManager.releaseContainer(`warmup-${Date.now()}-${i}`);
          results.created++;
          console.log(`✅ Warmed container ${i + 1}/${targetSize}: ${containerId.substring(0, 16)}...`);
        } catch (error: any) {
          results.failed++;
          results.errors.push(error.message);
          console.error(`❌ Failed to create warmup container ${i + 1}:`, error.message);
        }
      }

      console.log(`🔥 Warmup complete: ${results.created}/${results.requested} containers created`);

      res.json({
        success: results.created > 0,
        poolSize: browserManager.getPoolSize(),
        results
      });

    } catch (error: any) {
      console.error('Warmup endpoint error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get browser manager stats
  app.get('/stats', (req, res) => {
    const stats = browserManager.getStats();
    res.json(stats);
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`🎭 Browser Manager HTTP server running on port ${port}`);
  });
}

if (require.main === module) {
  main().catch(console.error);
}

export = BrowserManager;
