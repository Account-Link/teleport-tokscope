import { execSync } from 'child_process';
// v3-v: Removed Playwright - browser-manager is Docker lifecycle only
// tokscope-enclave (server.ts) now owns the single CDP connection
import * as fs from 'fs';

// Configuration
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE || '6');

interface Config {
  tcb: {
    container_idle_timeout_ms: number;
  };
}

// v3-v: Simplified - no browser/context/page (server.ts owns CDP)
interface ContainerInfo {
  containerId: string;
  shortId: string;
  ip: string;
  cdpUrl: string;
  createdAt: number;
  lastUsed: number;
  status: 'pooled' | 'assigned' | 'released';
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

  /**
   * v3-v: Wait for browser to be ready via HTTP endpoint (no CDP required)
   * Chrome's DevTools Protocol exposes /json/version for health checks
   */
  private async waitForBrowserReady(ip: string, maxRetries = 10): Promise<void> {
    const cdpVersionUrl = `http://${ip}:9223/json/version`;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(cdpVersionUrl, {
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.ok) {
          const data = await response.json();
          console.log(`✅ Browser ready: ${data.Browser || 'Chromium'}`);
          return;
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          console.log(`🔄 Browser not ready yet (attempt ${i + 1}/${maxRetries})`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    throw new Error('Browser failed to become ready within timeout');
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

      // v3-v: Wait for browser ready via HTTP (NO CDP connection)
      // tokscope-enclave (server.ts) will create the single CDP connection
      const cdpUrl = `http://${containerIP}:9223`;
      await this.waitForBrowserReady(containerIP);

      // v3-v: Simplified ContainerInfo - no browser/context/page
      const containerInfo: ContainerInfo = {
        containerId,
        shortId: shortContainerId,
        ip: containerIP,
        cdpUrl,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        status: 'pooled',
        sessionId: null
      };

      console.log(`✅ Container ${containerId.substring(0, 16)}... ready (awaiting CDP from server.ts)`);

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

    // JIT: Configure proxy now that container is being used for auth
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

    // v3-v: NO navigation here - server.ts owns CDP and will navigate
    console.log(`✅ Container ${containerId.substring(0, 16)}... assigned (proxy configured, awaiting CDP from server.ts)`);

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
   * v3-q: Destroy container after auth (no recycling - prevents state contamination)
   * Pool maintenance will create fresh containers to maintain MIN_POOL_SIZE
   */
  async recycleContainer(sessionId: string): Promise<void> {
    const containerId = this.sessionToContainer.get(sessionId);
    if (containerId) {
      console.log(`🗑️ Destroying auth container for session ${sessionId.substring(0, 8)}...`);
      await this.destroyContainer(containerId);
      this.sessionToContainer.delete(sessionId);
    } else {
      console.log(`⚠️ No container found for session ${sessionId.substring(0, 8)}...`);
    }
  }

  async destroyContainer(containerId: string): Promise<void> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      console.log(`⚠️  Container ${containerId} not found in registry`);
      return;
    }

    console.log(`🗑️  Destroying container: ${containerId.substring(0, 16)}...`);

    // v3-v: No browser.close() - we don't own the CDP connection
    // server.ts owns the connection and is responsible for cleanup

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
