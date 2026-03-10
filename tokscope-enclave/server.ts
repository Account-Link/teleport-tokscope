import express from 'express';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import jsQR from 'jsqr';
import { log } from './lib/log';
import { Jimp } from 'jimp';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const BrowserAutomationClient = require('./lib/browser-automation-client');
const WebApiClient = require('./lib/web-api-client');
const { PublicApiClient } = require('./lib/public-api-client');
const { EnclaveModuleLoader } = require('./lib/enclave-module-loader');
const QRExtractor = require('./lib/qr-extractor');
const xordiSecurityModule = require('./xordi-security-module');
const teeCrypto = require('./tee-crypto');

// Issue 7a: Prevent crashes from unhandled promise rejections
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason?.message || reason);
  // Don't exit - let the process continue serving other requests
});

process.on('uncaughtException', (error: Error) => {
  console.error('🚨 Uncaught Exception:', error.message);
  console.error(error.stack);
  // Don't exit for recoverable errors
});

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
  install_id?: string;
}

// v3-v: Updated - server.ts now owns CDP connection and creates context/page
interface BrowserInstance {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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
  qrDecodedUrl?: string | null;  // Magic link URL
  sessionData: SessionData | null;
  startedAt: number;
  timeoutMs: number;  // v1.1.3login: per-session timeout (QR=AUTH_TIMEOUT_MS, portal=portalTimeoutMs)
  portalSessionUrl?: string | null;  // v1.1.3login: session-token portal URL for WebRTC access
}

// v3-s: Debug screenshot storage (in-memory with TTL)
interface DebugScreenshot {
  buffer: Buffer;
  timestamp: number;
  authSessionId: string;
  reason: string;  // 'qr_visible' | 'url_change' | 'timeout' | 'success'
  url: string;
  title: string;
  step: number;    // 1, 2, 3... for ordering within session
}

const debugScreenshots = new Map<string, DebugScreenshot>();
const DEBUG_SCREENSHOT_TTL_MS = parseInt(process.env.DEBUG_SCREENSHOT_TTL_MS || '300000'); // 5 min default

// Cleanup expired screenshots every minute
setInterval(() => {
  if (process.env.ENABLE_DEBUG_SCREENSHOTS !== 'true') return;
  const now = Date.now();
  for (const [token, screenshot] of debugScreenshots.entries()) {
    if (now - screenshot.timestamp > DEBUG_SCREENSHOT_TTL_MS) {
      debugScreenshots.delete(token);
    }
  }
}, 60000);

// z-4: Track step counter per auth session
const authScreenshotSteps = new Map<string, number>();

/**
 * v3-s: Capture debug screenshot and return access URL
 * Only runs when ENABLE_DEBUG_SCREENSHOTS=true
 */
async function captureDebugScreenshot(
  page: Page,
  authSessionId: string,
  reason: string
): Promise<string | null> {
  if (process.env.ENABLE_DEBUG_SCREENSHOTS !== 'true') {
    return null;
  }

  try {
    const buffer = await page.screenshot({ fullPage: true });
    const token = crypto.randomBytes(16).toString('hex');
    const url = page.url();
    const title = await page.title();

    // z-4: Increment step counter for this auth session
    const currentStep = (authScreenshotSteps.get(authSessionId) || 0) + 1;
    authScreenshotSteps.set(authSessionId, currentStep);

    debugScreenshots.set(token, {
      buffer,
      timestamp: Date.now(),
      authSessionId,
      reason,
      url,
      title,
      step: currentStep
    });

    // Log clickable URL (appears in docker logs)
    const baseUrl = process.env.DEBUG_SCREENSHOT_BASE_URL || '';
    const screenshotUrl = baseUrl
      ? `${baseUrl}/debug/screenshot/${token}`
      : `/debug/screenshot/${token}`;
    console.log(`📸 Debug screenshot: ${screenshotUrl}`);
    console.log(`   Auth: ${authSessionId.substring(0, 8)}..., Reason: ${reason}`);

    return token;
  } catch (err: any) {
    console.error(`⚠️ Screenshot capture failed: ${err.message}`);
    return null;
  }
}

class AuthSessionManager {
  private authSessions = new Map<string, AuthSession>();
  private readonly AUTH_TIMEOUT_MS = 120000; // 2 minutes

  generateAuthSessionId(): string {
    return crypto.randomUUID();
  }

  createAuthSession(sessionId: string, timeoutMs?: number): string {
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
      startedAt: Date.now(),
      // v1.1.3login: per-session timeout — QR sessions use AUTH_TIMEOUT_MS, portal sessions use portalTimeoutMs
      timeoutMs: timeoutMs !== undefined ? timeoutMs : this.AUTH_TIMEOUT_MS,
      portalSessionUrl: null
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
    authScreenshotSteps.delete(authSessionId);
  }

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [authSessionId, session] of this.authSessions.entries()) {
      // v1.1.3login: use per-session timeout (QR=AUTH_TIMEOUT_MS, portal=portalTimeoutMs)
      const sessionTimeoutMs = session.timeoutMs !== undefined ? session.timeoutMs : this.AUTH_TIMEOUT_MS;
      if (now - session.startedAt > sessionTimeoutMs) {
        expired.push(authSessionId);
      }
    }

    for (const authSessionId of expired) {
      console.log(`🧹 Cleaning up expired auth session: ${authSessionId.substring(0, 8)}...`);
      log.ok('AUTH', 'session_expired', { session: authSessionId.substring(0, 8) });

      // CRITICAL: Release the browser container BEFORE removing session
      try {
        await destroyAuthContainer(authSessionId);
        console.log(`✅ Released container for expired session ${authSessionId.substring(0, 8)}...`);
      } catch (e) {
        console.error(`⚠️ Failed to release container for ${authSessionId}:`, e);
      }

      this.removeAuthSession(authSessionId);
    }

    if (expired.length > 0) {
      console.log(`🧹 Cleaned up ${expired.length} expired sessions`);
    }
  }
}

/**
 * v3-v: Request browser instance - NOW CREATES THE ONLY CDP CONNECTION
 * This is the fix for the dual CDP connection bug (Solution F)
 * browser-manager only manages Docker lifecycle, we own CDP/context/page
 */
async function requestBrowserInstance(sessionId: string, portalMode: boolean = false): Promise<BrowserInstance> {
  // v1.1.3combo2: portal mode uses on-demand container with host port publishing (/assign-portal)
  const assignPath = portalMode ? `assign-portal/${sessionId}` : `assign/${sessionId}`;
  console.log(`🔄 Requesting browser instance from ${BROWSER_MANAGER_URL}/${assignPath}`);
  const response = await fetch(`${BROWSER_MANAGER_URL}/${assignPath}`, {
    method: 'POST'
  });
  console.log(`🔄 Browser manager response status: ${response.status}`);
  if (!response.ok) {
    throw new Error(`Failed to get browser instance: ${response.statusText}`);
  }
  const result = await response.json();
  console.log(`🔄 Container assigned: ${result.container.containerId?.substring(0, 20)}... (IP: ${result.container.ip})`);

  // v3-v: Connect via CDP - THIS IS THE ONLY CONNECTION
  // browser-manager no longer creates a CDP connection
  let browser = null;
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      browser = await chromium.connectOverCDP(result.container.cdpUrl);
      break;
    } catch (error: any) {
      if (i === maxRetries - 1) throw error;
      log.warn('AUTH', 'cdp_retry', { session: sessionId.substring(0, 8), attempt: i + 1, max_attempts: maxRetries, error: error.message });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // v1.1.3F2: Reuse default context + pre-navigated page (tiktok.com already loaded)
  // browser-manager pre-navigated the default page via CDP during pool warmup.
  // Playwright's connectOverCDP sees that page via contexts()[0].pages()[0].
  console.log(`📦 Acquiring browser context (v1.1.3F2: reuse pre-navigated page)...`);

  let context, page;
  try {
    const contexts = browser!.contexts();
    context = contexts[0]; // Default context from connectOverCDP
    const existingPages = context.pages();
    if (existingPages.length > 0) {
      page = existingPages[0];
      console.log(`✅ Browser instance ready (reusing pre-navigated page at ${page.url()})`);
    } else {
      page = await context.newPage();
      console.log(`✅ Browser instance ready (fresh page, no pre-nav available)`);
    }
  } catch (error: any) {
    if (error.name === 'TargetClosedError' || error.message?.includes('Target closed')) {
      console.error(`⚠️ Browser closed during context setup for ${sessionId}`);
      throw new Error('BROWSER_DISCONNECTED');
    }
    throw error;
  }

  // z-4 Phase 2b: Verify relay is configured
  try {
    const relayStatus = await fetch(`http://${result.container.ip}:1081/status`);
    const status = await relayStatus.json();
    if (status.mode === 'proxied') {
      console.log(`✅ [relay] configured → ${status.upstream}`);
    } else {
      console.log(`⚠️ [relay] NOT configured (mode: ${status.mode})`);
    }
  } catch (e) {
    console.log(`⚠️ [relay] status check failed`);
  }

  // z-4 Phase 2a: Log failed network requests
  page.on('requestfailed', request => {
    const url = request.url();
    const failure = request.failure();
    if (url.includes('tiktok.com')) {
      console.log(`❌ [network] ${url.substring(0, 80)}... - ${failure?.errorText || 'unknown'}`);
    }
  });

  // z-5a: Removed QR poll status logging (was causing screenshot spam)
  // Detection reverted to v2.4 style: URL-based + sessionid cookie

  // z-4 Phase 2d: Log URL changes (domain + path only)
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      try {
        const parsed = new URL(frame.url());
        console.log(`🔀 [url] ${parsed.hostname}${parsed.pathname}`);
      } catch (e) { /* ignore invalid URLs */ }
    }
  });

  // z-4 Phase 2e: Log when auth cookies are set via Set-Cookie header
  // Use headersArray() to handle multiple Set-Cookie headers correctly
  const AUTH_COOKIES = ['sessionid', 'sid_guard', 'uid_tt', 'sid_tt'];
  const seenCookies = new Set<string>();
  page.on('response', async response => {
    try {
      const headers = await response.headersArray();
      const setCookies = headers
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value);

      for (const cookieStr of setCookies) {
        for (const cookieName of AUTH_COOKIES) {
          if (cookieStr.startsWith(`${cookieName}=`) && !seenCookies.has(cookieName)) {
            seenCookies.add(cookieName);
            console.log(`🍪 [+cookie] ${cookieName}`);
          }
        }
      }
    } catch (e) { /* response may be closed */ }
  });

  return {
    browser: browser!,
    context: context!,
    page: page!,
    containerId: result.container.containerId,
    cdpUrl: result.container.cdpUrl
  };
}

async function releaseBrowserInstance(sessionId: string): Promise<void> {
  await fetch(`${BROWSER_MANAGER_URL}/release/${sessionId}`, {
    method: 'POST'
  });
}

/**
 * v3-q: Destroy auth container after use (prevents state contamination)
 * Browser-manager will destroy container and pool maintenance will create fresh ones
 */
async function destroyAuthContainer(sessionId: string): Promise<void> {
  try {
    const response = await fetch(`${BROWSER_MANAGER_URL}/recycle/${sessionId}`, {
      method: 'POST'
    });
    if (!response.ok) {
      throw new Error(`Failed to destroy container: ${response.statusText}`);
    }
    console.log(`🗑️ Destroyed auth container for session ${sessionId.substring(0, 8)}...`);
  } catch (error: any) {
    console.error(`⚠️ Failed to destroy container for ${sessionId}:`, error.message);
  }
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
let lastKnownGatewayUrl: string = ''; // Set from borgcube's gatewayUrl in portal requests
let sessionManager: SessionManager | null = null;
let authSessionManager: AuthSessionManager | null = null;
let moduleLoader: any = null;

// v1.1.3login: In-memory portal session token store (single-use, time-limited)
interface PortalSessionToken {
  authSessionId: string;
  containerId: string | null;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}
const portalSessionTokens = new Map<string, PortalSessionToken>();

// v1.1.3login: Per-container Neko credential store (set at container creation in browser-manager.ts)
// Populated via POST /internal/container-neko-creds when browser-manager creates a container
interface NekoCredentials {
  userPassword: string;
  adminPassword: string;
}
const containerNekoCreds = new Map<string, NekoCredentials>();
const containerNekoApiTokens = new Map<string, string>();

// Retrieve container IP from browser-manager
async function getContainerIp(containerId: string): Promise<string | null> {
  try {
    const bmUrl = process.env.BROWSER_MANAGER_URL || 'http://browser-manager:3001';
    const resp = await fetch(`${bmUrl}/stats`);
    if (!resp.ok) return null;
    // Fall back to Docker inspect if needed
    const { execAsync: _exec } = await import('child_process').then(m => ({ execAsync: (cmd: string) => new Promise<{stdout: string}>((res, rej) => m.exec(cmd, (err, stdout) => err ? rej(err) : res({ stdout }))) }));
    const { stdout } = await _exec(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Cleanup expired portal session tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of portalSessionTokens.entries()) {
    if (now > data.expiresAt) {
      portalSessionTokens.delete(token);
    }
  }
}, 60000);

async function initDStack(): Promise<void> {
  try {
    const { DstackClient } = require('@phala/dstack-sdk');
    const client = new DstackClient();

    // Session encryption key
    const sessionKeyResult = await client.getKey('session-encryption', 'aes');
    encryptionKey = Buffer.from(sessionKeyResult.key).slice(0, 32);

    // Cookie encryption key (separate derivation path = separate key)
    const cookieKeyResult = await client.getKey('cookie-encryption', 'aes');
    const cookieKey = Buffer.from(cookieKeyResult.key).slice(0, 32);
    teeCrypto.setDStackKey(cookieKey);

    // Keep reference for /health endpoint
    dstackSDK = client;

    console.log('✅ DStack initialized, using TEE-derived keys for sessions + cookies');
  } catch (error: any) {
    console.log('⚠️ DStack unavailable, using fallback encryption keys:', error.message);
    const seed = 'tcb-session-encryption-fallback-seed-12345';
    encryptionKey = crypto.createHash('sha256').update(seed).digest();
    // tee-crypto.js keeps its constructor fallback key
  }
}

function encryptSessionData(data: SessionData): string {
  if (!encryptionKey) throw new Error('Encryption key not initialized');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
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
    console.error('Session upload error:', error.message);
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
    console.error('Session load error:', error.message);
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
    // v1.1.3login: accept portalMode, portalTimeoutMs, portalLoginUrl in addition to preAuthToken
    const {
      preAuthToken,
      portalMode,
      portalTimeoutMs: rawPortalTimeoutMs,
      portalLoginUrl,
      gatewayUrl
    } = req.body;

    if (!authSessionManager) {
      return res.status(500).json({ error: 'Auth session manager not initialized' });
    }

    // v1.1.3login: portal mode — validate and resolve timeout
    const isPortalMode = !!portalMode;
    const DEFAULT_PORTAL_TIMEOUT_MS = 300000; // 5 minutes
    const portalTimeoutMs = isPortalMode
      ? (rawPortalTimeoutMs && Number.isFinite(Number(rawPortalTimeoutMs)) && Number(rawPortalTimeoutMs) > 0
          ? Number(rawPortalTimeoutMs)
          : DEFAULT_PORTAL_TIMEOUT_MS)
      : 0;

    if (preAuthToken) {
      console.log(`🔐 Starting TEE-integrated authentication for session ${sessionId.substring(0, 8)}... (pre-auth token provided)`);
    } else {
      console.log(`🔐 Starting legacy authentication for session ${sessionId.substring(0, 8)}... (no pre-auth token)`);
    }
    if (isPortalMode) {
      console.log(`🌐 Portal mode enabled for session ${sessionId.substring(0, 8)}... (timeout: ${portalTimeoutMs}ms)`);
    }
    log.ok('AUTH', 'auth_started', { session: sessionId.substring(0, 8), mode: isPortalMode ? 'portal' : 'qr' });

    // Create auth session with per-session timeout
    const authSessionTimeoutMs = isPortalMode ? portalTimeoutMs : undefined;
    const authSessionId = authSessionManager.createAuthSession(sessionId, authSessionTimeoutMs);

    // Start authentication flow asynchronously
    (async () => {
      let browserInstance: BrowserInstance | null = null;

      try {
        // v3-v: Request browser container - NOW INCLUDES context/page creation
        // This is the Solution F fix: single CDP connection owns everything
        // v1.1.3combo2: portal mode uses /assign-portal (on-demand, with port publishing)
        browserInstance = await requestBrowserInstance(authSessionId, isPortalMode);

        authSessionManager.updateAuthSession(authSessionId, {
          containerId: browserInstance.containerId,
          browser: browserInstance.browser,
          page: browserInstance.page
        });

        const authPage = browserInstance.page;

        // v1.1.3login: Portal mode branch — skip QR, navigate to email login, start cookie-only detection
        if (isPortalMode) {
          const loginUrl = portalLoginUrl
            || process.env.PORTAL_LOGIN_URL
            || 'https://www.tiktok.com/login/phone-or-email/email';

          console.log(`🌐 Portal mode: navigating to ${loginUrl} for ${authSessionId.substring(0, 8)}...`);
          await authPage.goto(loginUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          console.log(`✅ Portal login page loaded for ${authSessionId.substring(0, 8)}...`);

          // Generate one-time session token (256-bit random, maps to container Neko credentials)
          const sessionToken = crypto.randomBytes(32).toString('hex');

          // Build portal URL using gatewayUrl from borgcube (knows the CVM's public URL)
          const dstackGateway = gatewayUrl || process.env.DSTACK_GATEWAY_URL || lastKnownGatewayUrl;
          let portalSessionUrl: string;
          if (dstackGateway) {
            // Cache for use in /auth/portal redirect (Neko URL construction)
            lastKnownGatewayUrl = dstackGateway;
            portalSessionUrl = `${dstackGateway}/auth/portal/${sessionToken}`;
          } else {
            // Fallback for non-Dstack environments: use local URL
            const localPort = process.env.PORT || '3000';
            portalSessionUrl = `http://localhost:${localPort}/auth/portal/${sessionToken}`;
          }

          // Store session token in-memory for auth proxy validation (single-use, time-limited)
          portalSessionTokens.set(sessionToken, {
            authSessionId,
            containerId: browserInstance.containerId,
            createdAt: Date.now(),
            expiresAt: Date.now() + portalTimeoutMs,
            used: false
          });

          // Store portal URL in auth session for polling
          authSessionManager.updateAuthSession(authSessionId, {
            portalSessionUrl
          });

          console.log(`🔑 Portal session token generated for ${authSessionId.substring(0, 8)}...`);

          // Start cookie-only detection loop (no URL-change dependency)
          await waitForPortalLoginCompletion(authSessionId, authPage, preAuthToken, portalTimeoutMs);

          return; // Portal flow complete — do not fall through to QR flow
        }

        // v1.1.3F2: Navigate from pre-loaded tiktok.com → /login/qrcode (same-origin, fast)
        const navStart = Date.now();
        console.log(`🌐 Navigating to QR login page for auth ${authSessionId.substring(0, 8)}... (from ${authPage.url()})`);
        await authPage.goto('https://www.tiktok.com/login/qrcode', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        console.log(`⏱️ QR page loaded in ${Date.now() - navStart}ms for ${authSessionId.substring(0, 8)}...`);

        // Wait for QR code with diagnostics on failure
        try {
          await authPage.waitForSelector('img[alt="qrcode"]', {
            timeout: 15000,  // z-5a: increased from 10s to 15s
            state: 'visible'
          });
          console.log(`✅ QR code visible for auth ${authSessionId.substring(0, 8)}...`);
          // Capture screenshot when QR is visible (for debugging)
          await captureDebugScreenshot(authPage, authSessionId, 'qr_visible');
        } catch (qrWaitError) {
          // QR didn't appear - diagnose what's blocking
          const currentUrl = authPage.url();
          const pageState = await authPage.evaluate(() => {
            const hasCaptcha = !!(
              document.querySelector('#captcha_container') ||
              document.querySelector('#verify-ele') ||
              document.querySelector('#captcha-verify-image') ||
              document.querySelector('.captcha_verify_img_slide') ||
              document.querySelector('.secsdk-captcha-drag-icon')
            );
            const hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"]');
            const bodyText = document.body?.innerText?.substring(0, 500) || '';
            const title = document.title || '';

            return { hasCaptcha, hasRecaptcha, bodyText, title };
          });

          const truncatedUrl = currentUrl.length > 100 ? currentUrl.substring(0, 100) + '...' : currentUrl;
          const truncatedTitle = pageState.title.length > 80 ? pageState.title.substring(0, 80) + '...' : pageState.title;

          console.error(`🚫 Auth ${authSessionId.substring(0, 8)} QR not visible after 10s`);
          console.error(`   URL: ${truncatedUrl}`);
          console.error(`   Title: ${truncatedTitle}`);

          if (pageState.hasCaptcha) {
            console.error(`   Blocker: [TIKTOK_CAPTCHA]`);
          } else if (pageState.hasRecaptcha) {
            console.error(`   Blocker: [RECAPTCHA]`);
          } else {
            console.error(`   Blocker: [UNKNOWN]`);
          }
          console.error(`   Body preview: ${pageState.bodyText.replace(/\n/g, ' ').substring(0, 200)}`);

          // Capture screenshot before cleanup
          await captureDebugScreenshot(authPage, authSessionId, 'qr_not_visible');

          // Cleanup and fail
          if (browserInstance) {
            await destroyAuthContainer(authSessionId);
          }
          authSessionManager.updateAuthSession(authSessionId, { status: 'failed' });
          return;
        }

        // Extract and decode QR code
        const qrNavDuration = Date.now() - navStart;
        const qrData = await QRExtractor.extractQRCodeFromPage(authPage, authSessionId);
        authSessionManager.updateAuthSession(authSessionId, {
          qrCodeData: qrData.image,
          qrDecodedUrl: qrData.decodedUrl
        });

        if (qrData.image) {
          log.ok('AUTH', 'qr_generated', { session: authSessionId.substring(0, 8), duration: `${qrNavDuration}ms` });
        } else {
          log.fail('AUTH', 'qr_failed', { session: authSessionId.substring(0, 8), reason: qrData.error || 'no_image', duration: `${qrNavDuration}ms` });
        }
        console.log(`✅ QR code extracted for auth ${authSessionId.substring(0, 8)}...`);
        if (qrData.decodedUrl) {
          console.log(`🔗 QR URL validated: ${qrData.decodedUrl}`);
        }
        if (qrData.error) {
          console.log(`⚠️ QR extraction warning: ${qrData.error}`);
          await captureDebugScreenshot(authPage, authSessionId, 'qr_extraction_error');
        }

        // Start polling for login completion
        await waitForLoginCompletion(authSessionId, authPage, preAuthToken);

      } catch (error: any) {
        console.error(`❌ Auth flow error for ${authSessionId}:`, error.message);
        authSessionManager.updateAuthSession(authSessionId, {
          status: 'failed'
        });

        // Release browser container
        if (browserInstance) {
          try {
            await destroyAuthContainer(authSessionId);
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
    console.error('Auth start error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

async function waitForLoginCompletion(authSessionId: string, page: Page, preAuthToken?: string): Promise<void> {
  const timeout = 120000; // 2 minutes
  const startTime = Date.now();

  // v3-o: Track state for diagnostics
  const seenUrls = new Set<string>();
  const arrivedCookies = new Set<string>();
  const requiredCookies = ['sessionid', 'msToken', 'ttwid', 'sid_guard', 'uid_tt', 'sid_tt'];
  let lastHeartbeat = startTime;

  console.log(`⏳ Waiting for login completion for auth ${authSessionId.substring(0, 8)}...`);

  // v3-p: Set up real-time page state detection via MutationObserver
  let lastWarnings = new Set<string>();
  let pageStateChanged = false;
  let latestPageState: any = { hasQRCode: true };

  // Expose function for browser to notify us of changes
  await page.exposeFunction('onPageStateChange', (state: any) => {
    latestPageState = state;
    pageStateChanged = true;
  }).catch(() => {}); // Ignore if already exposed

  // Set up MutationObserver to detect changes immediately
  await page.evaluate(() => {
    const checkPageState = () => {
      // Real TikTok CAPTCHA selectors (researched from tiktok-captcha-solver)
      const hasCaptcha = !!(
        document.querySelector('#captcha_container') ||
        document.querySelector('#verify-ele') ||
        document.querySelector('#captcha-verify-image') ||
        document.querySelector('.captcha_verify_img_slide') ||
        document.querySelector('.secsdk-captcha-drag-icon')
      );

      const hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"]');

      // QR code presence (good sign if visible)
      const hasQRCode = !!(
        document.querySelector('canvas') ||
        document.querySelector('[class*="qr"]') ||
        document.querySelector('img[src*="qr"]')
      );

      // Error/expiry text detection
      const bodyText = document.body?.innerText?.toLowerCase() || '';
      const hasExpired = bodyText.includes('expired') || bodyText.includes('timed out') || bodyText.includes('scan again');
      const hasError = bodyText.includes('something went wrong') || bodyText.includes('try again later');
      const hasPhoneVerify = bodyText.includes('verify your phone') || bodyText.includes('verification code');

      return { hasCaptcha, hasRecaptcha, hasQRCode, hasExpired, hasError, hasPhoneVerify };
    };

    // Initial state
    (window as any).onPageStateChange(checkPageState());

    // Watch for DOM changes
    const observer = new MutationObserver(() => {
      (window as any).onPageStateChange(checkPageState());
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }).catch(() => {});

  while (Date.now() - startTime < timeout) {
    try {
      // 1. Track URL changes (truncate query strings)
      const fullUrl = page.url();
      const baseUrl = fullUrl.split('?')[0].substring(0, 80);
      if (!seenUrls.has(baseUrl)) {
        seenUrls.add(baseUrl);
        console.log(`📍 Auth ${authSessionId.substring(0, 8)} URL: ${baseUrl}`);

        // v3-s: Capture on URL transition away from QR page with 0 cookies
        // This is the "moment of silent rejection" - TikTok acknowledged scan but didn't auth
        if (!baseUrl.includes('/login/qrcode') && arrivedCookies.size === 0) {
          await captureDebugScreenshot(page, authSessionId, 'url_transition_no_cookies');
        }
      }

      // 2. Early CAPTCHA detection - fail fast, don't wait 2 minutes
      if (baseUrl.includes('google.com') || baseUrl.includes('captcha') || baseUrl.includes('recaptcha')) {
        console.error(`🚫 Auth ${authSessionId.substring(0, 8)} CAPTCHA detected - aborting`);
        authSessionManager!.updateAuthSession(authSessionId, { status: 'failed' });
        await destroyAuthContainer(authSessionId);
        return;
      }

      // 3. Get ALL cookies - requiredCookies check handles filtering (v3-t)
      const cookies = await page.context().cookies();
      const cookieNames = cookies.map(c => c.name);

      // 4. Progressive cookie logging - log each cookie as it arrives
      const prevSize = arrivedCookies.size;
      for (const name of requiredCookies) {
        if (cookieNames.includes(name) && !arrivedCookies.has(name)) {
          arrivedCookies.add(name);
          console.log(`🍪 Auth ${authSessionId.substring(0, 8)} cookie: ${name} (${arrivedCookies.size}/6)`);
        }
      }
      // T8: Log when cookies first arrive (threshold: sessionid present = auth success)
      if (prevSize === 0 && arrivedCookies.size > 0) {
        log.ok('AUTH', 'cookie_arrived', { session: authSessionId.substring(0, 8), count: arrivedCookies.size, elapsed_ms: Date.now() - startTime });
      }

      // 5. Check for page state changes (real-time via MutationObserver)
      if (pageStateChanged) {
        pageStateChanged = false;

        const currentWarnings = new Set<string>();
        if (latestPageState.hasCaptcha) currentWarnings.add('TIKTOK_CAPTCHA');
        if (latestPageState.hasRecaptcha) currentWarnings.add('RECAPTCHA');
        if (latestPageState.hasExpired) currentWarnings.add('QR_EXPIRED');
        if (latestPageState.hasError) currentWarnings.add('ERROR');
        if (latestPageState.hasPhoneVerify) currentWarnings.add('PHONE_VERIFY');
        if (!latestPageState.hasQRCode && arrivedCookies.size < 6) currentWarnings.add('QR_GONE');

        // Log any NEW warnings immediately
        for (const warning of currentWarnings) {
          if (!lastWarnings.has(warning)) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.warn(`⚠️ Auth ${authSessionId.substring(0, 8)} [${warning}] at ${elapsed}s`);
            console.warn(`   URL: ${baseUrl}`);
            if (warning === 'TIKTOK_CAPTCHA' || warning === 'RECAPTCHA') {
              log.warn('AUTH', 'captcha_detected', { session: authSessionId.substring(0, 8), elapsed: `${elapsed}s` });
            } else if (warning === 'PHONE_VERIFY') {
              log.warn('AUTH', 'phone_verify', { session: authSessionId.substring(0, 8) });
            }

            // v3-s: Capture screenshot on first warning occurrence
            await captureDebugScreenshot(page, authSessionId, `warning_${warning.toLowerCase()}`);
          }
        }

        // Log if warning CLEARED (state improved)
        for (const warning of lastWarnings) {
          if (!currentWarnings.has(warning)) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`✓ Auth ${authSessionId.substring(0, 8)} [${warning}] cleared at ${elapsed}s`);
          }
        }

        lastWarnings = currentWarnings;
      }

      // 6a. PRIMARY: URL-based login detection (v3-u, matches v2.4 behavior)
      // If TikTok redirected away from login, user is authenticated
      const fullUrlForDetection = page.url();
      if (fullUrlForDetection.includes('/foryou') || fullUrlForDetection.includes('/home') ||
          (fullUrlForDetection.includes('tiktok.com') && !fullUrlForDetection.includes('/login') && !fullUrlForDetection.includes('/qrcode'))) {
        console.log(`✅ Auth ${authSessionId.substring(0, 8)} login detected via URL: ${fullUrlForDetection.substring(0, 60)}`);
        log.ok('AUTH', 'login_detected', { session: authSessionId.substring(0, 8), duration: `${Math.round((Date.now() - startTime) / 1000)}s`, cookie_count: arrivedCookies.size });

        // Extract session data
        const sessionData = await extractAuthData(page);

        authSessionManager!.updateAuthSession(authSessionId, {
          status: 'complete',
          sessionData
        });

        // TEE Integration: Encrypt and store via Xordi
        if (preAuthToken && sessionData) {
          await storeUserWithTEEEncryption(sessionData, preAuthToken, authSessionId);
        } else {
          if (sessionManager && sessionData) {
            const newSessionId = sessionManager.storeSession(sessionData);
            console.log(`💾 Session stored locally: ${newSessionId.substring(0, 8)}...`);
          }
        }

        try {
          await destroyAuthContainer(authSessionId);
          log.ok('AUTH', 'auth_cleanup', { session: authSessionId.substring(0, 8), outcome: 'success' });
        } catch (recycleError) {
          console.error(`⚠️ Failed to recycle auth container for ${authSessionId}`);
        }

        return;
      }

      // 6b. SECONDARY: Cookie-based detection (sessionid sufficient, like Nov 13 version)
      if (arrivedCookies.has('sessionid')) {
        console.log(`✅ Auth ${authSessionId.substring(0, 8)} login successful (sessionid cookie detected)`);
        log.ok('AUTH', 'login_detected', { session: authSessionId.substring(0, 8), duration: `${Math.round((Date.now() - startTime) / 1000)}s`, cookie_count: arrivedCookies.size });

        // Extract session data (cookies in plaintext - INSIDE TEE)
        const sessionData = await extractAuthData(page);

        authSessionManager!.updateAuthSession(authSessionId, {
          status: 'complete',
          sessionData
        });

        // TEE Integration: Encrypt and store via Xordi
        if (preAuthToken && sessionData) {
          await storeUserWithTEEEncryption(sessionData, preAuthToken, authSessionId);
        } else {
          // Legacy flow: Store session locally (fallback)
          if (sessionManager && sessionData) {
            const newSessionId = sessionManager.storeSession(sessionData);
            console.log(`💾 Session stored locally: ${newSessionId.substring(0, 8)}...`);
          }
        }

        // v19: Recycle auth container (cleared and returned to pool for next user)
        try {
          await destroyAuthContainer(authSessionId);
          log.ok('AUTH', 'auth_cleanup', { session: authSessionId.substring(0, 8), outcome: 'success' });
        } catch (recycleError) {
          console.error(`⚠️ Failed to recycle auth container for ${authSessionId}`);
        }

        return;
      }

      // 7. Heartbeat every 30 seconds - status update with diagnostics
      if (Date.now() - lastHeartbeat > 30000) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const warningStr = lastWarnings.size > 0 ? ` [${[...lastWarnings].join(', ')}]` : '';
        console.log(`💓 Auth ${authSessionId.substring(0, 8)} waiting... (${elapsed}s, ${arrivedCookies.size}/6 cookies, ${cookies.length} total)${warningStr}`);
        console.log(`   URL: ${baseUrl}`);
        lastHeartbeat = Date.now();
      }

      await new Promise(resolve => setTimeout(resolve, 3000));  // z-5a: reduced polling frequency

    } catch (error: any) {
      // 7. Log errors instead of silent swallow
      console.warn(`⚠️ Auth ${authSessionId.substring(0, 8)} poll error: ${error.message}`);

      // v3-t: Break if browser died, delay on other errors
      if (error.message.includes('closed')) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 8. Timeout - diagnostics showing what we got
  console.log(`⏰ Auth ${authSessionId.substring(0, 8)} timeout after 120s`);
  console.log(`   URLs: ${[...seenUrls].join(' → ')}`);
  console.log(`   Cookies: [${[...arrivedCookies].join(', ') || 'none'}] (${arrivedCookies.size}/6)`);
  if (arrivedCookies.size < 6) {
    const missing = requiredCookies.filter(name => !arrivedCookies.has(name));
    console.log(`   Missing: [${missing.join(', ')}]`);
  }

  // v3-s: Capture screenshot at timeout to see final page state
  await captureDebugScreenshot(page, authSessionId, 'timeout_no_cookies');

  authSessionManager!.updateAuthSession(authSessionId, { status: 'failed' });

  // v19: Recycle timed-out auth container
  try {
    await destroyAuthContainer(authSessionId);
    log.ok('AUTH', 'auth_cleanup', { session: authSessionId.substring(0, 8), outcome: 'timeout' });
  } catch (recycleError) {
    console.error(`⚠️ Failed to recycle timed-out auth container for ${authSessionId}`);
  }
}

/**
 * Store user with TEE-encrypted cookies (Phase 2 + 3 of pre-auth flow)
 */
async function storeUserWithTEEEncryption(sessionData: SessionData, preAuthToken: string, authSessionId: string): Promise<void> {
  try {
    const xordiApiUrl = process.env.XORDI_API_URL || 'http://xordi-private-api:3001';
    const xordiApiKey = process.env.XORDI_API_KEY;

    if (!xordiApiKey) {
      console.error('❌ XORDI_API_KEY not configured - cannot store user with TEE encryption');
      return;
    }

    console.log('🔐 Encrypting cookies with TEE key...');

    // Guard: If DStack socket exists (production Phala CVM) but DStack failed to init, refuse to encrypt
    const dstackSocketExists = fs.existsSync('/var/run/dstack.sock');
    if (dstackSocketExists && !teeCrypto.isDStackKey()) {
      throw new Error('DStack socket present but key not initialized — refusing to encrypt with fallback key');
    }

    // Phase 2a: Encrypt cookies IN TEE (plaintext only exists in TEE memory)
    const teeEncryptedCookies = teeCrypto.encryptCookies(sessionData.cookies);

    console.log(`  Encrypted ${sessionData.cookies?.length || 0} cookies (${teeEncryptedCookies.length} chars)`);

    // Phase 2b: Store user with encrypted cookies in Xordi DB
    console.log('📤 Storing user with TEE-encrypted cookies in Xordi...');

    const storeResponse = await axios.post(
      `${xordiApiUrl}/api/enclave/store-user`,
      {
        pre_auth_token: preAuthToken,
        user: sessionData.user,
        tee_encrypted_cookies: teeEncryptedCookies,
        device_id: sessionData.tokens?.device_id || sessionData.device_id,
        install_id: sessionData.tokens?.install_id || sessionData.install_id
      },
      {
        headers: {
          'X-Api-Key': xordiApiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!storeResponse.data.success) {
      throw new Error('Xordi rejected user storage');
    }

    const secUserId = storeResponse.data.sec_user_id;
    console.log(`✅ User stored in Xordi: ${secUserId} (trust_level=0, encrypted cookies)`);

    // Phase 3: Escalate trust level after verification
    // In staging mode, skip trust_level update but still complete the auth flow (update qr_sessions, etc.)
    const isStaging = process.env.DEPLOY_ENV === 'staging';
    if (isStaging) {
      console.log('🔼 Completing auth flow (staging mode - skip trust escalation)...');
    } else {
      console.log('🔼 Escalating trust level...');
    }

    // Issue 6: Wrap escalate-trust in separate try-catch (don't re-throw)
    try {
      const escalateResponse = await axios.post(
        `${xordiApiUrl}/api/enclave/escalate-trust`,
        {
          sec_user_id: secUserId,
          pre_auth_token: preAuthToken,
          tokscope_session_id: authSessionId,
          skip_trust_update: isStaging  // Staging: complete flow without trust escalation
        },
        {
          headers: {
            'X-Api-Key': xordiApiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!escalateResponse.data.success) {
        console.warn('⚠️ Trust escalation failed, user remains at trust_level=0');
      } else {
        if (isStaging) {
          console.log(`✅ Auth flow completed (staging): ${secUserId} (trust_level=0)`);
        } else {
          console.log(`✅ Trust escalated: ${secUserId} → trust_level=2 (verified)`);
        }
      }
    } catch (escalateError: any) {
      // DON'T throw - user is already stored, escalation failure is non-fatal
      console.warn(`⚠️ Trust escalation error (user stored OK): ${escalateError.message}`);
    }

    // Store in local session manager for immediate use
    if (sessionManager) {
      sessionManager.storeSession(sessionData);
      console.log(`💾 Session also stored locally for immediate use`);
    }

  } catch (error: any) {
    console.error('❌ TEE encryption/storage failed:', error.message);
    throw error;
  }
}

async function extractAuthData(page: Page): Promise<SessionData> {
  console.log('🔍 Extracting authentication data...');
  return await BrowserAutomationClient.extractAuthData(page);
}

/**
 * v1.1.3login: Cookie-only detection loop for portal mode
 * CDP automation is read-only (no navigation/interaction) — human drives via Neko WebRTC
 * Polls page.context().cookies() every 3s for the required 6-cookie set
 */
async function waitForPortalLoginCompletion(
  authSessionId: string,
  page: Page,
  preAuthToken?: string,
  portalTimeoutMs: number = 300000
): Promise<void> {
  const startTime = Date.now();
  const requiredCookies = ['sessionid', 'msToken', 'ttwid', 'sid_guard', 'uid_tt', 'sid_tt'];
  const POLL_INTERVAL_MS = 3000;

  console.log(`⏳ Portal mode: waiting for cookie arrival for auth ${authSessionId.substring(0, 8)}... (timeout: ${portalTimeoutMs}ms)`);

  while (Date.now() - startTime < portalTimeoutMs) {
    try {
      const cookies = await page.context().cookies();
      const cookieNames = new Set(cookies.map((c: any) => c.name));
      const foundRequired = requiredCookies.filter(name => cookieNames.has(name));

      if (foundRequired.length === requiredCookies.length) {
        console.log(`✅ Portal: all required cookies detected for ${authSessionId.substring(0, 8)}...`);

        // Extract full auth data and store with TEE encryption (same path as QR flow)
        const sessionData = await extractAuthData(page);

        if (preAuthToken) {
          await storeUserWithTEEEncryption(sessionData, preAuthToken, authSessionId);
        }

        authSessionManager!.updateAuthSession(authSessionId, {
          status: 'complete',
          sessionData
        });

        // Destroy container
        await destroyAuthContainer(authSessionId);
        log.ok('AUTH', 'auth_complete', { session: authSessionId.substring(0, 8), mode: 'portal', duration: `${Date.now() - startTime}ms` });
        return;
      }

      // Log progress periodically (every 30s)
      if ((Date.now() - startTime) % 30000 < POLL_INTERVAL_MS) {
        console.log(`⏳ Portal ${authSessionId.substring(0, 8)}: ${foundRequired.length}/${requiredCookies.length} cookies (${foundRequired.join(',')})`);
      }

    } catch (pollError: any) {
      console.error(`⚠️ Portal cookie poll error for ${authSessionId.substring(0, 8)}: ${pollError.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timeout — clean up
  console.log(`⏰ Portal session timed out for ${authSessionId.substring(0, 8)}...`);
  log.fail('AUTH', 'auth_timeout', { session: authSessionId.substring(0, 8), mode: 'portal', duration: `${portalTimeoutMs}ms` });
  authSessionManager!.updateAuthSession(authSessionId, { status: 'failed' });
  await destroyAuthContainer(authSessionId);
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
      // v1.1.3login: Include portalUrl in poll response when available (for borgcube to relay to 3P)
      const pollResponse: any = {
        status: 'awaiting_scan',
        qrCodeData: authSession.qrCodeData,
        qrDecodedUrl: authSession.qrDecodedUrl  // Include magic link
      };
      if (authSession.portalSessionUrl) {
        pollResponse.portalUrl = authSession.portalSessionUrl;
      }
      res.json(pollResponse);
    } else if (authSession.status === 'complete') {
      // v1.1.3login: Remove sessionData from complete response — borgcube never reads it
      // (verified: borgcube only reads qrCodeData/qrDecodedUrl, detects completion via auth_sessions DB)
      res.json({
        status: 'complete'
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
    console.error('Auth poll error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/destroy/:authSessionId', async (req, res) => {
  try {
    const { authSessionId } = req.params;
    if (!/^[a-f0-9\-]{36}$/.test(authSessionId)) {
      return res.status(400).json({ error: 'Invalid authSessionId format' });
    }
    await destroyAuthContainer(authSessionId);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Auth destroy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * v1.1.3login: Auth proxy endpoint for WebRTC portal access
 * Validates one-time session token, calls Neko's POST /api/login server-side to get
 * NEKO_SESSION cookie, and redirects to Neko with ?embed=1 (no credentials in URL).
 * Token is invalidated after first use (single-viewer enforcement layer 1).
 */
app.get('/auth/portal/:sessionToken', async (req, res) => {
  try {
    const { sessionToken } = req.params;

    // Validate token
    const tokenData = portalSessionTokens.get(sessionToken);
    if (!tokenData) {
      return res.status(404).json({ error: 'Portal session not found or expired' });
    }

    if (tokenData.used) {
      return res.status(403).json({ error: 'Portal session token already used — single-use enforcement' });
    }

    if (Date.now() > tokenData.expiresAt) {
      portalSessionTokens.delete(sessionToken);
      return res.status(403).json({ error: 'Portal session token expired' });
    }

    // Invalidate token immediately (single-use — layer 1 of single-viewer enforcement)
    tokenData.used = true;
    console.log(`🔑 Portal token validated for auth ${tokenData.authSessionId.substring(0, 8)}...`);

    // Get the auth session to retrieve container info
    if (!authSessionManager) {
      return res.status(500).json({ error: 'Auth session manager not initialized' });
    }
    const authSession = authSessionManager.getAuthSession(tokenData.authSessionId);
    if (!authSession || !authSession.containerId) {
      return res.status(404).json({ error: 'Portal session container not found' });
    }

    // Get container IP from browser manager to call Neko API server-side
    // Neko runs on port 8080 inside the container
    const containerIp = await getContainerIp(authSession.containerId);
    if (!containerIp) {
      return res.status(500).json({ error: 'Could not resolve container IP' });
    }

    const nekoBaseUrl = `http://${containerIp}:8080`;
    const nekoApiToken = containerNekoApiTokens.get(authSession.containerId);

    // Build Neko credentials (retrieved from container metadata)
    const nekoCreds = containerNekoCreds.get(authSession.containerId);
    if (!nekoCreds) {
      console.warn(`⚠️ No Neko credentials found for container ${authSession.containerId.substring(0, 16)}, falling back to URL params`);
      // Fallback: redirect with credentials in URL params (less secure but functional)
      const dstackGateway = process.env.DSTACK_GATEWAY_URL || lastKnownGatewayUrl;
      const nekoPublicUrl = dstackGateway
        ? `${dstackGateway.replace('-3000.', '-8080.')}`
        : `http://${containerIp}:8080`;
      return res.redirect(`${nekoPublicUrl}/?embed=1`);
    }

    // Call Neko POST /api/login server-side to get NEKO_SESSION cookie
    // This eliminates credentials from the redirect URL entirely
    let nekoSessionCookie: string | null = null;
    try {
      const loginHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (nekoApiToken) {
        loginHeaders['Authorization'] = `Bearer ${nekoApiToken}`;
      }
      const loginResp = await fetch(`${nekoBaseUrl}/api/login`, {
        method: 'POST',
        headers: loginHeaders,
        body: JSON.stringify({ username: nekoCreds.userPassword ? 'user' : 'admin', password: nekoCreds.userPassword || nekoCreds.adminPassword })
      });

      if (loginResp.ok) {
        const setCookieHeader = loginResp.headers.get('set-cookie');
        if (setCookieHeader) {
          nekoSessionCookie = setCookieHeader;
          console.log(`✅ Neko session cookie obtained for ${tokenData.authSessionId.substring(0, 8)}...`);
        }
      } else {
        console.warn(`⚠️ Neko /api/login returned ${loginResp.status} for ${tokenData.authSessionId.substring(0, 8)}`);
      }
    } catch (nekoErr: any) {
      console.warn(`⚠️ Failed to call Neko /api/login: ${nekoErr.message}`);
    }

    // Build redirect URL to Neko with embed=1 (no credentials)
    const dstackGateway = process.env.DSTACK_GATEWAY_URL || lastKnownGatewayUrl;
    let nekoPublicUrl: string;
    if (dstackGateway) {
      // Replace port 3000 with 8080 in Dstack gateway URL
      nekoPublicUrl = dstackGateway.replace(/-3000\./, '-8080.');
    } else {
      nekoPublicUrl = `http://${containerIp}:8080`;
    }
    const redirectUrl = `${nekoPublicUrl}/?embed=1`;

    if (nekoSessionCookie) {
      // Set NEKO_SESSION cookie on redirect (cross-subdomain requires NEKO_SESSION_COOKIE_DOMAIN)
      const cookieDomain = process.env.NEKO_SESSION_COOKIE_DOMAIN || '';
      const cookieAttrs = cookieDomain ? `; Domain=${cookieDomain}; Path=/; SameSite=Lax` : `; Path=/; SameSite=Lax`;
      res.setHeader('Set-Cookie', nekoSessionCookie.replace(/;.*$/, '') + cookieAttrs);
    }

    // Lock logins via Neko admin API (layer 2 of single-viewer enforcement)
    if (nekoApiToken) {
      fetch(`${nekoBaseUrl}/api/room/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nekoApiToken}`
        },
        body: JSON.stringify({ locked_logins: true })
      }).catch((err: any) => {
        console.warn(`⚠️ Failed to lock Neko logins for ${tokenData.authSessionId.substring(0, 8)}: ${err.message}`);
      });
    }

    res.redirect(302, redirectUrl);

  } catch (error: any) {
    console.error('Auth portal error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// v1.1.3login: Internal endpoint for browser-manager to register per-container Neko credentials
// Called by browser-manager.ts after container creation with randomized Neko creds
app.post('/internal/container-neko-creds', (req, res) => {
  try {
    const { containerId, userPassword, adminPassword, apiToken } = req.body;
    if (!containerId || !userPassword || !adminPassword) {
      return res.status(400).json({ error: 'containerId, userPassword, adminPassword required' });
    }
    containerNekoCreds.set(containerId, { userPassword, adminPassword });
    if (apiToken) {
      containerNekoApiTokens.set(containerId, apiToken);
    }
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Playwright-based sampling endpoints
app.post('/playwright/foryoupage/sample/:sessionId', async (req, res) => {
  try {
    if (process.env.AUTH_ONLY_MODE === 'true') {
      return res.status(503).json({ error: 'Instance is auth-only', message: 'Data operations should be routed to the Main TEE.' });
    }
    const { sessionId } = req.params;
    const { count = 10 } = req.body;

    if (!sessionManager) {
      return res.status(500).json({ error: 'Session manager not initialized' });
    }

    const sessionData = sessionManager.getSession(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const requestId = req.headers['x-queue-request-id'] as string || '';
    log.ok('AUTH', 'sample_started', { session: sessionId.substring(0, 8), request_id: requestId, type: 'foryoupage' });
    console.log(`🎯 Starting For You page sampling for session ${sessionId.substring(0, 8)}... (count: ${count})`);
    const sampleStart = Date.now();

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

      log.ok('AUTH', 'sample_complete', { session: sessionId.substring(0, 8), request_id: requestId, type: 'foryoupage', count: result.videos?.length || 0, duration: `${Date.now() - sampleStart}ms` });
      res.json(result);

    } finally {
      await releaseBrowserInstance(sessionId);
    }

  } catch (error: any) {
    console.error(`❌ Sampling error for ${req.params.sessionId}:`, error.message);
    log.fail('AUTH', 'sample_failed', { session: req.params.sessionId.substring(0, 8), request_id: req.headers['x-queue-request-id'] as string || '', type: 'foryoupage', error: error.message, duration: '0ms' });
    res.status(500).json({ error: error.message });
  }
});

app.post('/playwright/watchhistory/sample/:sessionId', async (req, res) => {
  try {
    if (process.env.AUTH_ONLY_MODE === 'true') {
      return res.status(503).json({ error: 'Instance is auth-only', message: 'Data operations should be routed to the Main TEE.' });
    }
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
    console.error(`❌ Sampling error for ${req.params.sessionId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Module-based sampling endpoints (placeholder - not primary focus)
app.post('/modules/foryoupage/sample/:sessionId', async (req, res) => {
  try {
    if (process.env.AUTH_ONLY_MODE === 'true') {
      return res.status(503).json({ error: 'Instance is auth-only', message: 'Data operations should be routed to the Main TEE.' });
    }
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
    console.error(`❌ Module sampling error for ${req.params.sessionId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/modules/watchhistory/sample/:sessionId', async (req, res) => {
  try {
    if (process.env.AUTH_ONLY_MODE === 'true') {
      return res.status(503).json({ error: 'Instance is auth-only', message: 'Data operations should be routed to the Main TEE.' });
    }
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
    console.error(`❌ Module sampling error for ${req.params.sessionId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Deprecated: Use /playwright/foryoupage/sample instead
app.post('/scrape/:sessionId', async (req, res) => {
  if (process.env.AUTH_ONLY_MODE === 'true') {
    return res.status(503).json({ error: 'Instance is auth-only', message: 'Data operations should be routed to the Main TEE.' });
  }
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
    console.error('Failed to create container:', error.message);
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
    console.error('Failed to delete container:', error.message);
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
      poolSize: stats.poolSize,  // z-1: Pass through poolSize for borgcube
      containers: []
    });
  } catch (error: any) {
    console.error('Failed to get containers:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// XORDI INTEGRATION ENDPOINTS
// Request Construction Outside, Signing Inside TEE
// ============================================================================

/**
 * Execute TikTok API request with authentication in TEE
 * - Receives pre-constructed request packet from Xordi (NO secrets)
 * - Retrieves TEE-encrypted cookies from Xordi DB
 * - Decrypts cookies in TEE
 * - Generates security headers via Python subprocess
 * - Executes signed request to TikTok
 * - Returns response (public video metadata)
 */
app.post('/api/tiktok/execute', async (req, res) => {
  try {
    const { sec_user_id, wireguard_bucket, ipfoxy_session, request } = req.body;

    // AUTH_ONLY_MODE: Reject data operations on auth-only instances
    if (process.env.AUTH_ONLY_MODE === 'true') {
      const operation = req.body.request?.operation;
      const authOperations = ['qr_auth', 'qr_auth_check', 'qr_auth_confirm'];

      if (!authOperations.includes(operation)) {
        console.log(`🚫 Rejecting ${operation} - instance is auth-only`);
        return res.status(503).json({
          error: 'Instance is auth-only',
          message: 'This instance only handles authentication operations. Data operations (timeline, watch_history, like) should be routed to the Main TEE.',
          operation,
          instance_id: process.env.INSTANCE_ID || 'unknown'
        });
      }
    }

    // 1. Verify Xordi API key
    const apiKey = req.header('X-Api-Key');
    const allowedKeys = (process.env.XORDI_API_KEY || '').split(',').filter(k => k);

    if (!apiKey || !allowedKeys.includes(apiKey)) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // 2. Validate endpoint against whitelist (Trust Enforcement)
    const ALLOWED_ENDPOINTS = {
      read_only: [
        '/aweme/v1/feed/',              // Mobile API: For You feed
        '/aweme/v1/user/',              // Mobile API: User profile
        '/aweme/v1/search/item/',       // Mobile API: Search
        '/api/recommend/item_list/',    // Web API: For You feed (working implementation)
        '/tiktok/watch/history/list/v1/' // Web API: Watch history (working implementation)
      ],
      authenticated: [
        '/aweme/v1/watch/history/'      // Mobile API: Watch history (experimental)
      ],
      write_operations: [
        '/aweme/v1/commit/item/digg/',  // Mobile API: Like video
        '/aweme/v1/commit/follow/user/' // Mobile API: Follow user
      ]
    };

    const allAllowed = [
      ...ALLOWED_ENDPOINTS.read_only,
      ...ALLOWED_ENDPOINTS.authenticated,
      ...ALLOWED_ENDPOINTS.write_operations
    ];

    // Extract base path (before query string) for whitelist check
    const baseEndpoint = request.endpoint.split('?')[0];

    if (!allAllowed.includes(baseEndpoint)) {
      return res.status(403).json({
        error: 'Endpoint not whitelisted',
        endpoint: baseEndpoint,
        message: 'Only pre-approved TikTok API endpoints are allowed'
      });
    }

    // 3. Get session data - try local session manager first, then Xordi DB
    let sessionData: any = null;
    let cookies: any[] = [];

    // Try local session manager first (for immediate post-auth use)
    const localSession = sessionManager?.getSession(sec_user_id);

    if (localSession && localSession.cookies) {
      sessionData = localSession;
      cookies = localSession.cookies;
    } else {
      // Retrieve TEE-encrypted cookies from Xordi DB

      const xordiApiUrl = process.env.XORDI_API_URL || 'http://xordi-private-api:3001';
      const xordiApiKey = process.env.XORDI_API_KEY;

      if (!xordiApiKey) {
        return res.status(500).json({ error: 'XORDI_API_KEY not configured' });
      }

      try {
        const cookiesResponse = await axios.get(
          `${xordiApiUrl}/api/enclave/get-encrypted-cookies/${sec_user_id}`,
          {
            headers: {
              'X-Api-Key': xordiApiKey
            }
          }
        );

        if (!cookiesResponse.data.success) {
          throw new Error('Failed to retrieve encrypted cookies from Xordi');
        }

        // Decrypt cookies IN TEE (fallback handles pre-migration cookies)
        const encryptedHex = cookiesResponse.data.tee_encrypted_cookies;
        cookies = teeCrypto.decryptCookiesWithFallback(encryptedHex);

        // Build session data structure
        sessionData = {
          cookies,
          tokens: {
            device_id: cookiesResponse.data.device_id,
            install_id: cookiesResponse.data.install_id
          },
          user: {
            sec_user_id
          }
        };

      } catch (error: any) {
        console.error('Failed to retrieve/decrypt cookies:', error.message);
        return res.status(500).json({ error: 'Failed to retrieve session data' });
      }
    }

    if (!sessionData || !cookies || cookies.length === 0) {
      return res.status(404).json({ error: 'No session data available for user' });
    }

    // XORDI-V3-L FIX: Extract fresh msToken from decrypted cookies
    // Override any stale msToken that was baked into the request URL by DirectTikTokAPI
    const freshMsToken = cookies.find((c: any) => c.name === 'msToken')?.value || '';

    if (freshMsToken && request.endpoint) {
      try {
        const url = new URL(request.endpoint, 'https://www.tiktok.com');
        if (url.searchParams.has('msToken')) {
          const oldMsToken = url.searchParams.get('msToken');
          url.searchParams.set('msToken', freshMsToken);
          request.endpoint = url.pathname + url.search;
        }
      } catch (urlError) {
        // Could not parse endpoint as URL, skipping msToken injection
      }
    }

    // 4. Detect API type (web vs mobile)
    const apiType = request.apiType || 'mobile';
    const isWebApi = apiType === 'web';

    // 5. Extract cookies - different filtering for web vs mobile
    let cookieString = '';
    if (cookies && Array.isArray(cookies)) {
      if (isWebApi) {
        // Web API: Use all cookies
        cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
      } else {
        // Mobile API: Filter to mobile-only cookies
        const mobileCookieNames = [
          'sessionid', 'sessionid_ss',
          'sid_guard', 'sid_tt',
          'uid_tt', 'uid_tt_ss',
          'msToken',
          'tt_chain_token',
          'sid_ucp_v1', 'ssid_ucp_v1',
          'store-idc', 'store-country-code', 'store-country-code-src',
          'tt-target-idc', 'tt-target-idc-sign',
          'cmpl_token', 'multi_sids',
          'tt_session_tlb_tag'
        ];
        const mobileCookieNameSet = new Set(mobileCookieNames);
        const filteredCookies = cookies.filter((c: any) => mobileCookieNameSet.has(c.name));
        cookieString = filteredCookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
      }
    }

    // 6. Build headers based on API type
    let requestHeaders: any = {
      'Cookie': cookieString
    };

    if (isWebApi) {
      // Determine correct referer based on endpoint (matches v2.4 stable behavior)
      const isWatchHistory = request.endpoint.includes('/watch/history/');
      const referer = isWatchHistory
        ? 'https://www.tiktok.com/tpp/watch-history'
        : 'https://www.tiktok.com/foryou';

      // Web API: Browser headers matching working v2.4 implementation
      requestHeaders = {
        ...requestHeaders,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer,
        'Origin': 'https://www.tiktok.com',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      };
    } else {
      // Mobile API: Generate security headers via Python subprocess
      const paramsString = new URLSearchParams(request.params).toString();
      const stub = request.body ? crypto.createHash('md5').update(request.body).digest('hex') : '';

      const headersResponse = await xordiSecurityModule.sendRequest('generateHeaders', {
        params: paramsString,
        cookies: cookieString,
        stub: stub,
        timestamp: Math.floor(Date.now() / 1000)
      });

      if (!headersResponse.success) {
        throw new Error('Failed to generate security headers');
      }

      requestHeaders = {
        ...requestHeaders,
        'X-Gorgon': headersResponse.headers['X-Gorgon'],
        'X-Khronos': headersResponse.headers['X-Khronos'],
        'X-Argus': headersResponse.headers['X-Argus'],
        'X-Ladon': headersResponse.headers['X-Ladon'],
        'User-Agent': `com.zhiliaoapp.musically/${request.params.manifest_version_code || '2023009040'} (Linux; U; Android ${request.params.os_version || '10'}; ${request.params.language || 'en'}_${request.params.region || 'US'}; ${request.params.device_type || 'SM-G973F'}; Build/QP1A.190711.020;tt-ok/3.12.13.4-tiktok)`
      };
    }

    // 7. Execute HTTP request to TikTok (FROM TEE)
    const baseUrl = isWebApi ? 'https://www.tiktok.com' : 'https://api16-normal-c-useast1a.tiktokv.com';

    // Proxy routing: IPFoxy (per-user sticky sessions) or WireGuard (bucket-based)
    const proxyMode = process.env.PROXY_MODE || 'wireguard';
    const disableWireguardRouting = process.env.DISABLE_WIREGUARD_ROUTING === 'true';
    let proxyAgent = null;

    if (proxyMode === 'ipfoxy') {
      if (!ipfoxy_session) {
        return res.status(400).json({ error: 'ipfoxy_session required when PROXY_MODE=ipfoxy' });
      }

      const account = process.env.IPFOXY_ACCOUNT;
      const password = process.env.IPFOXY_PASSWORD;
      const gateway = process.env.IPFOXY_GATEWAY || 'gate-us.ipfoxy.io:58688';

      const ipfoxyUser = `customer-${account}-cc-US-sessid-${ipfoxy_session}-ttl-60`;
      const socksProxy = `socks5://${ipfoxyUser}:${password}@${gateway}`;
      proxyAgent = new SocksProxyAgent(socksProxy);

    } else if (proxyMode === 'wireguard' && wireguard_bucket !== null && wireguard_bucket !== undefined) {
      // WireGuard buckets run on borgcube, connect via external SOCKS5
      const wgHost = process.env.WIREGUARD_HOST || '162.251.235.136';
      const wgBasePort = parseInt(process.env.WIREGUARD_BASE_PORT || '10800');
      const wgUser = process.env.WG_PROXY_USER;
      const wgPass = process.env.WG_PROXY_PASS;

      if (!wgUser || !wgPass) {
        console.error('❌ WG_PROXY_USER/WG_PROXY_PASS not configured');
        return res.status(500).json({ error: 'WireGuard credentials not configured' });
      }

      const port = wgBasePort + wireguard_bucket;
      const socksProxy = `socks5://${wgUser}:${wgPass}@${wgHost}:${port}`;
      proxyAgent = new SocksProxyAgent(socksProxy);

    } else {
      // Direct connection (no proxy)
    }

    // For web API, endpoint already has query string; for mobile API, use params
    const axiosConfig: any = {
      method: request.method,
      url: `${baseUrl}${request.endpoint}`,
      data: request.body,
      headers: requestHeaders,
      timeout: 15000
    };

    // Only add proxy agent if VPN routing is enabled
    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent;
      axiosConfig.httpsAgent = proxyAgent;
    }

    // Only add params if not already in URL (mobile API uses params object)
    if (!isWebApi && request.params && Object.keys(request.params).length > 0) {
      axiosConfig.params = request.params;
    }

    const tiktokResponse = await axios.request(axiosConfig);

    // 8. Return response (public video metadata)
    res.json(tiktokResponse.data);

  } catch (error: any) {
    console.error('TikTok request execution failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================

// ============================================================================
// MIGRATION ENDPOINT (v2.4 → perf branch cookie migration)
// ============================================================================

/**
 * Process ALL pending cookie migrations
 * Loops through all users with plaintext cookies, encrypts with TEE key,
 * stores in tee_encrypted_cookies, clears temp column.
 *
 * POST /migrate/process-pending
 * Requires X-Migration-Key header matching MIGRATION_TRIGGER_KEY env var
 */
app.post('/migrate/process-pending', async (req, res) => {
  // Auth: require migration trigger key
  const triggerKey = req.header('X-Migration-Key');
  const expectedKey = process.env.MIGRATION_TRIGGER_KEY;

  if (!expectedKey || triggerKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Migration-Key' });
  }

  const xordiApiUrl = process.env.XORDI_API_URL || 'http://xordi-private-api:3001';
  const xordiApiKey = process.env.XORDI_API_KEY;

  if (!xordiApiKey) {
    return res.status(500).json({ error: 'XORDI_API_KEY not configured' });
  }

  // Guard: If DStack socket exists but DStack failed to init, refuse to encrypt
  const dstackSocketExists = fs.existsSync('/var/run/dstack.sock');
  if (dstackSocketExists && !teeCrypto.isDStackKey()) {
    return res.status(503).json({ error: 'DStack socket present but key not initialized' });
  }

  let totalSuccess = 0;
  let totalFailed = 0;
  let batchCount = 0;

  try {
    // Loop until no more pending users
    while (true) {
      batchCount++;

      // Get next batch of users (100 at a time)
      const pendingResponse = await axios.get(
        `${xordiApiUrl}/api/enclave/migrate/pending`,
        { headers: { 'X-Api-Key': xordiApiKey } }
      );

      const pendingUsers = pendingResponse.data.users || [];

      // Exit loop when no more pending
      if (pendingUsers.length === 0) {
        console.log(`✅ Migration complete after ${batchCount} batches`);
        break;
      }

      console.log(`🔄 Batch ${batchCount}: Processing ${pendingUsers.length} users...`);

      for (const user of pendingUsers) {
        try {
          // Parse plaintext cookies (already in array format)
          const cookies = user._migration_cookies_plaintext;

          // Encrypt with TEE key
          const encryptedHex = teeCrypto.encryptCookies(cookies);

          // Store encrypted cookies and clear temp column
          await axios.post(
            `${xordiApiUrl}/api/enclave/migrate/complete`,
            {
              sec_user_id: user.sec_user_id,
              tee_encrypted_cookies: encryptedHex
            },
            { headers: { 'X-Api-Key': xordiApiKey } }
          );

          totalSuccess++;
        } catch (err: any) {
          totalFailed++;
          console.error(`❌ ${user.sec_user_id}: ${err.message}`);
        }
      }

      console.log(`   Batch ${batchCount} done: ${totalSuccess} success, ${totalFailed} failed so far`);
    }

    res.json({
      success: true,
      processed: totalSuccess,
      failed: totalFailed,
      batches: batchCount
    });

  } catch (error: any) {
    console.error('Migration processing failed:', error.message);
    res.status(500).json({
      error: error.message,
      processed_before_error: totalSuccess,
      failed_before_error: totalFailed
    });
  }
});

/**
 * POST /migrate/verify-encryption
 * Classifies each user's cookies by which key can decrypt them.
 * Auth: X-Migration-Key header.
 */
app.post('/migrate/verify-encryption', async (req, res) => {
  const triggerKey = req.header('X-Migration-Key');
  const expectedKey = process.env.MIGRATION_TRIGGER_KEY;

  if (!expectedKey || triggerKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Migration-Key' });
  }

  const xordiApiUrl = process.env.XORDI_API_URL || 'http://xordi-private-api:3001';
  const xordiApiKey = process.env.XORDI_API_KEY;

  if (!xordiApiKey) {
    return res.status(500).json({ error: 'XORDI_API_KEY not configured' });
  }

  let totalSampled = 0;
  let encryptedWithFallback = 0;
  let encryptedWithDstack = 0;
  let decryptionFailedBoth = 0;
  let offset = 0;

  try {
    while (true) {
      const response = await axios.get(
        `${xordiApiUrl}/api/enclave/migrate/all-encrypted-users?offset=${offset}`,
        { headers: { 'X-Api-Key': xordiApiKey } }
      );

      const users = response.data.users || [];
      if (users.length === 0) break;

      for (const user of users) {
        totalSampled++;
        const hex = user.tee_encrypted_cookies;

        if (teeCrypto.canDecryptWithFallback(hex)) {
          encryptedWithFallback++;
        } else {
          try {
            teeCrypto.decryptCookies(hex);
            encryptedWithDstack++;
          } catch (e) {
            decryptionFailedBoth++;
          }
        }
      }

      offset += users.length;
    }

    res.json({
      total_sampled: totalSampled,
      encrypted_with_fallback: encryptedWithFallback,
      encrypted_with_dstack: encryptedWithDstack,
      decryption_failed_both: decryptionFailedBoth,
      dstack_key_active: teeCrypto.isDStackKey()
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /migrate/upgrade-to-tee-key
 * Re-encrypts all fallback-encrypted cookies with the DStack-derived key.
 * Self-paginating: processes all users in batches of 50 internally.
 * Auth: X-Migration-Key header.
 * Precondition: DStack key must be active.
 */
app.post('/migrate/upgrade-to-tee-key', async (req, res) => {
  const triggerKey = req.header('X-Migration-Key');
  const expectedKey = process.env.MIGRATION_TRIGGER_KEY;

  if (!expectedKey || triggerKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Migration-Key' });
  }

  if (!teeCrypto.isDStackKey()) {
    return res.status(503).json({ error: 'DStack key not initialized — cannot re-encrypt' });
  }

  const xordiApiUrl = process.env.XORDI_API_URL || 'http://xordi-private-api:3001';
  const xordiApiKey = process.env.XORDI_API_KEY;

  if (!xordiApiKey) {
    return res.status(500).json({ error: 'XORDI_API_KEY not configured' });
  }

  let totalProcessed = 0;
  let reEncrypted = 0;
  let alreadyDstack = 0;
  let failedBothKeys = 0;
  const failedUsers: string[] = [];
  let batchCount = 0;
  let offset = 0;

  try {
    while (true) {
      batchCount++;

      const response = await axios.get(
        `${xordiApiUrl}/api/enclave/migrate/all-encrypted-users?offset=${offset}`,
        { headers: { 'X-Api-Key': xordiApiKey } }
      );

      const users = response.data.users || [];
      if (users.length === 0) break;

      console.log(`🔄 Re-encryption batch ${batchCount}: ${users.length} users (offset ${offset})...`);

      for (const user of users) {
        totalProcessed++;
        const hex = user.tee_encrypted_cookies;

        try {
          // Try fallback key first
          if (teeCrypto.canDecryptWithFallback(hex)) {
            const plaintext = teeCrypto._decryptWithFallbackKey(hex);
            const reEncryptedHex = teeCrypto.encryptCookies(plaintext);

            await axios.post(
              `${xordiApiUrl}/api/enclave/migrate/complete`,
              { sec_user_id: user.sec_user_id, tee_encrypted_cookies: reEncryptedHex },
              { headers: { 'X-Api-Key': xordiApiKey } }
            );

            reEncrypted++;
          } else {
            // Try current (DStack) key — already migrated
            try {
              teeCrypto.decryptCookies(hex);
              alreadyDstack++;
            } catch (e) {
              failedBothKeys++;
              failedUsers.push(user.sec_user_id);
              console.error(`❌ ${user.sec_user_id}: both keys failed`);
            }
          }
        } catch (err: any) {
          failedBothKeys++;
          failedUsers.push(user.sec_user_id);
          console.error(`❌ ${user.sec_user_id}: ${err.message}`);
        }
      }

      offset += users.length;
      console.log(`   Batch ${batchCount}: ${reEncrypted} re-encrypted, ${alreadyDstack} already DStack, ${failedBothKeys} failed`);
    }

    res.json({
      total_processed: totalProcessed,
      re_encrypted: reEncrypted,
      already_dstack: alreadyDstack,
      failed_both_keys: failedBothKeys,
      failed_users: failedUsers,
      batches: batchCount
    });
  } catch (error: any) {
    console.error('Re-encryption failed:', error.message);
    res.status(500).json({
      error: error.message,
      total_processed: totalProcessed,
      re_encrypted: reEncrypted,
      already_dstack: alreadyDstack,
      failed_both_keys: failedBothKeys,
      failed_users: failedUsers
    });
  }
});

// ============================================================================
// TEE-TO-TEE MIGRATION ENDPOINTS
// ============================================================================

/**
 * POST /migrate/encrypt-incoming
 * Accepts plaintext cookies from the old TEE, encrypts with local DStack key.
 * Called by the old TEE during TEE-to-TEE migration.
 * Auth: X-Migration-Key header.
 * Precondition: DStack key must be initialized.
 */
app.post('/migrate/encrypt-incoming', async (req, res) => {
  const triggerKey = req.header('X-Migration-Key');
  const expectedKey = process.env.MIGRATION_TRIGGER_KEY;

  if (!expectedKey || triggerKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Migration-Key' });
  }

  if (!teeCrypto.isDStackKey()) {
    return res.status(503).json({ error: 'DStack key not initialized' });
  }

  try {
    const { sec_user_id, cookies } = req.body;

    if (!sec_user_id || !cookies) {
      return res.status(400).json({ error: 'Missing sec_user_id or cookies' });
    }

    const encryptedHex = teeCrypto.encryptCookies(cookies);

    res.json({
      success: true,
      encrypted_hex: encryptedHex,
      sec_user_id
    });
  } catch (error: any) {
    console.error('encrypt-incoming failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /migrate/verify-decrypt
 * Accepts an encrypted hex blob, attempts decryption, returns success/failure.
 * Used by the old TEE to verify the new TEE can decrypt re-encrypted cookies.
 * Auth: X-Migration-Key header.
 * Precondition: DStack key must be initialized.
 */
app.post('/migrate/verify-decrypt', async (req, res) => {
  const triggerKey = req.header('X-Migration-Key');
  const expectedKey = process.env.MIGRATION_TRIGGER_KEY;

  if (!expectedKey || triggerKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Migration-Key' });
  }

  if (!teeCrypto.isDStackKey()) {
    return res.status(503).json({ error: 'DStack key not initialized' });
  }

  try {
    const { encrypted_hex, sec_user_id } = req.body;

    if (!encrypted_hex || !sec_user_id) {
      return res.status(400).json({ error: 'Missing encrypted_hex or sec_user_id' });
    }

    try {
      teeCrypto.decryptCookies(encrypted_hex);
      res.json({ success: true, can_decrypt: true, sec_user_id });
    } catch (decryptError) {
      res.json({ success: true, can_decrypt: false, sec_user_id });
    }
  } catch (error: any) {
    console.error('verify-decrypt failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /migrate/tee-to-tee-single
 * Processes a single user: decrypts with old DStack key, sends plaintext to new TEE
 * for re-encryption, verifies both directions, returns result to Borgcube.
 * Auth: X-Migration-Key header.
 * Precondition: DStack key must be initialized.
 * Env required: MIGRATION_TARGET_TEE_URL, MIGRATION_TARGET_API_KEY
 */
app.post('/migrate/tee-to-tee-single', async (req, res) => {
  const triggerKey = req.header('X-Migration-Key');
  const expectedKey = process.env.MIGRATION_TRIGGER_KEY;

  if (!expectedKey || triggerKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Migration-Key' });
  }

  if (!teeCrypto.isDStackKey()) {
    return res.status(503).json({ error: 'DStack key not initialized' });
  }

  const targetTeeUrl = process.env.MIGRATION_TARGET_TEE_URL;
  const targetApiKey = process.env.MIGRATION_TARGET_API_KEY;

  if (!targetTeeUrl || !targetApiKey) {
    return res.status(500).json({ error: 'MIGRATION_TARGET_TEE_URL or MIGRATION_TARGET_API_KEY not configured' });
  }

  try {
    const { sec_user_id, encrypted_hex } = req.body;

    if (!sec_user_id || !encrypted_hex) {
      return res.status(400).json({ error: 'Missing sec_user_id or encrypted_hex' });
    }

    // Step 1: Decrypt with old (local) DStack key
    let plaintext: any;
    try {
      plaintext = teeCrypto.decryptCookies(encrypted_hex);
    } catch (decryptError: any) {
      return res.json({
        success: false,
        sec_user_id,
        error: `Decryption failed with current key: ${decryptError.message}`
      });
    }

    // Step 2: Send plaintext to new TEE for re-encryption
    const encryptResponse = await axios.post(
      `${targetTeeUrl}/migrate/encrypt-incoming`,
      { sec_user_id, cookies: plaintext },
      {
        headers: { 'X-Migration-Key': targetApiKey },
        timeout: 30000
      }
    );

    if (!encryptResponse.data.success || !encryptResponse.data.encrypted_hex) {
      return res.json({
        success: false,
        sec_user_id,
        error: `New TEE encrypt-incoming failed: ${encryptResponse.data.error || 'no encrypted_hex returned'}`
      });
    }

    const newEncryptedHex = encryptResponse.data.encrypted_hex;

    // Step 3: Verify new TEE can decrypt the new blob
    const verifyResponse = await axios.post(
      `${targetTeeUrl}/migrate/verify-decrypt`,
      { sec_user_id, encrypted_hex: newEncryptedHex },
      {
        headers: { 'X-Migration-Key': targetApiKey },
        timeout: 30000
      }
    );

    const newTeeCanDecrypt = verifyResponse.data.can_decrypt === true;

    // Step 4: Verify old TEE CANNOT decrypt the new blob (key isolation)
    let oldTeeCannotDecrypt = false;
    try {
      teeCrypto.decryptCookies(newEncryptedHex);
      // If we get here, old TEE CAN decrypt — key isolation failed
      oldTeeCannotDecrypt = false;
    } catch (e) {
      // Expected: AES-GCM auth tag mismatch proves different keys
      oldTeeCannotDecrypt = true;
    }

    res.json({
      success: true,
      sec_user_id,
      new_encrypted_hex: newEncryptedHex,
      verification: {
        new_tee_can_decrypt: newTeeCanDecrypt,
        old_tee_cannot_decrypt: oldTeeCannotDecrypt
      }
    });
  } catch (error: any) {
    console.error(`tee-to-tee-single failed for ${req.body?.sec_user_id}:`, error.message);
    res.json({
      success: false,
      sec_user_id: req.body?.sec_user_id,
      error: error.message
    });
  }
});

// ============================================================================

const startTime = Date.now();

// v3-s: Debug screenshot endpoint (with API key auth)
app.get('/debug/screenshot/:token', (req, res) => {
  if (process.env.ENABLE_DEBUG_SCREENSHOTS !== 'true') {
    return res.status(404).json({ error: 'Debug screenshots disabled' });
  }

  // Require API key auth
  const apiKey = req.header('X-Api-Key');
  const allowedKeys = (process.env.XORDI_API_KEY || '').split(',').filter((k: string) => k);
  if (!apiKey || !allowedKeys.includes(apiKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { token } = req.params;
  const screenshot = debugScreenshots.get(token);

  if (!screenshot) {
    return res.status(404).json({ error: 'Screenshot not found or expired' });
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition',
    `inline; filename="debug-${screenshot.authSessionId.substring(0, 8)}-${screenshot.reason}.png"`);
  res.send(screenshot.buffer);
});

// v3-w: List all active debug screenshots
app.get('/debug/screenshots', (req, res) => {
  if (process.env.ENABLE_DEBUG_SCREENSHOTS !== 'true') {
    return res.json({ enabled: false, count: 0, screenshots: [] });
  }

  // Require API key auth
  const apiKey = req.header('X-Api-Key');
  const allowedKeys = (process.env.XORDI_API_KEY || '').split(',').filter((k: string) => k);
  if (!apiKey || !allowedKeys.includes(apiKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const baseUrl = process.env.DEBUG_SCREENSHOT_BASE_URL
    || `${req.protocol}://${req.get('host')}`;
  const now = Date.now();

  const screenshots = Array.from(debugScreenshots.entries()).map(([token, ss]) => ({
    token,
    url: `${baseUrl}/debug/screenshot/${token}`,
    authSessionId: ss.authSessionId,
    step: ss.step,
    reason: ss.reason,
    pageUrl: ss.url,
    pageTitle: ss.title,
    timestamp: new Date(ss.timestamp).toISOString(),
    ageMs: now - ss.timestamp,
    expiresInMs: DEBUG_SCREENSHOT_TTL_MS - (now - ss.timestamp)
  }));

  res.json({
    enabled: true,
    ttlMs: DEBUG_SCREENSHOT_TTL_MS,
    count: screenshots.length,
    screenshots
  });
});

// z-4: Get all screenshots for a specific auth session
app.get('/debug/screenshots/:authSessionId', (req, res) => {
  const apiKey = req.headers['x-api-key'] as string;
  const allowedKeys = (process.env.XORDI_API_KEY || '').split(',').filter((k: string) => k);
  if (!apiKey || !allowedKeys.includes(apiKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { authSessionId } = req.params;
  const baseUrl = process.env.DEBUG_SCREENSHOT_BASE_URL
    || `${req.protocol}://${req.get('host')}`;

  const screenshots = Array.from(debugScreenshots.entries())
    .filter(([_, ss]) => ss.authSessionId === authSessionId)
    .sort((a, b) => a[1].step - b[1].step)
    .map(([token, ss]) => ({
      token,
      url: `${baseUrl}/debug/screenshot/${token}`,
      step: ss.step,
      reason: ss.reason,
      pageUrl: `${new URL(ss.url).hostname}${new URL(ss.url).pathname}`,
      timestamp: new Date(ss.timestamp).toISOString()
    }));

  res.json({ authSessionId, count: screenshots.length, screenshots });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    instance_id: process.env.INSTANCE_ID || 'main',
    auth_only_mode: process.env.AUTH_ONLY_MODE === 'true',
    uptime: (Date.now() - startTime) / 1000,
    sessions: sessionManager?.getSessionCount() || 0,
    dstack: !!dstackSDK,
    dstackInitialized: !!dstackSDK,
    encryption: !!encryptionKey,
    cookieEncryption: teeCrypto.isDStackKey() ? 'dstack' : 'fallback',
    timestamp: new Date().toISOString()
  });
});

// Readiness check - can accept requests
app.get('/ready', async (req, res) => {
  try {
    // Check if browser-manager is reachable and has capacity
    const bmUrl = process.env.BROWSER_MANAGER_URL || 'http://browser-manager:3001';
    const response = await axios.get(`${bmUrl}/stats`, { timeout: 5000 });

    const { available, total, authSlotsAvailable } = response.data;

    if (available > 0 || (authSlotsAvailable !== undefined && authSlotsAvailable > 0)) {
      res.json({
        status: 'ready',
        instance_id: process.env.INSTANCE_ID || 'main',
        auth_only_mode: process.env.AUTH_ONLY_MODE === 'true',
        capacity: {
          containers_available: available,
          containers_total: total,
          auth_slots_available: authSlotsAvailable
        }
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        reason: 'no_available_capacity',
        instance_id: process.env.INSTANCE_ID || 'main'
      });
    }
  } catch (error: any) {
    res.status(503).json({
      status: 'not_ready',
      reason: 'browser_manager_unavailable',
      error: error.message,
      instance_id: process.env.INSTANCE_ID || 'main'
    });
  }
});

// TEE identity + attestation data (public — no auth required)
app.get('/tee-info', async (req, res) => {
  try {
    if (!dstackSDK) {
      return res.status(503).json({ error: 'DStack not initialized' });
    }
    const info = await dstackSDK.info();
    res.json({
      app_id: info.app_id,
      instance_id: info.instance_id,
      auth_only_mode: process.env.AUTH_ONLY_MODE === 'true',
      compose_hash: info.compose_hash,
      tcb_info: info.tcb_info,
      dstack_sdk_version: (() => { try { return require('./package.json').dependencies['@phala/dstack-sdk']; } catch { return 'unknown'; } })()
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get TEE info', details: err.message });
  }
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

  // Initialize Xordi security module (Python subprocess)
  await xordiSecurityModule.initialize();
  console.log('🔐 Xordi security module initialized');

  // Cleanup expired auth sessions periodically
  setInterval(async () => {
    await authSessionManager?.cleanupExpired();
  }, 60000); // Every minute

  // T1: Heartbeat every 5 minutes
  setInterval(() => {
    const uptimeSec = Math.round((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = `${hours}h${mins}m`;
    const bmStats = fetch(`${BROWSER_MANAGER_URL}/stats`).then(r => r.json()).catch(() => ({ total: 0, poolSize: 0, assigned: 0 }));
    bmStats.then((stats: any) => {
      log.ok('HEALTH', 'heartbeat', {
        uptime: uptimeStr,
        pool_total: stats.poolSize || stats.total || 0,
        pool_idle: (stats.poolSize || stats.total || 0) - (stats.assigned || 0),
        auth_active: sessionManager?.getSessionCount() || 0
      });
    }).catch(() => {});
  }, 5 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🚀 Multi-User TCB Server running on port ${PORT}`);
    console.log(`📊 Session timeout: ${Math.round(3600000 / 60000)} minutes`);
    console.log(`🔐 Auth session timeout: ${Math.round(120000 / 1000)} seconds`);
    log.ok('HEALTH', 'startup_ok', { port: PORT, version: 'v1.1.3NX' });
  });
}

startServer().catch(console.error);