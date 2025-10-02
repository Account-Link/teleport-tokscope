#!/usr/bin/env node

/**
 * Session Recorder for TikTok Development
 *
 * Records browser sessions and generates Playwright code
 * Useful for understanding user flows and creating new automation scripts
 */

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

class SessionRecorder {
  constructor() {
    this.events = [];
    this.startTime = Date.now();
    this.isRecording = false;
  }

  async startRecording(sessionName = 'session') {
    try {
      console.log('🎬 Starting session recorder...');

    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
      const browser = await chromium.connectOverCDP('http://localhost:9223', { timeout: 5000 });
      const contexts = browser.contexts();
      const pages = contexts[0]?.pages();
      const page = pages?.[0];

      if (!page) {
        console.log('❌ No active page found. Make sure development environment is running.');
        return;
      }

      this.sessionName = sessionName;
      this.isRecording = true;
      this.startTime = Date.now();
      this.events = [];

      console.log(`📹 Recording session "${sessionName}" on: ${page.url()}`);
      console.log('🎯 Interact with the browser now. Press Ctrl+C when done.\n');

      // Record initial state
      this.addEvent('page-load', {
        url: page.url(),
        title: await page.title(),
        timestamp: 0
      });

      // Set up event listeners
      this.setupEventListeners(page);

      // Keep the recorder running
      const recordingPromise = new Promise((resolve) => {
        // Handle Ctrl+C gracefully
        process.on('SIGINT', async () => {
          console.log('\n🛑 Stopping recording...');
          this.isRecording = false;

          // Generate final report
          await this.generateReport();
          await this.generatePlaywrightCode();

          await browser.close();
          resolve();
        });
      });

      await recordingPromise;

    } catch (error) {
      if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
        console.error('❌ Cannot connect to browser. Make sure development environment is running:');
        console.error('   ./dev-sample.js start');
      } else {
        console.error('❌ Recording failed:', error.message);
      }
    }
  }

  setupEventListeners(page) {
    // Navigation events
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.addEvent('navigation', {
          url: frame.url(),
          timestamp: this.getTimestamp()
        });
        console.log(`🌐 Navigated to: ${frame.url()}`);
      }
    });

    // Console logs (useful for debugging)
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        this.addEvent('console-error', {
          text: msg.text(),
          timestamp: this.getTimestamp()
        });
      }
    });

    // Network requests (for API calls)
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('tiktok') && (url.includes('api') || url.includes('feed'))) {
        this.addEvent('api-call', {
          url: url,
          status: response.status(),
          method: response.request().method(),
          timestamp: this.getTimestamp()
        });
        console.log(`🌐 API Call: ${response.request().method()} ${url} (${response.status()})`);
      }
    });

    // Monitor DOM changes for video loading
    page.evaluate(() => {
      // Monitor for new videos loading
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) { // Element node
                if (node.tagName === 'VIDEO' ||
                    node.querySelector?.('video') ||
                    node.getAttribute?.('data-e2e')?.includes('video')) {
                  console.log('📹 New video element detected');
                }
              }
            });
          }
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    });

    // Periodic state capture
    const captureInterval = setInterval(async () => {
      if (!this.isRecording) {
        clearInterval(captureInterval);
        return;
      }

      try {
        const state = await page.evaluate(() => {
          const currentVideo = document.querySelector('video');
          const videoData = currentVideo ? {
            currentTime: currentVideo.currentTime,
            duration: currentVideo.duration,
            paused: currentVideo.paused,
            src: currentVideo.src || currentVideo.currentSrc || 'no src'
          } : null;

          return {
            url: window.location.href,
            scrollPosition: window.scrollY,
            videoCount: document.querySelectorAll('video').length,
            currentVideo: videoData,
            visibleElements: {
              likeButtons: document.querySelectorAll('[data-e2e*="like"]').length,
              commentButtons: document.querySelectorAll('[data-e2e*="comment"]').length,
              videos: document.querySelectorAll('video').length
            }
          };
        });

        this.addEvent('state-capture', {
          ...state,
          timestamp: this.getTimestamp()
        });

      } catch (error) {
        // Page might be navigating, ignore errors
      }
    }, 3000); // Capture state every 3 seconds
  }

  addEvent(type, data) {
    this.events.push({
      type,
      data,
      timestamp: data.timestamp || this.getTimestamp()
    });
  }

  getTimestamp() {
    return Date.now() - this.startTime;
  }

  async generateReport() {
    const outputDir = path.join(__dirname, '..', 'output', 'recordings');
    await fs.mkdir(outputDir, { recursive: true });

    const reportPath = path.join(outputDir, `${this.sessionName}-report.json`);

    const report = {
      sessionName: this.sessionName,
      startTime: new Date(this.startTime).toISOString(),
      duration: Date.now() - this.startTime,
      totalEvents: this.events.length,
      events: this.events,
      summary: this.generateSummary()
    };

    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`📊 Session report saved: ${reportPath}`);

    return report;
  }

  generateSummary() {
    const summary = {
      navigations: this.events.filter(e => e.type === 'navigation').length,
      apiCalls: this.events.filter(e => e.type === 'api-call').length,
      errors: this.events.filter(e => e.type === 'console-error').length,
      stateCaptures: this.events.filter(e => e.type === 'state-capture').length,
      pagesVisited: [...new Set(this.events
        .filter(e => e.type === 'navigation')
        .map(e => e.data.url)
      )],
      apiEndpoints: [...new Set(this.events
        .filter(e => e.type === 'api-call')
        .map(e => e.data.url)
      )]
    };

    console.log('\n📈 Session Summary:');
    console.log(`   Duration: ${Math.round((Date.now() - this.startTime) / 1000)}s`);
    console.log(`   Navigations: ${summary.navigations}`);
    console.log(`   API Calls: ${summary.apiCalls}`);
    console.log(`   Pages visited: ${summary.pagesVisited.length}`);

    return summary;
  }

  async generatePlaywrightCode() {
    const codeLines = [
      '// Generated Playwright code from recorded session',
      `// Session: ${this.sessionName}`,
      `// Recorded: ${new Date(this.startTime).toISOString()}`,
      '',
      'const { chromium } = require(\'playwright\');',
      '',
      'async function replaySession() {',
      '  const browser = await chromium.launch({ headless: false });',
      '  const context = await browser.newContext();',
      '  const page = await context.newPage();',
      ''
    ];

    let lastUrl = null;
    const navigations = this.events.filter(e => e.type === 'navigation');

    for (const nav of navigations) {
      if (nav.data.url !== lastUrl) {
        codeLines.push(`  // Navigate to ${nav.data.url}`);
        codeLines.push(`  await page.goto('${nav.data.url}', { waitUntil: 'networkidle' });`);
        codeLines.push(`  await page.waitForTimeout(2000);`);
        codeLines.push('');
        lastUrl = nav.data.url;
      }
    }

    // Add common actions based on URLs visited
    const summary = this.generateSummary();
    if (summary.pagesVisited.some(url => url.includes('foryou'))) {
      codeLines.push('  // Click on first video');
      codeLines.push('  const firstVideo = page.locator(\'[data-e2e="recommend-list-item-container"] a\').first();');
      codeLines.push('  if (await firstVideo.isVisible()) {');
      codeLines.push('    await firstVideo.click();');
      codeLines.push('    await page.waitForTimeout(3000);');
      codeLines.push('  }');
      codeLines.push('');
    }

    if (summary.pagesVisited.some(url => url.includes('video'))) {
      codeLines.push('  // Navigate through videos');
      codeLines.push('  for (let i = 0; i < 3; i++) {');
      codeLines.push('    await page.keyboard.press(\'ArrowDown\');');
      codeLines.push('    await page.waitForTimeout(2000);');
      codeLines.push('  }');
      codeLines.push('');
    }

    codeLines.push('  await browser.close();');
    codeLines.push('}');
    codeLines.push('');
    codeLines.push('replaySession().catch(console.error);');

    const outputDir = path.join(__dirname, '..', 'output', 'recordings');
    const codePath = path.join(outputDir, `${this.sessionName}-replay.js`);

    await fs.writeFile(codePath, codeLines.join('\n'));
    console.log(`🎬 Playwright code generated: ${codePath}`);

    return codeLines.join('\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sessionName = args[0] || `session-${Date.now()}`;

  if (args.includes('--help') || args.includes('-h')) {
    console.log('🎬 Session Recorder');
    console.log('Usage: node record-session.js [session-name]');
    console.log('');
    console.log('Records browser interactions and generates:');
    console.log('  - Detailed event log (JSON)');
    console.log('  - Playwright replay script');
    console.log('  - Session summary');
    console.log('');
    console.log('Use Ctrl+C to stop recording and generate reports.');
    console.log('');
    console.log('Examples:');
    console.log('  node record-session.js my-test     # Record session named "my-test"');
    console.log('  node record-session.js            # Auto-generate session name');
    return;
  }

  const recorder = new SessionRecorder();
  await recorder.startRecording(sessionName);
}

if (require.main === module) {
  main();
}

module.exports = { SessionRecorder };