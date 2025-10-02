import express from 'express';
import { chromium, Browser, Page } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import jsQR from 'jsqr';
import { Jimp } from 'jimp';

const BrowserAutomationClient = require('../dist/lib/browser-automation-client');
const WebApiClient = require('../dist/lib/web-api-client');
const { PublicApiClient } = require('../dist/lib/public-api-client');
const { EnclaveModuleLoader } = require('../dist/lib/enclave-module-loader');
const QRExtractor = require('../dist/lib/qr-extractor');

const BROWSER_MANAGER_URL = process.env.BROWSER_MANAGER_URL || 'http://browser-manager:3001';

interface SessionData {
  user?: {
    sec_user_id?: string;
    username?: string;
    nickname?: string;
    uid?: string;
  };
  cookies?: any[];
  tokens?: any;
  device_id?: string;
}

interface BrowserInstance {
  browser: Browser;
  containerId: string;
  cdpUrl: string;
}

interface Config {
  tcb: {
    session_timeout_ms: number;
  };
}

interface AuthSession {
  authSessionId: string;
  sessionId: string;
  browser: Browser | null;
  page: Page | null;
  containerId: string | null;
  status: 'awaiting_scan' | 'complete' | 'failed';
  qrCodeData: string | null;
  sessionData: SessionData | null;
  startedAt: number;
}

class AuthSessionManager {
  private authSessions = new Map<string, AuthSession>();
  private readonly AUTH_TIMEOUT_MS = 120000; // 2 minutes

  generateAuthSessionId(): string {
    return crypto.randomUUID();
  }

  createAuthSession(sessionId: string): string {
    const authSessionId = this.generateAuthSessionId();
    this.authSessions.set(authSessionId, {
      authSessionId,
      sessionId,
      browser: null,
      page: null,
      containerId: null,
      status: 'awaiting_scan',
      qrCodeData: null,
      sessionData: null,
      startedAt: Date.now()
    });
    return authSessionId;
  }

  getAuthSession(authSessionId: string): AuthSession | null {
    return this.authSessions.get(authSessionId) || null;
  }

  updateAuthSession(authSessionId: string, updates: Partial<AuthSession>): void {
    const session = this.authSessions.get(authSessionId);
    if (session) {
      Object.assign(session, updates);
    }
  }

  removeAuthSession(authSessionId: string): void {
    this.authSessions.delete(authSessionId);
  }

  cleanupExpired(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [authSessionId, session] of this.authSessions.entries()) {
      if (now - session.startedAt > this.AUTH_TIMEOUT_MS) {
        expired.push(authSessionId);
      }
    }

    expired.forEach(authSessionId => {
      console.log(`🧹 Cleaning up expired auth session: ${authSessionId.substring(0, 8)}...`);
      this.removeAuthSession(authSessionId);
    });
  }
}

async function requestBrowserInstance(sessionId: string): Promise<BrowserInstance> {
  console.log(`🔄 Requesting browser instance from ${BROWSER_MANAGER_URL}/assign/${sessionId}`);
  const response = await fetch(`${BROWSER_MANAGER_URL}/assign/${sessionId}`, {
    method: 'POST'
  });
  console.log(`🔄 Browser manager response status: ${response.status}`);
  if (!response.ok) {
    throw new Error(`Failed to get browser instance: ${response.statusText}`);
  }
  const result = await response.json();
  console.log(`🔄 Browser instance assigned:`, result);

  let browser = null;
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      browser = await chromium.connectOverCDP(result.container.cdpUrl);
      break;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`🔄 CDP connection attempt ${i + 1}/${maxRetries} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return { browser: browser!, containerId: result.container.id, cdpUrl: result.container.cdpUrl };
}

async function releaseBrowserInstance(sessionId: string): Promise<void> {
  await fetch(`${BROWSER_MANAGER_URL}/release/${sessionId}`, {
    method: 'POST'
  });
}

class SessionManager {
  private sessions = new Map<string, SessionData>();
  private lastAccess = new Map<string, number>();
  private config: Config = {
    tcb: {
      session_timeout_ms: 3600000 // 1 hour
    }
  };

  initialize(): void {
    this.startCleanupInterval();
  }

  generateSessionId(): string {
    return crypto.randomUUID();
  }

  storeSession(sessionData: SessionData): string {
    const sessionId = sessionData.user?.sec_user_id || this.generateSessionId();
    this.sessions.set(sessionId, sessionData);
    this.lastAccess.set(sessionId, Date.now());
    return sessionId;
  }

  getSession(sessionId: string): SessionData | null {
    if (!this.sessions.has(sessionId)) {
      return null;
    }
    this.lastAccess.set(sessionId, Date.now());
    return this.sessions.get(sessionId) || null;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastAccess.delete(sessionId);
  }

  getAllSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private startCleanupInterval(): void {
    const timeoutMs = this.config.tcb?.session_timeout_ms || 3600000;

    setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];

      for (const [sessionId, lastAccess] of this.lastAccess.entries()) {
        if (now - lastAccess > timeoutMs) {
          expired.push(sessionId);
        }
      }

      expired.forEach(sessionId => {
        console.log(`🧹 Cleaning up expired session: ${sessionId.substring(0, 8)}...`);
        this.removeSession(sessionId);
      });

      if (expired.length > 0) {
        console.log(`🧹 Cleaned up ${expired.length} expired sessions. Active: ${this.getSessionCount()}`);
      }
    }, 300000); // Check every 5 minutes
  }
}

const app = express();
app.use(express.json());

let browser: Browser | null = null;
let page: Page | null = null;
let dstackSDK: any = null;
let encryptionKey: Buffer | null = null;
let sessionManager: SessionManager | null = null;
let authSessionManager: AuthSessionManager | null = null;
let moduleLoader: any = null;

async function initDStack(): Promise<void> {
  try {
    const { DstackSDK } = require('@phala/dstack-sdk');
    dstackSDK = new DstackSDK('/var/run/dstack.sock');
    await dstackSDK.connect();

    const keyResult = await dstackSDK.deriveKey('session-encryption', 'aes');
    encryptionKey = Buffer.from(keyResult.key.replace('0x', ''), 'hex').slice(0, 32);
    console.log('✅ DStack initialized, using TEE-derived encryption key');
  } catch (error: any) {
    console.log('⚠️ DStack unavailable, using fallback encryption key:', error.message);
    const seed = 'tcb-session-encryption-fallback-seed-12345';
    encryptionKey = crypto.createHash('sha256').update(seed).digest();
  }
}

function encryptSessionData(data: SessionData): string {
  if (!encryptionKey) throw new Error('Encryption key not initialized');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher('aes-256-cbc', encryptionKey);
  cipher.setAutoPadding(true);

  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
}

function decryptSessionData(encryptedData: any): SessionData {
  if (!encryptionKey) throw new Error('Encryption key not initialized');

  const { encrypted, iv, authTag, userId } = encryptedData;
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'hex'));

  if (userId) {
    decipher.setAAD(Buffer.from(userId, 'utf8'));
  }

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

app.post('/upload-session', (req, res) => {
  try {
    const { sessionData } = req.body;

    if (!sessionData) {
      return res.status(400).json({ error: 'Session data required' });
    }

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionId = sessionManager.storeSession(sessionData);
    const encryptedSession = encryptSessionData(sessionData);

    console.log(`📤 Session uploaded: ${sessionId.substring(0, 8)}... (user: @${sessionData.user?.username || 'unknown'})`);
    console.log(`📊 Active sessions: ${sessionManager.getSessionCount()}`);

    res.json({
      sessionId,
      encrypted: encryptedSession,
      status: 'uploaded'
    });
  } catch (error: any) {
    console.error('Session upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/load-session', (req, res) => {
  try {
    const { encryptedSession, sessionData } = req.body;

    let actualSessionData = sessionData;
    if (encryptedSession && !sessionData) {
      // Decrypt the session data
      actualSessionData = decryptSessionData(encryptedSession);
    }

    if (!actualSessionData) {
      return res.status(400).json({ error: 'Session data required' });
    }

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionId = sessionManager.storeSession(actualSessionData);

    console.log(`✅ Session loaded for user: ${actualSessionData.user?.username || 'unknown'} (ID: ${sessionId.substring(0, 8)}...)`);

    res.json({
      sessionId,
      status: 'loaded'
    });
  } catch (error: any) {
    console.error('Session load error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/sessions', (req, res) => {
  if (!sessionManager) {
    return res.status(500).json({ error: 'Session manager not initialized' });
  }

  const sessions = sessionManager.getAllSessions();
  res.json({
    count: sessions.length,
    sessions: sessions.map(id => ({
      id: id.substring(0, 8) + '...',
      fullId: id
    }))
  });
});

// Authentication endpoints
app.post('/auth/start/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!authSessionManager) {
      return res.status(500).json({ error: 'Auth session manager not initialized' });
    }

    console.log(`🔐 Starting authentication for session ${sessionId.substring(0, 8)}...`);

    // Create auth session
    const authSessionId = authSessionManager.createAuthSession(sessionId);

    // Start authentication flow asynchronously
    (async () => {
      let browserInstance = null;
      let authPage = null;

      try {
        // Request browser container
        browserInstance = await requestBrowserInstance(authSessionId);
        authSessionManager.updateAuthSession(authSessionId, {
          containerId: browserInstance.containerId
        });

        // Connect to browser
        const contexts = browserInstance.browser.contexts();
        const context = contexts[0] || await browserInstance.browser.newContext();
        authPage = await context.newPage();

        authSessionManager.updateAuthSession(authSessionId, {
          browser: browserInstance.browser,
          page: authPage
        });

        // Navigate to QR login page
        console.log(`🌐 Navigating to QR login page for auth ${authSessionId.substring(0, 8)}...`);
        await authPage.goto('https://www.tiktok.com/login/qrcode', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        await authPage.waitForTimeout(3000);

        // Extract and decode QR code
        const qrDataUrl = await QRExtractor.extractQRCodeFromPage(authPage);
        authSessionManager.updateAuthSession(authSessionId, { qrCodeData: qrDataUrl });

        console.log(`✅ QR code extracted for auth ${authSessionId.substring(0, 8)}...`);

        // Start polling for login completion
        await waitForLoginCompletion(authSessionId, authPage);

      } catch (error: any) {
        console.error(`❌ Auth flow error for ${authSessionId}:`, error.message);
        authSessionManager.updateAuthSession(authSessionId, {
          status: 'failed'
        });

        // Release browser container
        if (browserInstance) {
          try {
            await releaseBrowserInstance(authSessionId);
          } catch (releaseError) {
            console.error(`⚠️ Failed to release browser for ${authSessionId}`);
          }
        }
      }
    })();

    // Return immediately with authSessionId
    res.json({
      authSessionId,
      status: 'awaiting_scan'
    });

  } catch (error: any) {
    console.error('Auth start error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function waitForLoginCompletion(authSessionId: string, page: Page): Promise<void> {
  const timeout = 120000; // 2 minutes
  const startTime = Date.now();

  console.log(`⏳ Waiting for login completion for auth ${authSessionId.substring(0, 8)}...`);

  while (Date.now() - startTime < timeout) {
    try {
      const url = page.url();

      if (url.includes('/foryou') ||
          url.includes('/home') ||
          (url.includes('tiktok.com') && !url.includes('/login'))) {
        console.log(`✅ Login successful for auth ${authSessionId.substring(0, 8)}...`);

        // Extract session data
        const sessionData = await extractAuthData(page);

        authSessionManager!.updateAuthSession(authSessionId, {
          status: 'complete',
          sessionData
        });

        // Store session
        if (sessionManager && sessionData) {
          const newSessionId = sessionManager.storeSession(sessionData);
          console.log(`💾 Session stored: ${newSessionId.substring(0, 8)}...`);
        }

        // Release browser container
        try {
          await releaseBrowserInstance(authSessionId);
        } catch (releaseError) {
          console.error(`⚠️ Failed to release browser for ${authSessionId}`);
        }

        return;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      // Continue waiting
    }
  }

  // Timeout
  console.log(`⏰ Login timeout for auth ${authSessionId.substring(0, 8)}...`);
  authSessionManager!.updateAuthSession(authSessionId, { status: 'failed' });

  // Release browser container
  try {
    await releaseBrowserInstance(authSessionId);
  } catch (releaseError) {
    console.error(`⚠️ Failed to release browser for ${authSessionId}`);
  }
}

async function extractAuthData(page: Page): Promise<SessionData> {
  console.log('🔍 Extracting authentication data...');
  return await BrowserAutomationClient.extractAuthData(page);
}


app.get('/auth/poll/:authSessionId', (req, res) => {
  try {
    const { authSessionId } = req.params;

    if (!authSessionManager) {
      return res.status(500).json({ error: 'Auth session manager not initialized' });
    }

    const authSession = authSessionManager.getAuthSession(authSessionId);
    if (!authSession) {
      return res.status(404).json({ error: 'Auth session not found' });
    }

    if (authSession.status === 'awaiting_scan') {
      res.json({
        status: 'awaiting_scan',
        qrCodeData: authSession.qrCodeData
      });
    } else if (authSession.status === 'complete') {
      res.json({
        status: 'complete',
        sessionData: authSession.sessionData
      });

      // Clean up auth session after successful poll
      authSessionManager.removeAuthSession(authSessionId);
    } else {
      res.json({
        status: 'failed'
      });

      // Clean up failed auth session
      authSessionManager.removeAuthSession(authSessionId);
    }

  } catch (error: any) {
    console.error('Auth poll error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Playwright-based sampling endpoints
app.post('/playwright/foryoupage/sample/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { count = 10 } = req.body;

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionData = sessionManager.getSession(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`🎯 Starting For You page sampling for session ${sessionId.substring(0, 8)}... (count: ${count})`);

    const { browser: browserInstance, cdpUrl } = await requestBrowserInstance(sessionId);

    try {
      const client = new BrowserAutomationClient(sessionData, { cdpUrl });
      await client.initialize();
      const videos = await client.sampleForYouFeed(count);

      const result = {
        success: true,
        videos,
        method: 'browser_automation',
        sampled_at: new Date().toISOString()
      };

      console.log(`✅ Sampling completed: ${result.videos?.length || 0} videos`);
      res.json(result);

    } finally {
      await releaseBrowserInstance(sessionId);
    }

  } catch (error: any) {
    console.error(`❌ Sampling error for ${req.params.sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/playwright/watchhistory/sample/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { count = 10 } = req.body;

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionData = sessionManager.getSession(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`📜 Starting Watch History sampling for session ${sessionId.substring(0, 8)}... (count: ${count})`);

    const { browser: browserInstance, cdpUrl } = await requestBrowserInstance(sessionId);

    try {
      const client = new BrowserAutomationClient(sessionData, { cdpUrl });
      await client.initialize();
      const videos = await client.sampleWatchHistory(count);

      const result = {
        success: true,
        videos,
        method: 'browser_automation',
        sampled_at: new Date().toISOString()
      };

      console.log(`✅ Sampling completed: ${result.videos?.length || 0} videos`);
      res.json(result);

    } finally {
      await releaseBrowserInstance(sessionId);
    }

  } catch (error: any) {
    console.error(`❌ Sampling error for ${req.params.sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Module-based sampling endpoints (placeholder - not primary focus)
app.post('/modules/foryoupage/sample/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { count = 10, module_type = 'web' } = req.body;

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionData = sessionManager.getSession(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`🎯 Starting For You page sampling (module-based) for session ${sessionId.substring(0, 8)}...`);

    let result;

    if (module_type === 'mobile') {
      console.log('📱 Using Mobile API module...');

      // Load proprietary mobile auth module
      if (!process.env.MOBILE_AUTH_MODULE_URL) {
        throw new Error('MOBILE_AUTH_MODULE_URL environment variable is required');
      }
      const mobileAuth = await moduleLoader.loadModuleFromUrl(process.env.MOBILE_AUTH_MODULE_URL);

      const client = new PublicApiClient(sessionData, mobileAuth);
      result = await client.sampleTimeline(count);
    } else {
      console.log('📡 Using Web API module...');

      // Load proprietary web auth module
      if (!process.env.WEB_AUTH_MODULE_URL) {
        throw new Error('WEB_AUTH_MODULE_URL environment variable is required');
      }
      const webAuth = await moduleLoader.loadModuleFromUrl(process.env.WEB_AUTH_MODULE_URL);

      const client = new WebApiClient(sessionData, webAuth);
      result = await client.getRecommendedFeed(count);
    }

    if (result.success && result.raw) {
      const itemList = result.raw.itemList || result.raw.aweme_list || [];
      console.log(`✅ Module sampling completed: ${itemList.length} videos (raw response)`);
    }
    res.json(result);

  } catch (error: any) {
    console.error(`❌ Module sampling error for ${req.params.sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/modules/watchhistory/sample/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { count = 10 } = req.body;

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionData = sessionManager.getSession(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`📺 Starting Watch History sampling (module-based) for session ${sessionId.substring(0, 8)}...`);

    // Load web auth module (for base config) and watch history module (for watch history specific methods)
    if (!process.env.WEB_AUTH_MODULE_URL) {
      throw new Error('WEB_AUTH_MODULE_URL environment variable is required');
    }
    if (!process.env.WATCH_HISTORY_MODULE_URL) {
      throw new Error('WATCH_HISTORY_MODULE_URL environment variable is required');
    }
    const webAuth = await moduleLoader.loadModuleFromUrl(process.env.WEB_AUTH_MODULE_URL);
    const watchHistoryAuth = await moduleLoader.loadModuleFromUrl(process.env.WATCH_HISTORY_MODULE_URL);

    // Combine modules: watch history methods override web auth where they exist
    // WebApiClient will use watchHistoryAuth.generateAuthHeaders for watch history requests
    const combinedAuth = { ...webAuth, ...watchHistoryAuth };

    const client = new WebApiClient(sessionData, combinedAuth as any);
    const result = await client.getWatchHistory(count);

    if (result.success && result.raw) {
      const itemList = result.raw.aweme_list || result.raw.itemList || [];
      console.log(`✅ Module sampling completed: ${itemList.length} videos (raw response)`);
    }
    res.json(result);

  } catch (error: any) {
    console.error(`❌ Module sampling error for ${req.params.sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Deprecated: Use /playwright/foryoupage/sample instead
app.post('/scrape/:sessionId', async (req, res) => {
  console.log('⚠️  /scrape endpoint is deprecated, use /playwright/foryoupage/sample instead');
  res.status(410).json({
    error: 'Endpoint deprecated',
    message: 'Use /playwright/foryoupage/sample/:sessionId instead'
  });
});

// Container management endpoints
app.post('/containers/create', async (req, res) => {
  try {
    const { proxy } = req.body;

    const response = await fetch(`${BROWSER_MANAGER_URL}/assign/temp-${Date.now()}`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`Failed to create container: ${response.statusText}`);
    }

    const data = await response.json();
    res.json({
      containerId: data.container.containerId,
      ip: data.container.ip,
      cdpUrl: data.container.cdpUrl,
      status: data.container.status
    });
  } catch (error: any) {
    console.error('Failed to create container:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/containers/:containerId', async (req, res) => {
  try {
    const { containerId } = req.params;

    const response = await fetch(`${BROWSER_MANAGER_URL}/destroy/${containerId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error(`Failed to delete container: ${response.statusText}`);
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to delete container:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/containers', async (req, res) => {
  try {
    const response = await fetch(`${BROWSER_MANAGER_URL}/stats`);

    if (!response.ok) {
      throw new Error(`Failed to get containers: ${response.statusText}`);
    }

    const stats = await response.json();
    res.json({
      total: stats.total,
      available: stats.available,
      assigned: stats.assigned,
      containers: []
    });
  } catch (error: any) {
    console.error('Failed to get containers:', error);
    res.status(500).json({ error: error.message });
  }
});

const startTime = Date.now();

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    system: 'healthy',
    sessions: sessionManager?.getSessionCount() || 0,
    activeSessions: sessionManager?.getSessionCount() || 0,
    maxSessions: 50,
    uptime: (Date.now() - startTime) / 1000,
    dstack: !!dstackSDK,
    encryption: !!encryptionKey,
    modules: {
      web: !!process.env.WEB_AUTH_MODULE_URL,
      mobile: !!process.env.MOBILE_AUTH_MODULE_URL
    }
  });
});

const PORT = process.env.PORT || 3000;

async function startServer(): Promise<void> {
  await initDStack();

  sessionManager = new SessionManager();
  sessionManager.initialize();

  authSessionManager = new AuthSessionManager();
  console.log('🔐 Auth session manager initialized');

  moduleLoader = new EnclaveModuleLoader();
  console.log('🔒 Proprietary module loader initialized');

  // Cleanup expired auth sessions periodically
  setInterval(() => {
    authSessionManager?.cleanupExpired();
  }, 60000); // Every minute

  app.listen(PORT, () => {
    console.log(`🚀 Multi-User TCB Server running on port ${PORT}`);
    console.log(`📊 Session timeout: ${Math.round(3600000 / 60000)} minutes`);
    console.log(`🔐 Auth session timeout: ${Math.round(120000 / 1000)} seconds`);
  });
}

startServer().catch(console.error);