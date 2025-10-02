#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

async function interceptWatchHistory() {
  console.log('🚀 Starting Watch History Network Interceptor...');

  // Load session from dashboard sessions file
  const sessionPath = path.join(__dirname, '..', 'examples', 'dashboard-sessions.json');
  const sessionsData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
  const sessionId = Object.keys(sessionsData.sessions)[0];
  const sessionData = sessionsData.sessions[sessionId].sessionData;
  console.log(`👤 Using session: @${sessionData.user.username}`);

  // Connect to dev browser
  const browser = await chromium.connectOverCDP('http://17.100.0.3:9222', {
    timeout: 10000
  });

  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  console.log('🔌 Connected to dev browser');

  // Load cookies
  if (sessionData.cookies) {
    await context.addCookies(sessionData.cookies);
    console.log(`🍪 Loaded ${sessionData.cookies.length} cookies`);
  }

  // Set up network interception
  const apiRequests = [];
  const capturedData = [];

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('history') || url.includes('/api/')) {
      const requestData = {
        method: request.method(),
        url: url,
        headers: request.headers(),
        timestamp: new Date().toISOString()
      };
      console.log(`📡 Request: ${request.method()} ${url}`);
      apiRequests.push(requestData);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const request = response.request();

    if (url.includes('history') || (url.includes('/api/') && url.includes('tiktok'))) {
      try {
        const contentType = response.headers()['content-type'] || '';
        let body = null;

        if (contentType.includes('json')) {
          body = await response.json();
        }

        const captured = {
          request: {
            method: request.method(),
            url: url,
            headers: request.headers(),
            timestamp: new Date().toISOString()
          },
          response: {
            status: response.status(),
            statusText: response.statusText(),
            headers: response.headers(),
            body: body
          }
        };

        capturedData.push(captured);

        console.log(`✅ Response: ${url}`);
        console.log(`   Status: ${response.status()}`);

        if (body && typeof body === 'object') {
          const keys = Object.keys(body);
          console.log(`   Keys: ${keys.slice(0, 10).join(', ')}`);

          if (url.includes('history') || keys.some(k => k.includes('history') || k.includes('watch'))) {
            console.log(`   🎯 WATCH HISTORY ENDPOINT DETECTED!`);
            console.log(`   status_code: ${body.status_code}`);
            console.log(`   itemList length: ${body.itemList?.length || 0}`);

            // Save detailed capture
            const filename = `/tmp/watch-history-capture-${Date.now()}.json`;
            await fs.writeFile(filename, JSON.stringify(captured, null, 2));
            console.log(`   💾 Full request/response saved to: ${filename}`);
          }
        }
      } catch (error) {
        console.log(`   ⚠️  Could not parse response: ${error.message}`);
      }
    }
  });

  // Navigate to watch history
  console.log('🌐 Navigating to Watch History page...');
  await page.goto('https://www.tiktok.com/tpp/watch-history', {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  });

  console.log(`📍 Current URL: ${page.url()}`);

  console.log('⏳ Waiting for page to load...');
  await page.waitForTimeout(5000);

  // Scroll to trigger API calls
  console.log('📜 Scrolling to trigger API requests...');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(3000);
    console.log(`   Scroll ${i + 1}/3 completed`);
  }

  await page.waitForTimeout(2000);

  // Report findings
  console.log('\n📊 Analysis Results:');
  console.log('='.repeat(50));
  console.log(`Total API requests: ${apiRequests.length}`);

  const historyEndpoints = apiRequests.filter(r =>
    r.url.includes('history') || r.url.includes('watch')
  );

  if (historyEndpoints.length > 0) {
    console.log(`\n🎯 Found ${historyEndpoints.length} potential watch history endpoints:`);
    historyEndpoints.forEach(req => {
      console.log(`   ${req.method} ${req.url}`);
    });
  }

  await browser.close();
}

interceptWatchHistory().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});