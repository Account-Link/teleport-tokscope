import { execSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import * as fs from 'fs';

// Configuration
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE || '6');

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

  initialize(): void {
    this.isInitialized = true;

    console.log('🎭 Browser Manager initialized');
    console.log(`📊 Config: ${Math.round((this.config.tcb?.container_idle_timeout_ms || 600000) / 60000)} min idle timeout`);
    console.log(`📊 Config: ${MIN_POOL_SIZE} container pool size`);

    this.startCleanupInterval();
    this.startPoolMaintenance();
    this.cleanupExitedContainers(); // Clean up existing orphaned containers
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
      if (process.env.BROWSER_CPU_LIMIT) {
        dockerCmd.push('--cpus', process.env.BROWSER_CPU_LIMIT);
      }
      if (process.env.BROWSER_MEMORY_LIMIT) {
        dockerCmd.push('--memory', process.env.BROWSER_MEMORY_LIMIT);
      }
      if (process.env.BROWSER_MEMORY_RESERVATION) {
        dockerCmd.push('--memory-reservation', process.env.BROWSER_MEMORY_RESERVATION);
      }

      // VPN proxy configuration (random bucket for QR auth load balancing)
      if (process.env.ENABLE_VPN_ROUTING === 'true') {
        // Random bucket selection (0-3) for load balancing across Chisel tunnels
        const bucket = Math.floor(Math.random() * 4);
        const proxyArg = `--proxy-server=socks5://chisel-client-${bucket}:1080`;
        console.log(`🌐 Container ${containerId} assigned to chisel-client-${bucket}`);
        dockerCmd.push('--env', `CHROMIUM_PROXY_ARG=${proxyArg}`);
      }

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

      const containerInfo: ContainerInfo = {
        containerId,
        shortId: shortContainerId,
        ip: containerIP,
        cdpUrl,
        browser,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        status: 'pooled',
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
      containerId = await this.createContainer();
      const index = this.containerPool.indexOf(containerId);
      if (index > -1) {
        this.containerPool.splice(index, 1);
      }
    }

    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container ${containerId} not found in registry`);
    }

    containerInfo.status = 'assigned';
    containerInfo.sessionId = sessionId;
    containerInfo.lastUsed = Date.now();

    this.sessionToContainer.set(sessionId, containerId);

    console.log(`📦 Assigned container ${containerId.substring(0, 16)}... to session ${sessionId.substring(0, 8)}...`);
    return containerInfo;
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
      const currentPoolSize = this.containerPool.length;

      if (currentPoolSize < MIN_POOL_SIZE) {
        const needed = MIN_POOL_SIZE - currentPoolSize;
        console.log(`🔧 Pool below minimum (${currentPoolSize}/${MIN_POOL_SIZE}). Creating ${needed} containers in parallel...`);

        // Create containers in parallel for faster pool initialization
        const creationPromises = Array(needed).fill(null).map(async () => {
          try {
            const containerId = await this.createContainer();
            console.log(`✅ Pool replenished: ${containerId.substring(0, 16)}... (${this.containerPool.length}/${MIN_POOL_SIZE})`);
          } catch (error: any) {
            console.error(`❌ Failed to create maintenance container:`, error.message);
          }
        });

        await Promise.all(creationPromises);
        console.log(`✅ Pool maintenance complete: ${this.containerPool.length}/${MIN_POOL_SIZE} containers ready`);
      }
    }, CHECK_INTERVAL_MS);

    console.log(`🔧 Pool maintenance started (min size: ${MIN_POOL_SIZE}, check every ${CHECK_INTERVAL_MS / 1000}s)`);
  }

  private cleanupExitedContainers(): void {
    try {
      console.log('🧹 Cleaning up exited tcb-browser containers...');

      // Find all exited tcb-browser containers
      const exitedContainers = execSync(
        'docker ps -a --filter "name=tcb-browser" --filter "status=exited" -q',
        { encoding: 'utf8' }
      ).trim().split('\n').filter(id => id.length > 0);

      if (exitedContainers.length === 0) {
        console.log('✅ No exited containers found');
        return;
      }

      console.log(`🗑️  Found ${exitedContainers.length} exited containers, removing...`);

      for (const containerId of exitedContainers) {
        try {
          execSync(`docker rm ${containerId}`, { stdio: 'ignore' });
        } catch (error: any) {
          console.error(`⚠️  Failed to remove ${containerId}:`, error.message);
        }
      }

      console.log(`✅ Cleanup complete`);
    } catch (error: any) {
      console.error('Cleanup of exited containers failed:', error.message);
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
      console.log(`🔄 Browser manager assigned container:`, container);
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

  // Destroy container by sessionId (for auth containers)
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