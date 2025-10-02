import { execSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import * as fs from 'fs';

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
  status: 'available' | 'assigned';
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

    this.startCleanupInterval();
  }

  private generateContainerId(): string {
    return `tcb-browser-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  }

  async createContainer(): Promise<string> {
    const containerId = this.generateContainerId();
    const network = process.env.DOCKER_NETWORK || 'xordi-proprietary-modules_enclave-api-network';
    const subnet = '172.22.0.0/24';

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

      const baseIP = subnet.split('/')[0].split('.').slice(0, 3).join('.');
      const containerIP = `${baseIP}.${100 + this.containers.size}`;

      const dockerCmd = [
        'docker', 'run', '-d',
        '--name', containerId,
        '--hostname', containerId,
        '--network', network,
        '--ip', containerIP,
        '--env', `CONTAINER_NAME=${containerId}`,
        '--env', `NEKO_NAT1TO1=${containerIP}`,
        '--restart', 'no',
        process.env.TCB_BROWSER_IMAGE || 'xordi-proprietary-modules-tcb-browser:latest'
      ];

      // Optional proxy configuration
      if (process.env.CHROMIUM_PROXY_ARG) {
        dockerCmd.splice(dockerCmd.length - 2, 0, '--env', `CHROMIUM_PROXY_ARG=${process.env.CHROMIUM_PROXY_ARG}`);
      }

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
        status: 'available',
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
      containerInfo.status = 'available';
      containerInfo.sessionId = null;
      containerInfo.lastUsed = Date.now();

      this.containerPool.push(containerId);
      console.log(`🔓 Released container ${containerId.substring(0, 16)}... from session ${sessionId.substring(0, 8)}...`);
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
        if (containerInfo.status === 'available' && now - containerInfo.lastUsed > timeoutMs) {
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

  getStats(): { total: number; available: number; assigned: number; sessions: number } {
    let available = 0;
    let assigned = 0;

    for (const containerInfo of this.containers.values()) {
      if (containerInfo.status === 'available') available++;
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

  // Destroy a container
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