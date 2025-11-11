#!/usr/bin/env node

/**
 * Xordi Dev Tool - Development Environment Automation
 *
 * Interactive tool for developing TikTok automation using the tokscope-dev environment.
 * Provides authentication, sampling, and development tools for browser automation.
 *
 * Note: This tool only works with dev mode containers (docker-compose.yml)
 * For production use, see docker-compose-audit.yml and the enclave API.
 */

const { chromium } = require('playwright');
const Docker = require('dockerode');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Initialize proxy configuration for all HTTP clients
const { initializeProxy } = require('./dist/lib/proxy-config');
initializeProxy();

// Import API clients and shared modules
const WebApiClient = require('./dist/lib/web-api-client.js');
const BrowserConnection = require('./dist/lib/browser-connection.js');
const QRExtractor = require('./dist/lib/qr-extractor.js');
const BrowserAutomationClient = require('./dist/lib/browser-automation-client.js');

class XordiDevTool {
  constructor(options = {}) {
    this.options = options;
    this.docker = new Docker();
    this.config = this.loadConfig();
    this.containerName = this.config.container?.name || 'simple-auth-container';
    this.browser = null;
    this.page = null;
    this.qrServer = null;
    this.qrServerPort = this.config.container?.qr_server_port || 3334;
    this.cdpPort = this.config.container?.cdp_port || 9222;
    this.sessionData = null;
    this.containerWasAlreadyRunning = false;  // Track if container existed when we started
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, 'devenv-config.json');
      return JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.log('⚠️  Could not load devenv-config.json, using defaults');
      return {
        container: { cdp_port: 9222, qr_server_port: 3334, name: 'simple-auth-container' }
      };
    }
  }

  async run() {
    try {
      console.log('🚀 Xordi Dev Tool - Development Environment');
      console.log('='.repeat(40));

      // Check if container is already running
      this.containerWasAlreadyRunning = await this.isContainerRunning();

      // Step 1: Get session data
      await this.getSessionData();

      // Step 2: Sample timeline
      await this.sampleTimeline();

      console.log('✅ Sampling completed successfully!');

    } catch (error) {
      console.error('❌ Error:', error.message);
      if (this.options.debug) {
        console.error('Stack trace:', error.stack);
      }
      return { success: false, error: error.message };
    } finally {
      await this.cleanup();
    }
  }

  async getSessionData() {
    if (this.options.loggedout) {
      // Allow sampling without authentication
      console.log('⚠️  Sampling without authentication - content will be limited');
      this.sessionData = null;
      return;
    }

    if (this.options.session) {
      // Load from existing JSON file
      console.log(`📂 Loading session from: ${this.options.session}`);
      const sessionContent = await fs.readFile(this.options.session, 'utf8');
      this.sessionData = JSON.parse(sessionContent);

      if (!this.sessionData.cookies || !this.sessionData.user) {
        throw new Error('Invalid session file format');
      }

      console.log(`✅ Loaded session for @${this.sessionData.user.username}`);

    } else if (this.options.auth) {
      // Perform authentication (use existing container if available)
      console.log('🔐 Starting authentication...');
      this.sessionData = await this.performAuthentication();

    } else {
      // Try to find most recent session file
      console.log('🔍 Looking for recent session files...');
      const recentSession = await this.findRecentSession();

      if (recentSession) {
        console.log(`📂 Using recent session: ${recentSession}`);
        const sessionContent = await fs.readFile(recentSession, 'utf8');
        this.sessionData = JSON.parse(sessionContent);
      } else {
        console.log('No recent session found, starting authentication...');
        this.sessionData = await this.performAuthentication();
      }
    }
  }

  async findRecentSession() {
    try {
      const outputDir = path.join(__dirname, 'output');
      const files = await fs.readdir(outputDir);
      const sessionFiles = files
        .filter(f => f.startsWith('tiktok-auth-') && f.endsWith('.json'))
        .map(f => ({ name: f, path: path.join(outputDir, f) }))
        .sort((a, b) => b.name.localeCompare(a.name)); // Sort by filename (newest first)

      return sessionFiles.length > 0 ? sessionFiles[0].path : null;
    } catch (error) {
      return null;
    }
  }

  async checkHealth() {
    console.log('🏥 Checking authentication health...');

    // Step 1: Check session files
    console.log('🔍 Checking session files...');
    const recentSession = await this.findRecentSession();

    if (!recentSession) {
      console.log('❌ No authentication sessions found');
      console.log('💡 Run "node tokscope.js auth" to authenticate');
      return;
    }

    let sessionData;
    try {
      const sessionContent = await fs.readFile(recentSession, 'utf8');
      sessionData = JSON.parse(sessionContent);

      console.log(`✅ Found recent session: ${path.basename(recentSession)}`);
      console.log(`👤 User: @${sessionData.user?.username || 'Unknown'}`);
      console.log(`📊 User ID: ${sessionData.user?.sec_user_id || 'Unknown'}`);
      console.log(`🍪 Cookies: ${sessionData.cookies?.length || 0} stored`);
      console.log(`🔑 Tokens: ${Object.keys(sessionData.tokens || {}).length} stored`);

      // Check session age
      const match = path.basename(recentSession).match(/tiktok-auth-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
      if (match) {
        const sessionTime = match[1].replace(/-/g, ':').replace(/T/, ' ');
        console.log(`⏰ Session created: ${sessionTime}`);
      }

    } catch (error) {
      console.log('❌ Session file corrupted or invalid');
      console.log('💡 Run "node tokscope.js auth" to re-authenticate');
      return;
    }

    // Step 2: Check container status (dev vs auth mode)
    let isDevMode = false;
    let containerInfo = '';
    try {
      const containers = await this.docker.listContainers({ all: true });
      const devContainer = containers.find(c => c.Names.some(name => name.includes('dev-browser')));
      const authContainer = containers.find(c => c.Names.includes('/simple-auth-container'));

      if (devContainer && devContainer.State === 'running') {
        isDevMode = true;
        containerInfo = `🐳 Dev Container: ${devContainer.State} (${devContainer.Status})`;
        console.log(containerInfo);
      } else if (authContainer && authContainer.State === 'running') {
        containerInfo = `🐳 Auth Container: ${authContainer.State} (${authContainer.Status})`;
        console.log(containerInfo);
      } else if (authContainer) {
        console.log(`🐳 Container: ${authContainer.State} - starting for health check...`);
        await this.startAuthContainer();
      } else {
        console.log('🐳 Container: Not found - starting for health check...');
        await this.startAuthContainer();
      }
    } catch (error) {
      console.log('🐳 Container: Starting for health check...');
      await this.startAuthContainer();
    }

    // Step 3: Test authentication by navigating to TikTok in a separate tab
    console.log('🌐 Testing authentication by navigating to TikTok (new tab)...');

    let browser = null;
    let healthPage = null;

    try {
      // Connect directly to browser and create new page for health check
      const { chromium } = require('playwright');
      const cdpUrl = `http://localhost:${this.cdpPort}`;
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 5000 });
      const context = browser.contexts()[0];

      if (!context) {
        console.log('❌ No browser context found - container may not be ready');
        return;
      }

      // Create new page (tab) for health check - won't interfere with existing pages
      healthPage = await context.newPage();

      // Load session cookies into the new page
      if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
        await context.addCookies(sessionData.cookies);
        console.log(`🍪 Loaded ${sessionData.cookies.length} cookies into health check tab`);
      }

      // Navigate to TikTok and check if logged in
      await healthPage.goto('https://www.tiktok.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      });

      // Wait for navigation elements to load (indicates page is ready)
      try {
        await healthPage.waitForSelector('[data-e2e="nav-foryou"], [data-e2e="tiktok-logo"]', {
          timeout: 5000
        });
        console.log('✅ Navigation elements loaded');
      } catch (error) {
        console.log('⚠️  Navigation elements not found, continuing...');
      }

      // Check for login indicators
      let loginStatus;
      try {
        loginStatus = await healthPage.evaluate(() => {
        // Check for profile avatar (indicates logged in)
        const avatar = document.querySelector('[data-e2e="profile-icon"]');

        // Check for login button (indicates logged out)
        const loginBtn = document.querySelector('[data-e2e="top-login-button"]');

        // Check for user menu or settings (indicates logged in)
        const userMenu = document.querySelector('[data-e2e="user-menu"], [data-e2e="nav-more"]');

        // Debug: find all data-e2e attributes on the page
        const allDataE2E = Array.from(document.querySelectorAll('[data-e2e]')).map(el => el.getAttribute('data-e2e'));

        return {
          hasAvatar: !!avatar,
          hasLoginButton: !!loginBtn,
          hasUserMenu: !!userMenu,
          currentUrl: window.location.href,
          debug: {
            dataE2EAttributes: allDataE2E.slice(0, 10),
            userAgent: navigator.userAgent,
            windowSize: { width: window.innerWidth, height: window.innerHeight },
            cookieCount: document.cookie.split(';').filter(c => c.trim()).length,
            pageTitle: document.title
          }
        };
      });
      } catch (evalError) {
        console.log('⚠️  Page evaluation failed:', evalError.message);
        loginStatus = {
          hasAvatar: false,
          hasLoginButton: false,
          hasUserMenu: false,
          currentUrl: 'unknown',
          debug: { error: evalError.message }
        };
      }

      if (loginStatus.debug && !loginStatus.debug.error) {
        console.log('🔍 Dev Health check debug info:', loginStatus.debug);
      }

      // Check both UI elements AND session data validity
      const hasValidSession = sessionData && sessionData.user && sessionData.user.sec_user_id;

      if (loginStatus.hasAvatar || loginStatus.hasUserMenu) {
        if (hasValidSession) {
          console.log('✅ Authentication test: LOGGED IN');
          console.log('🎉 Session is working properly');
        } else {
          console.log('⚠️  Authentication test: UI LOGGED IN but SESSION DATA INCOMPLETE');
          console.log('❌ Missing sec_user_id - API methods will fail');
          console.log('💡 Run "node tokscope.js auth" to get complete authentication data');
        }
      } else if (loginStatus.hasLoginButton) {
        console.log('❌ Authentication test: LOGGED OUT');
        console.log('💡 Session cookies have expired - run "node tokscope.js auth" to re-authenticate');
      } else {
        console.log('⚠️  Authentication test: UNCLEAR');
        console.log('🔍 Could not determine login status - page may still be loading');
      }

    } catch (error) {
      console.log('❌ Authentication test failed:', error.message);
      console.log('💡 Try running "node tokscope.js auth" to refresh authentication');

    } finally {
      // Always cleanup, regardless of success or failure
      try {
        if (healthPage) {
          await healthPage.close();
          console.log('🗑️  Health check tab closed');
        }
        if (browser) {
          await browser.close();
          console.log('🔌 Browser connection closed');
        }
      } catch (cleanupError) {
        console.log('⚠️  Cleanup warning:', cleanupError.message);
      }
    }
  }

  async checkIfLoggedIn() {
    try {
      // Navigate to main page to check login status
      await this.page.goto('https://www.tiktok.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      await this.page.waitForTimeout(2000);

      // Use same logic as health check
      const loginStatus = await this.page.evaluate(() => {
        // Check for profile avatar (indicates logged in)
        const avatar = document.querySelector('[data-e2e="profile-icon"]');

        // Check for login button (indicates logged out)
        const loginBtn = document.querySelector('[data-e2e="top-login-button"]');

        // Check for user menu or settings (indicates logged in)
        const userMenu = document.querySelector('[data-e2e="user-menu"], [data-e2e="nav-more"]');

        // Debug: find all data-e2e attributes on the page
        const allDataE2E = Array.from(document.querySelectorAll('[data-e2e]')).map(el => el.getAttribute('data-e2e'));

        return {
          hasAvatar: !!avatar,
          hasLoginButton: !!loginBtn,
          hasUserMenu: !!userMenu,
          isLoggedIn: (!!avatar || !!userMenu) && !loginBtn,
          dataE2EAttributes: allDataE2E
        };
      });

      console.log(`🔍 Login check: ${loginStatus.isLoggedIn ? 'LOGGED IN' : 'NOT LOGGED IN'}`);
      if (!loginStatus.isLoggedIn) {
        console.log(`🔍 Page elements: ${loginStatus.dataE2EAttributes.join(', ')}`);
      }
      return loginStatus.isLoggedIn;
    } catch (error) {
      console.log('⚠️  Could not check login status, assuming not logged in');
      return false;
    }
  }

  async performAuthentication() {
    // Start container (use existing if already running)
    await this.startAuthContainer();

    // Connect to browser
    await this.connectToBrowser();

    // Check if already logged in first
    const isLoggedIn = await this.checkIfLoggedIn();

    if (isLoggedIn) {
      console.log('✅ Already logged in, extracting session data...');
    } else {
      // Navigate to QR login
      await this.navigateToQRLogin();

      // Show QR code
      await this.showQRCode();

      // Wait for login
      await this.waitForLogin();
    }

    // Extract auth data (works for both cases)
    const authData = await this.extractAuthData();

    // Save to JSON file
    const filename = await this.saveAuthData(authData);
    console.log(`💾 Session saved to: ${filename}`);

    return authData;
  }

  async startAuthContainer() {
    console.log('📦 Starting authentication container...');

    try {
      let container;
      try {
        container = this.docker.getContainer(this.containerName);
        const info = await container.inspect();

        if (info.State.Status === 'running') {
          console.log('✅ Container already running');
          return;
        } else {
          console.log('🔄 Restarting existing container...');
          await container.start();
          await this.waitForContainer();
          return;
        }
      } catch (error) {
        // Container doesn't exist, will create it
      }

      // Start container using docker-compose
      const { spawn } = require('child_process');

      await new Promise((resolve, reject) => {
        const compose = spawn('docker', ['compose', 'up', '-d'], {
          cwd: __dirname,
          stdio: 'pipe'
        });

        let output = '';
        compose.stdout.on('data', (data) => {
          output += data.toString();
        });

        compose.stderr.on('data', (data) => {
          output += data.toString();
        });

        compose.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Container started successfully');
            resolve();
          } else {
            reject(new Error(`Docker compose failed: ${output}`));
          }
        });
      });

      await this.waitForContainer();

    } catch (error) {
      throw new Error(`Failed to start container: ${error.message}`);
    }
  }

  async isContainerRunning() {
    const { spawn } = require('child_process');

    return new Promise((resolve) => {
      const docker = spawn('docker', ['ps', '--filter', `name=${this.containerName}`, '--format', 'table {{.Names}}'], {
        stdio: 'pipe'
      });

      let output = '';
      docker.stdout.on('data', (data) => {
        output += data.toString();
      });

      docker.on('close', (code) => {
        const isRunning = output.includes(this.containerName);
        resolve(isRunning);
      });
    });
  }

  async stopAuthContainer() {
    console.log('🛑 Stopping authentication container...');

    try {
      const { spawn } = require('child_process');

      await new Promise((resolve, reject) => {
        const compose = spawn('docker', ['compose', 'down'], {
          cwd: __dirname,
          stdio: 'pipe'
        });

        let output = '';
        compose.stdout.on('data', (data) => {
          output += data.toString();
        });

        compose.stderr.on('data', (data) => {
          output += data.toString();
        });

        compose.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Container stopped successfully');
            resolve();
          } else {
            reject(new Error(`Docker compose down failed: ${output}`));
          }
        });
      });
    } catch (error) {
      console.warn('⚠️ Warning: Could not stop container:', error.message);
    }
  }

  async waitForContainer() {
    console.log('⏳ Waiting for container to be ready...');

    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const cdpUrl = `http://localhost:${this.cdpPort}`;
        const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 2000 });
        await browser.close();
        console.log('✅ Container is ready');
        return;
      } catch (error) {
        if (i === maxRetries - 1) {
          throw new Error('Container failed to become ready');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async connectToBrowser() {
    console.log('🔌 Connecting to browser...');

    const cdpUrl = `http://localhost:${this.cdpPort}`;
    const { browser, page } = await BrowserConnection.connectToBrowser(cdpUrl);

    this.browser = browser;
    this.page = page;

    this.page.setDefaultTimeout(60000);
    this.page.setDefaultNavigationTimeout(60000);

    console.log('✅ Connected to browser');
  }

  async navigateToQRLogin() {
    console.log('🌐 Navigating to TikTok QR login...');

    await this.page.goto('https://www.tiktok.com/login/qrcode', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await this.page.waitForTimeout(3000);
    console.log('✅ Navigated to QR login page');
  }

  async showQRCode() {
    console.log('📱 Extracting QR code...');

    const qrResult = await this.extractQRCodeFromPage();
    if (!qrResult || !qrResult.image) {
      throw new Error('Could not extract QR code from page');
    }

    const qrData = qrResult.image;
    await this.startQRServer(qrData);

    // Display QR code as ASCII art in terminal
    try {
      const { Jimp } = require('jimp');
      const jsQR = require('jsqr');
      const buffer = Buffer.from(qrData.split(',')[1], 'base64');
      const image = await Jimp.read(buffer);
      const imageData = {
        data: new Uint8ClampedArray(image.bitmap.data),
        width: image.bitmap.width,
        height: image.bitmap.height
      };
      const decoded = jsQR(imageData.data, imageData.width, imageData.height);

      if (decoded) {
        console.log('\n📱 Scan this QR code with TikTok mobile app:\n');
        const qrAscii = await QRCode.toString(decoded.data, { type: 'terminal', small: true });
        console.log(qrAscii);
      }
    } catch (e) {
      // Fallback if ASCII QR fails
      console.log('✅ QR Code ready!');
    }

    console.log(`\n🌐 Or scan via web: http://localhost:${this.qrServerPort}`);
    console.log(`👀 Watch browser: http://localhost:8080 (password: neko)`);
    console.log('⏳ Waiting for QR scan...');
  }

  async extractQRCodeFromPage() {
    return await QRExtractor.extractQRCodeFromPage(this.page);
  }

  async startQRServer(qrData) {
    return new Promise((resolve, reject) => {
      const app = express();

      app.get('/', (req, res) => {
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>TikTok QR Authentication</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            text-align: center;
            background: #f5f5f5;
        }
        .container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .qr-container {
            margin: 20px 0;
            padding: 20px;
            background: #fafafa;
            border-radius: 8px;
        }
        .qr-container img {
            max-width: 300px;
            height: auto;
        }
        .instructions {
            text-align: left;
            margin: 20px 0;
            padding: 15px;
            background: #e8f4f8;
            border-radius: 6px;
            border-left: 4px solid #2196F3;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 TikTok Authentication</h1>
        <p>Scan the QR code with your TikTok mobile app</p>

        <div class="qr-container">
            <img src="${qrData}" alt="TikTok QR Code">
        </div>

        <div class="instructions">
            <h3>Instructions:</h3>
            <ol>
                <li>Open TikTok app on your phone</li>
                <li>Go to Profile → Menu (≡) → Settings</li>
                <li>Tap "Account" → "Switch account" → "Log in"</li>
                <li>Choose "Use QR code"</li>
                <li>Scan the code above</li>
            </ol>
        </div>

        <p><small>Xordi Lite - Close this window after scanning</small></p>
    </div>
</body>
</html>`;
        res.send(html);
      });

      this.qrServer = app.listen(this.qrServerPort, () => {
        resolve();
      });

      this.qrServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          this.qrServerPort++;
          this.qrServer = app.listen(this.qrServerPort, () => {
            resolve();
          });
        } else {
          reject(error);
        }
      });
    });
  }

  async waitForLogin() {
    const timeout = 120000; // 2 minutes
    const startTime = Date.now();

    console.log('⏳ Waiting for login (timeout: 2 minutes)...');

    while (Date.now() - startTime < timeout) {
      try {
        const url = this.page.url();

        if (url.includes('/foryou') ||
            url.includes('/home') ||
            (url.includes('tiktok.com') && !url.includes('/login'))) {
          console.log('✅ Login successful - redirected to home page');
          return true;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        // Continue waiting
      }
    }

    throw new Error('Login timeout - QR code not scanned within 2 minutes');
  }

  async saveCurrentSession() {
    // Start container if not running
    await this.startAuthContainer();

    // Connect to browser
    await this.connectToBrowser();

    try {
      // Extract session data from current browser state
      const authData = await this.extractAuthData();

      // Save to JSON file
      const filename = await this.saveAuthData(authData);
      console.log(`💾 Session saved to: ${filename}`);

      return authData;
    } finally {
      // Clean up browser connection
      if (this.browser) {
        await this.browser.close();
        console.log('🔌 Browser connection closed');
      }
    }
  }

  async extractAuthData() {
    console.log('🔍 Extracting authentication data...');
    const authData = await BrowserAutomationClient.extractAuthData(this.page);
    console.log('✅ Authentication data extracted');
    console.log(`   User: @${authData.user?.username} (${authData.user?.sec_user_id})`);
    console.log(`   Cookies: ${authData.cookies?.length} items`);
    console.log(`   Tokens: ${Object.keys(authData.tokens || {}).length} items`);
    return authData;
  }


  async saveAuthData(authData) {
    await this.ensureOutputDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `tiktok-auth-${timestamp}.json`;
    const filepath = path.join(__dirname, 'output', filename);

    await fs.writeFile(filepath, JSON.stringify(authData, null, 2));

    return filepath;
  }

  async sampleTimeline() {
    const method = this.options.method || 'browser';
    const videoCount = this.options.count || 3;

    console.log('📱 Starting timeline sampling...');
    console.log(`🎯 Method: ${method.toUpperCase()}`);

    if (!this.sessionData) {
      if (!this.options.loggedout) {
        throw new Error('No session data available for sampling. Use --loggedout to scrape without authentication or authenticate first.');
      }
      console.log(`📊 Sampling ${videoCount} videos (not authenticated - limited content)`);
    } else {
      console.log(`📊 Sampling ${videoCount} videos for @${this.sessionData.user?.username || 'authenticated user'}`);
    }

    // Method validation
    if (method === 'browser' && this.options.cursor !== undefined) {
      throw new Error('Browser method does not support cursor pagination (use --method=api for cursor support)');
    }
    if (method === 'web' && this.options.cursor !== undefined) {
      throw new Error('Web method does not support cursor pagination (use --method=api for cursor support)');
    }

    let result;

    if (method === 'api') {
      result = await this.sampleViaAPI(videoCount);
    } else if (method === 'browser') {
      result = await this.sampleViaBrowser(videoCount);
    } else if (method === 'web') {
      result = await this.sampleViaWeb(videoCount);
    } else {
      throw new Error(`Unknown sampling method: ${method}`);
    }

    // Save sampled data
    await this.saveSampledData(result.videos, result);

    return result;
  }

  async sampleViaAPI(videoCount) {
    console.log('🚀 Using Direct API method...');

    // Load proprietary mobile auth module
    let mobileAuth;
    try {
      mobileAuth = require('./proprietary-modules/mobile-auth.js');
    } catch (error) {
      throw new Error('Mobile API requires proprietary modules. Place mobile-auth.js in proprietary-modules/ directory.');
    }

    const DirectAPIClient = require('./dist/lib/mobile-api-client');
    const apiClient = new DirectAPIClient(this.sessionData, mobileAuth);

    try {
      const result = await apiClient.sampleTimeline(videoCount, this.options.cursor);

      if (!result.success || !result.videos) {
        throw new Error('Direct API sampling failed - no videos returned');
      }

      console.log(`✅ Direct API completed successfully!`);
      console.log(`   Speed: ${result.videosPerMinute} videos/minute`);
      console.log(`   API Requests: ${result.totalRequests}`);

      if (result.hasMore) {
        console.log(`\n📄 Pagination: Use --cursor=${result.maxCursor} to get next batch`);
      }

      return result;

    } catch (error) {
      console.error('❌ Direct API sampling failed:', error.message);

      if (this.options.debug) {
        console.error('Session user:', this.sessionData.user);
        console.error('Cookie count:', this.sessionData.cookies?.length);
        console.error('Available tokens:', Object.keys(this.sessionData.tokens || {}));
      }

      throw error;
    }
  }

  async sampleViaBrowser(videoCount) {
    console.log('🎭 Using Browser Automation method...');
    if (this.options.dev) {
      console.log('🔧 Development mode enabled - container will be reused for faster iterations');
    }

    const BrowserAutomationClient = require('./dist/lib/browser-automation-client');
    // Use localhost for CDP connection (works on both Linux and macOS)
    const cdpUrl = `http://localhost:9223`;

    const browserClient = new BrowserAutomationClient(this.sessionData, {
      ...this.options,
      reuseContainer: this.options.dev,
      cdpUrl: cdpUrl
    });

    try {
      await browserClient.initialize();
      const videos = await browserClient.sampleForYouFeed(videoCount);
      const result = {
        videos,
        success: true,
        method: 'browser_automation'
      };

      if (!result.videos || result.videos.length === 0) {
        throw new Error('Browser automation sampling failed - no videos returned');
      }

      console.log(`✅ Browser automation completed successfully!`);
      console.log(`   Speed: ${result.videosPerMinute} videos/minute`);
      console.log(`   Browser Navigation: ${result.videos.length} videos processed`);

      console.log(`\n📄 Pagination: Browser method supports continuous scrolling (run again to continue)`);

      // Cleanup browser resources
      await browserClient.cleanup();

      return result;

    } catch (error) {
      console.error('❌ Browser automation sampling failed:', error.message);

      if (this.options.debug) {
        console.error('Session user:', this.sessionData.user);
        console.error('Cookie count:', this.sessionData.cookies?.length);
      }

      // Ensure cleanup even on error
      try {
        await browserClient.cleanup();
      } catch (cleanupError) {
        console.warn('⚠️ Cleanup warning:', cleanupError.message);
      }

      throw error;
    }
  }

  async sampleViaWeb(videoCount) {
    console.log('🌐 Using Web API method...');

    // Load proprietary web auth module
    let webAuth;
    try {
      webAuth = require('./proprietary-modules/web-auth.js');
    } catch (error) {
      throw new Error('Web API requires proprietary modules. Place web-auth.js in proprietary-modules/ directory.');
    }

    const webClient = new WebApiClient(this.sessionData, webAuth, this.options);

    try {
      const result = await webClient.getRecommendedFeed(videoCount);

      if (!result.success || !result.videos) {
        throw new Error('Web API sampling failed - no videos returned');
      }

      console.log(`✅ Web API completed successfully!`);
      console.log(`   Videos: ${result.videos.length}/${videoCount} requested`);

      console.log(`\n📄 Pagination: Web method supports cursor-based pagination (feature coming soon)`);

      // Format result to match expected structure
      const formattedResult = {
        success: true,
        videos: result.videos,
        hasMore: result.hasMore,
        cursor: result.cursor,
        method: 'web_api',
        statusCode: result.statusCode
      };

      return formattedResult;

    } catch (error) {
      console.error('❌ Web API sampling failed:', error.message);

      if (this.options.debug) {
        console.error('Session user:', this.sessionData.user);
        console.error('Cookie count:', this.sessionData.cookies?.length);
      }

      throw error;
    }
  }

  async saveSampledData(videos, apiResult = null) {
    await this.ensureOutputDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `timeline-${timestamp}.txt`;
    const filepath = path.join(__dirname, 'output', filename);

    let content = `TikTok Timeline Sample Results\n`;
    content += `Sampled at: ${new Date().toISOString()}\n`;
    content += `User: ${this.sessionData ? `@${this.sessionData.user.username} (${this.sessionData.user.sec_user_id})` : 'Not authenticated (--loggedout)'}\n`;
    content += `Total videos: ${videos.length}\n`;

    if (apiResult) {
      content += `API Speed: ${apiResult.videosPerMinute || 'N/A'} videos/minute\n`;
      content += `API Requests: ${apiResult.totalRequests || 'N/A'}\n`;
      content += `Execution time: ${apiResult.executionTime || 'N/A'}ms\n`;
      content += `Has more: ${apiResult.hasMore ? 'Yes' : 'No'}\n`;
      if (apiResult.hasMore) {
        content += `Next cursor: ${apiResult.maxCursor || apiResult.cursor || 'N/A'}\n`;
      }
    }

    content += '='.repeat(50) + '\n\n';

    videos.forEach((video, index) => {
      content += `${index + 1}. ${video.desc || 'No description'}\n`;
      content += `   ID: ${video.id}\n`;
      content += `   Author: @${video.author} (${video.authorDetails?.nickname || 'Unknown'})\n`;
      content += `   Stats: ${(video.likes || 0).toLocaleString()} likes, ${(video.views || 0).toLocaleString()} views, ${(video.comments || 0).toLocaleString()} comments\n`;
      content += `   Duration: ${video.video?.duration ? Math.floor(video.video.duration / 1000) + 's' : 'Unknown'}\n`;

      if (video.music?.title) {
        content += `   Music: "${video.music.title}" by ${video.music.author}\n`;
      }

      if (video.challenges?.length > 0) {
        const hashtags = video.challenges.map(c => `#${c.title}`).join(' ');
        content += `   Hashtags: ${hashtags}\n`;
      }

      content += `   URL: ${video.webUrl}\n`;
      if (video.createTime) {
        try {
          content += `   Created: ${new Date(video.createTime * 1000).toISOString()}\n`;
        } catch (error) {
          content += `   Created: Unknown\n`;
        }
      } else {
        content += `   Created: Unknown\n`;
      }
      content += `   Sampled: ${video.sampled_at || new Date().toISOString()}\n\n`;
    });

    await fs.writeFile(filepath, content);

    // Also save JSON version for programmatic use
    const jsonFilename = `timeline-${timestamp}.json`;
    const jsonFilepath = path.join(__dirname, 'output', jsonFilename);

    const jsonData = {
      sampled_at: new Date().toISOString(),
      user: this.sessionData ? this.sessionData.user : null,
      authenticated: !!this.sessionData,
      total_videos: videos.length,
      api_stats: apiResult || {},
      videos: videos
    };

    await fs.writeFile(jsonFilepath, JSON.stringify(jsonData, null, 2));

    console.log(`\n📁 Output Files Saved:`);
    console.log(`   📄 Human-readable: ${filepath}`);
    console.log(`   📊 JSON data: ${jsonFilepath}`);
    console.log(`\n📋 Summary:`);
    videos.forEach((video, index) => {
      const author = video.author || 'Unknown';
      const desc = video.desc || video.description || 'No description';
      const shortDesc = desc.length > 60 ? desc.substring(0, 60) + '...' : desc;
      const videoUrl = video.webUrl || video.url || 'No URL';
      console.log(`   ${index + 1}. @${author}: "${shortDesc}"`);
      console.log(`      🔗 ${videoUrl}`);
    });
  }

  async ensureOutputDir() {
    const outputDir = path.join(__dirname, 'output');
    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
      // Directory already exists
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up...');

    if (this.qrServer) {
      this.qrServer.close();
    }

    if (this.browser) {
      await this.browser.close();
    }

    // Only stop container if not in development mode AND we started it
    const shouldStopContainer = !this.options.dev && !this.containerWasAlreadyRunning;

    if (shouldStopContainer) {
      try {
        const { spawn } = require('child_process');

        await new Promise((resolve) => {
          const compose = spawn('docker', ['compose', 'down'], {
            cwd: __dirname,
            stdio: 'pipe'
          });

          compose.on('close', () => {
            console.log('✅ Container stopped');
            resolve();
          });
        });
      } catch (error) {
        console.warn('Container cleanup warning:', error.message);
      }
    } else {
      if (this.options.dev) {
        console.log('♻️  Container left running (--keep mode)');
      } else if (this.containerWasAlreadyRunning) {
        console.log('♻️  Container left running (was already running when we started)');
      }
    }
  }
}

async function runDevCommand(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('node', [cmd, ...args], {
      stdio: 'inherit',
      cwd: __dirname
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
  });
}

async function runDockerCommand(args = []) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('docker', args, {
      stdio: 'inherit',
      cwd: __dirname
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker command failed with code ${code}`));
      }
    });
  });
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName('tokscope')
    .usage('Usage: $0 [count] [options] or $0 <command> (dev mode only)')
    .command('$0 [count]', 'Sample TikTok timeline (default)', (yargs) => {
      yargs.positional('count', {
        describe: 'Number of videos to scrape',
        type: 'number',
        default: 3
      });
    })
    .command('start', 'Start container and keep running', {}, async () => {
      console.log('🚀 Starting development environment...');
      console.log('📦 Starting container (will stay running for quick iterations)...');
      await runDockerCommand(['compose', 'up', '-d']);
      console.log('✅ Development environment ready!');
      console.log('🌐 Debug view: http://localhost:8080');
      console.log('💡 Run "node scrape.js 5 --keep" to test sampling');
      console.log('💡 Run "node scrape.js stop" when done developing');
    })
    .command('stop', 'Stop container', {}, async () => {
      console.log('🛑 Stopping development environment...');
      await runDockerCommand(['compose', 'down']);
      console.log('✅ Development environment stopped');
    })
    .command('status', 'Check container status', {}, async () => {
      console.log('📊 Checking development environment status...');
      try {
        await runDockerCommand(['ps', '--filter', 'name=simple-auth-container', '--format', 'table {{.Names}}\\t{{.Status}}']);
      } catch (error) {
        console.log('❌ Container not running');
      }
    })
    .command('health', 'Check authentication status and session health', {}, async () => {
      console.log('🏥 Checking authentication health...');
      const sampler = new XordiDevTool();
      await sampler.checkHealth();
    })
    .command('auth', 'Authenticate with TikTok (saves session, restarts container)', {}, async () => {
      console.log('🔐 Authentication mode...');
      const sampler = new XordiDevTool({ auth: true });
      try {
        await sampler.getSessionData();
        console.log('✅ Authentication completed. Session saved.');
        console.log('💡 Run "node tokscope.js" to start sampling');
      } finally {
        await sampler.cleanup();
      }
    })
    .command('save-session', 'Save current browser session without authentication flow', {}, async () => {
      console.log('💾 Saving current browser session...');
      const sampler = new XordiDevTool();
      await sampler.saveCurrentSession();
      console.log('✅ Session saved successfully');
    })
    .command('inspect', 'Show current DOM structure and TikTok elements', {}, async () => {
      console.log('🔍 Inspecting current page DOM...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'inspect-dom.js'), process.argv.slice(3));
    })
    .command('screenshot', 'Take screenshot of current browser state', {}, async () => {
      console.log('📸 Taking screenshot...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'screenshot.js'), process.argv.slice(3));
    })
    .command('test [selectors..]', 'Test CSS selectors against current page', {}, async () => {
      console.log('🧪 Testing selectors...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'test-selectors.js'), process.argv.slice(3));
    })
    .command('extract', 'Test data extraction on current page', {}, async () => {
      console.log('🔬 Testing data extraction...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'extract-data.js'), process.argv.slice(3));
    })
    .command('simulate <action>', 'Simulate user actions (click, scroll, navigate)', {}, async () => {
      console.log('🎮 Simulating user actions...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'simulate-actions.js'), process.argv.slice(3));
    })
    .command('record [name]', 'Record browser session and generate Playwright code', {}, async () => {
      console.log('🎬 Starting session recorder...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'record-session.js'), process.argv.slice(3));
    })
    .command('navigate [destination]', 'Navigate to specific TikTok page (foryou, profile, etc)', {}, async () => {
      console.log('🌐 Navigating to page...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'navigate.js'), process.argv.slice(3));
    })
    .command('cpu-monitor', 'Monitor CPU usage of container processes', {}, async () => {
      console.log('📊 Starting CPU monitoring...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'cpu-monitor.js'), process.argv.slice(3));
    })
    .command('neko-control [action]', 'Control neko broadcast service (start/stop/status)', {}, async () => {
      console.log('🎭 Controlling neko service...');
      await runDevCommand(path.join(__dirname, 'workbench-tools', 'neko-control.js'), process.argv.slice(3));
    })
    .command('cpu-benchmark', 'Run comprehensive CPU usage benchmark', {}, async () => {
      console.log('🏁 Starting CPU benchmark suite...');
      await runDevCommand(path.join(__dirname, 'cpu-benchmark.js'), process.argv.slice(3));
    })
    .command('like <videoId>', 'Like a TikTok video by ID', (yargs) => {
      yargs.positional('videoId', {
        describe: 'TikTok video ID (19 digits)',
        type: 'string'
      });
    }, async (argv) => {
      console.log('💖 Liking TikTok video...');
      await runDevCommand(path.join(__dirname, 'like-video.js'), [argv.videoId, ...(argv.session ? ['--session', argv.session] : []), ...(argv.debug ? ['--debug'] : [])]);
    })
    .option('session', {
      alias: 's',
      type: 'string',
      describe: 'Use specific session JSON file (otherwise auto-detects recent)'
    })
    .option('cursor', {
      type: 'number',
      describe: 'Start from specific cursor for pagination'
    })
    .option('auth', {
      type: 'boolean',
      describe: 'Authenticate (saves session, restarts container)',
      default: false
    })
    .option('loggedout', {
      type: 'boolean',
      describe: 'Allow sampling without authentication (limited content)',
      default: false
    })
    .option('method', {
      type: 'string',
      describe: 'Sampling method',
      choices: ['api', 'browser', 'web'],
      default: 'browser'
    })
    .option('keep', {
      type: 'boolean',
      describe: 'Keep container running after sampling (replaces --dev)',
      default: false
    })
    .option('debug', {
      type: 'boolean',
      describe: 'Show debug information',
      default: false
    })
    .help()
    .alias('help', 'h')
    .example('$0', 'Sample 3 videos via browser (default)')
    .example('$0 50', 'Sample 50 videos via browser')
    .example('$0 5 --method=api --keep', 'Sample 5 videos via mobile API, keep container running')
    .example('$0 10 --method=web', 'Sample 10 videos via web API')
    .example('$0 --auth', 'Authenticate only (save session)')
    .example('$0 health', 'Check authentication status')
    .example('$0 10 --loggedout', 'Sample without authentication')
    .example('$0 start', 'Start container for development')
    .example('$0 inspect', 'Show current page DOM structure')
    .example('$0 screenshot', 'Take browser screenshot')
    .example('$0 test video', 'Test video element selectors')
    .example('$0 navigate foryou', 'Navigate to For You page')
    .example('$0 cpu-monitor --duration 20', 'Monitor CPU usage for 20 seconds')
    .example('$0 neko-control stop', 'Stop neko broadcast service')
    .example('$0 cpu-benchmark', 'Run comprehensive CPU benchmark')
    .example('$0 stop', 'Stop development container')
    .argv;

  // Debug: Check what command was executed
  const originalCommand = process.argv[2];
  const devCommands = ['start', 'stop', 'status', 'health', 'auth', 'save-session', 'inspect', 'screenshot', 'test', 'extract', 'simulate', 'record', 'navigate', 'cpu-monitor', 'neko-control', 'cpu-benchmark'];

  if (devCommands.includes(originalCommand)) {
    // This was a dev command, already handled by yargs command handlers
    return;
  }

  // Handle --auth flag - always stops after authentication, ignores other commands
  if (argv.auth) {
    console.log('🔐 Authentication only mode...');
    const sampler = new XordiDevTool(argv);
    try {
      await sampler.getSessionData();
      console.log('✅ Authentication completed. Session saved.');
      console.log('💡 Run "node tokscope.js" to start sampling');
    } finally {
      await sampler.cleanup();
    }
    process.exit(0);
  }

  // Handle main sampling functionality
  // Replace --keep with --dev for internal compatibility
  if (argv.keep) {
    argv.dev = true;
  }

  const sampler = new XordiDevTool(argv);
  await sampler.run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// This file is designed to be run directly, not imported
