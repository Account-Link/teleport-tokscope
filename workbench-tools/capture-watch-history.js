#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

async function captureWatchHistory() {
  console.log('🚀 Starting Watch History Capture...');

  const sessionPath = path.join(__dirname, '..', 'examples', 'dashboard-sessions.json');
  const sessionsData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
  const sessionId = Object.keys(sessionsData.sessions)[0];
  const sessionData = sessionsData.sessions[sessionId].sessionData;
  console.log(`👤 Using session: @${sessionData.user.username}`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: sessionData.metadata.user_agent
  });

  if (sessionData.cookies) {
    await context.addCookies(sessionData.cookies);
    console.log(`🍪 Loaded ${sessionData.cookies.length} cookies`);
  }

  const page = await context.newPage();

  const capturedData = [];

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('history') || url.includes('/aweme/')) {
      console.log(`📡 Request: ${request.method()} ${url.substring(0, 100)}...`);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const request = response.request();

    if (url.includes('history') || (url.includes('/aweme/') && url.includes('tiktok'))) {
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

        console.log(`✅ Response: ${url.substring(0, 100)}...`);
        console.log(`   Status: ${response.status()}`);

        if (body && typeof body === 'object') {
          const keys = Object.keys(body);
          console.log(`   Keys: ${keys.slice(0, 10).join(', ')}`);

          if (url.includes('history') || keys.some(k => k.includes('history') || k.includes('watch'))) {
            console.log(`   🎯 WATCH HISTORY ENDPOINT DETECTED!`);
            console.log(`   status_code: ${body.status_code}`);
            console.log(`   itemList length: ${body.itemList?.length || body.aweme_list?.length || 0}`);

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

  console.log('🌐 Navigating to Watch History page...');
  await page.goto('https://www.tiktok.com/tpp/watch-history', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  console.log(`📍 Current URL: ${page.url()}`);
  console.log('⏳ Waiting 3 seconds for page to load...');
  await page.waitForTimeout(3000);

  console.log('📜 Scrolling to trigger API requests...');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(2000);
    console.log(`   Scroll ${i + 1}/3 completed`);
  }

  await page.waitForTimeout(2000);

  console.log('\n📊 Analysis Results:');
  console.log('='.repeat(50));
  console.log(`Total captured requests: ${capturedData.length}`);

  if (capturedData.length > 0) {
    console.log(`\n🎯 Captured ${capturedData.length} watch history endpoints`);
    console.log('\nPress Enter to close browser and exit...');
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
  } else {
    console.log('\n⚠️  No watch history API calls detected!');
    await page.waitForTimeout(5000);
  }

  await browser.close();
}

captureWatchHistory().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
