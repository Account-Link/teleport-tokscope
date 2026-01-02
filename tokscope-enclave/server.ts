import express from 'express';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import jsQR from 'jsqr';
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
}

// v3-s: Debug screenshot storage (in-memory with TTL)
interface DebugScreenshot {
  buffer: Buffer;
  timestamp: number;
  authSessionId: string;
  reason: string;
  url: string;
  title: string;
}

const debugScreenshots = new Map<string, DebugScreenshot>();
const DEBUG_SCREENSHOT_TTL_MS = parseInt(process.env.DEBUG_SCREENSHOT_TTL_MS || '600000'); // 10 min default

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

    debugScreenshots.set(token, {
      buffer,
      timestamp: Date.now(),
      authSessionId,
      reason,
      url,
      title
    });

    // Log clickable URL (appears in docker logs)
    const baseUrl = process.env.DEBUG_SCREENSHOT_BASE_URL || '';
    const screenshotUrl = `${baseUrl}/debug/screenshot/${token}`;
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

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [authSessionId, session] of this.authSessions.entries()) {
      if (now - session.startedAt > this.AUTH_TIMEOUT_MS) {
        expired.push(authSessionId);
      }
    }

    for (const authSessionId of expired) {
      console.log(`🧹 Cleaning up expired auth session: ${authSessionId.substring(0, 8)}...`);

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
  console.log(`🔄 Container assigned: ${result.container.containerId?.substring(0, 20)}... (IP: ${result.container.ip})`);

  // v3-v: Connect via CDP - THIS IS THE ONLY CONNECTION
  // browser-manager no longer creates a CDP connection
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

  // v3-v: Create OUR context - cookies will be in THIS context
  // This is the key fix: same connection owns context = cookies visible
  console.log(`📦 Creating browser context (Solution F: single CDP owner)...`);

  // Issue 7b: Wrap browser operations in try-catch for TargetClosedError
  let context, page;
  try {
    context = await browser!.newContext();
    page = await context.newPage();
  } catch (error: any) {
    if (error.name === 'TargetClosedError' || error.message?.includes('Target closed')) {
      console.error(`⚠️ Browser closed during context creation for ${sessionId}`);
      throw new Error('BROWSER_DISCONNECTED');
    }
    throw error;
  }
  console.log(`✅ Browser instance ready with fresh context`);

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
    const { preAuthToken } = req.body;  // 🔥 NEW: Accept pre-auth token for TEE integration

    if (!authSessionManager) {
      return res.status(500).json({ error: 'Auth session manager not initialized' });
    }

    if (preAuthToken) {
      console.log(`🔐 Starting TEE-integrated authentication for session ${sessionId.substring(0, 8)}... (pre-auth token provided)`);
    } else {
      console.log(`🔐 Starting legacy authentication for session ${sessionId.substring(0, 8)}... (no pre-auth token)`);
    }

    // Create auth session
    const authSessionId = authSessionManager.createAuthSession(sessionId);

    // Start authentication flow asynchronously
    (async () => {
      let browserInstance: BrowserInstance | null = null;

      try {
        // v3-v: Request browser container - NOW INCLUDES context/page creation
        // This is the Solution F fix: single CDP connection owns everything
        browserInstance = await requestBrowserInstance(authSessionId);

        authSessionManager.updateAuthSession(authSessionId, {
          containerId: browserInstance.containerId,
          browser: browserInstance.browser,
          page: browserInstance.page
        });

        const authPage = browserInstance.page;

        // v3-v: Navigate to QR login page (moved from browser-manager)
        // We always navigate since we created a fresh page
        console.log(`🌐 Navigating to QR login page for auth ${authSessionId.substring(0, 8)}...`);
        await authPage.goto('https://www.tiktok.com/login/qrcode', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        // Wait for QR code with diagnostics on failure
        try {
          await authPage.waitForSelector('img[alt="qrcode"]', {
            timeout: 10000,
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
        const qrData = await QRExtractor.extractQRCodeFromPage(authPage, authSessionId);
        authSessionManager.updateAuthSession(authSessionId, {
          qrCodeData: qrData.image,
          qrDecodedUrl: qrData.decodedUrl
        });

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
      subtree: true,
      attributes: true
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
      for (const name of requiredCookies) {
        if (cookieNames.includes(name) && !arrivedCookies.has(name)) {
          arrivedCookies.add(name);
          console.log(`🍪 Auth ${authSessionId.substring(0, 8)} cookie: ${name} (${arrivedCookies.size}/6)`);
        }
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
        } catch (recycleError) {
          console.error(`⚠️ Failed to recycle auth container for ${authSessionId}`);
        }

        return;
      }

      // 6b. SECONDARY: Cookie-based detection (belt and suspenders)
      if (arrivedCookies.size === 6) {
        console.log(`✅ Auth ${authSessionId.substring(0, 8)} login successful (all 6 cookies)`);

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

      await new Promise(resolve => setTimeout(resolve, 1000));

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
    console.log('🔼 Escalating trust level...');

    // Issue 6: Wrap escalate-trust in separate try-catch (don't re-throw)
    try {
      const escalateResponse = await axios.post(
        `${xordiApiUrl}/api/enclave/escalate-trust`,
        {
          sec_user_id: secUserId,
          pre_auth_token: preAuthToken,
          tokscope_session_id: authSessionId
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
        console.log(`✅ Trust escalated: ${secUserId} → trust_level=2 (verified)`);
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
        qrCodeData: authSession.qrCodeData,
        qrDecodedUrl: authSession.qrDecodedUrl  // Include magic link
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
    console.error('Auth poll error:', error.message);
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
    console.error(`❌ Sampling error for ${req.params.sessionId}:`, error.message);
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
    console.error(`❌ Sampling error for ${req.params.sessionId}:`, error.message);
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
    console.error(`❌ Module sampling error for ${req.params.sessionId}:`, error.message);
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
    console.error(`❌ Module sampling error for ${req.params.sessionId}:`, error.message);
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
      console.log(`📦 Using local session for ${sec_user_id.substring(0, 8)}...`);
    } else {
      // Retrieve TEE-encrypted cookies from Xordi DB
      console.log(`🔍 Retrieving TEE-encrypted cookies from Xordi for ${sec_user_id.substring(0, 8)}...`);

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

        // Decrypt cookies IN TEE
        console.log(`🔓 Decrypting cookies in TEE...`);
        const encryptedHex = cookiesResponse.data.tee_encrypted_cookies;
        cookies = teeCrypto.decryptCookies(encryptedHex);

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

        console.log(`✅ Cookies decrypted successfully (${cookies.length} cookies)`);

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
          console.log(`🔄 Replaced msToken in URL with fresh value from cookies`);
        }
      } catch (urlError) {
        console.log(`⚠️ Could not parse endpoint as URL, skipping msToken injection`);
      }
    }

    // 4. Detect API type (web vs mobile)
    const apiType = request.apiType || 'mobile';
    const isWebApi = apiType === 'web';

    console.log(`🌐 API Type: ${apiType}`);

    // 5. Extract cookies - different filtering for web vs mobile
    let cookieString = '';
    if (cookies && Array.isArray(cookies)) {
      if (isWebApi) {
        // Web API: Use all cookies
        cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
        console.log(`🍪 Using ${cookies.length} web cookies`);
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
        const filteredCookies = cookies.filter((c: any) => mobileCookieNames.includes(c.name));
        cookieString = filteredCookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
        console.log(`🍪 Filtered ${cookies.length} cookies → ${filteredCookies.length} mobile cookies`);
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

      console.log(`🌐 Routing through IPFoxy (session: ${ipfoxy_session.substring(0, 8)}...) for user ${sec_user_id.substring(0, 16)}...`);

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

      console.log(`🌐 [wireguard] bucket ${wireguard_bucket} → ${wgHost}:${port}`);

    } else {
      console.log(`🌐 Using direct connection (no proxy configured)`);
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

    // DEBUG: Log the exact request being made
    console.log(`📤 REQUEST URL: ${axiosConfig.url}`);
    console.log(`📤 REQUEST HEADERS:`, JSON.stringify(Object.keys(requestHeaders)));
    console.log(`📤 COOKIE NAMES: ${cookies.map((c: any) => c.name).join(', ')}`);

    const tiktokResponse = await axios.request(axiosConfig);

    // 8. Return response (public video metadata)
    console.log(`✅ TikTok response status: ${tiktokResponse.status}`);
    console.log(`📦 Response keys: ${Object.keys(tiktokResponse.data || {}).join(', ')}`);
    if (isWebApi) {
      console.log(`📊 itemList length: ${(tiktokResponse.data?.itemList || []).length}`);
      if (!tiktokResponse.data?.itemList || tiktokResponse.data.itemList.length === 0) {
        console.error(`⚠️ Empty response from TikTok. Keys: ${Object.keys(tiktokResponse.data || {}).join(', ')}`);
      }
    }
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

  const baseUrl = process.env.DEBUG_SCREENSHOT_BASE_URL || '';
  const now = Date.now();

  const screenshots = Array.from(debugScreenshots.entries()).map(([token, ss]) => ({
    token,
    url: `${baseUrl}/debug/screenshot/${token}`,
    authSessionId: ss.authSessionId,
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

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    instance_id: process.env.INSTANCE_ID || 'main',
    auth_only_mode: process.env.AUTH_ONLY_MODE === 'true',
    uptime: (Date.now() - startTime) / 1000,
    sessions: sessionManager?.getSessionCount() || 0,
    dstack: !!dstackSDK,
    encryption: !!encryptionKey,
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

  app.listen(PORT, () => {
    console.log(`🚀 Multi-User TCB Server running on port ${PORT}`);
    console.log(`📊 Session timeout: ${Math.round(3600000 / 60000)} minutes`);
    console.log(`🔐 Auth session timeout: ${Math.round(120000 / 1000)} seconds`);
  });
}

startServer().catch(console.error);