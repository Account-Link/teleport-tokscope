#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

class TikTokNetworkInterceptor {
  constructor() {
    this.requests = [];
    this.responses = [];
    this.apiRequests = [];
  }

  async findLatestSession() {
    try {
      const outputDir = path.join(__dirname, '..', 'output');
      const files = await fs.readdir(outputDir);

      const authFiles = files
        .filter(f => f.startsWith('tiktok-auth-') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(outputDir, f),
          time: fs.stat(path.join(outputDir, f)).then(stats => stats.mtime)
        }));

      if (authFiles.length === 0) {
        return null;
      }

      const filesWithTimes = await Promise.all(authFiles.map(async f => ({
        ...f,
        time: await f.time
      })));

      filesWithTimes.sort((a, b) => b.time - a.time);
      return filesWithTimes[0].path;
    } catch (error) {
      return null;
    }
  }

  async loadSession(sessionPath) {
    try {
      const content = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to load session: ${error.message}`);
    }
  }

  isApiRequest(url) {
    // Check for TikTok API patterns
    return url.includes('/api/') ||
           url.includes('/node/') ||
           url.includes('/share/') ||
           url.includes('/aweme/') ||
           url.includes('/feed/') ||
           url.includes('/recommend/') ||
           url.includes('.tiktok.com/api') ||
           url.includes('tiktokv.com') ||
           url.includes('musical.ly');
  }

  extractApiInfo(request, response = null) {
    const url = new URL(request.url());
    const method = request.method();
    const headers = request.headers();
    const postData = request.postData();

    // Extract query parameters
    const queryParams = {};
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    const info = {
      timestamp: new Date().toISOString(),
      method,
      url: request.url(),
      baseUrl: `${url.protocol}//${url.host}${url.pathname}`,
      queryParams,
      headers: this.filterHeaders(headers),
      postData: postData ? this.tryParseJson(postData) : null,
      response: null
    };

    if (response) {
      info.response = {
        status: response.status(),
        headers: this.filterHeaders(response.headers()),
        // We'll get the body separately to avoid blocking
      };
    }

    return info;
  }

  filterHeaders(headers) {
    // Keep only relevant headers, exclude sensitive ones
    const relevantHeaders = {};
    const keepHeaders = [
      'content-type',
      'accept',
      'user-agent',
      'referer',
      'x-requested-with',
      'x-tt-logid',
      'x-secsdk-csrf-token',
      'x-bd-kmsv',
      'x-tt-csrf-token'
    ];

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (keepHeaders.some(h => lowerKey.includes(h)) || lowerKey.startsWith('x-tt')) {
        relevantHeaders[key] = value;
      }
    }

    return relevantHeaders;
  }

  tryParseJson(data) {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  categorizeEndpoint(url) {
    if (url.includes('/recommend/')) return 'feed-recommendation';
    if (url.includes('/feed/')) return 'feed-data';
    if (url.includes('/aweme/')) return 'video-data';
    if (url.includes('/user/')) return 'user-data';
    if (url.includes('/share/')) return 'sharing';
    if (url.includes('/api/post/')) return 'interactions';
    if (url.includes('/api/commit/')) return 'actions';
    if (url.includes('/node/')) return 'node-api';
    return 'other';
  }

  async startInterception() {
    console.log('🚀 Starting TikTok Network Interceptor...');

    // Load session
    console.log('📄 Finding latest session...');
    const sessionPath = await this.findLatestSession();
    if (!sessionPath) {
      throw new Error('No session files found. Please authenticate first.');
    }

    console.log(`📄 Loading session: ${path.basename(sessionPath)}`);
    const sessionData = await this.loadSession(sessionPath);
    console.log(`👤 Authenticated as: @${sessionData.user.username}`);

    // Connect to existing browser
    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const browser = await chromium.connectOverCDP('http://localhost:9223', {
      timeout: 10000
    });

    // Use existing context and page instead of creating new ones
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();

    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    console.log(`🔌 Connected to existing browser session`);

    // Set up network interception
    console.log('🕸️ Setting up network interception...');

    page.on('request', (request) => {
      if (this.isApiRequest(request.url())) {
        const apiInfo = this.extractApiInfo(request);
        apiInfo.category = this.categorizeEndpoint(request.url());
        this.apiRequests.push(apiInfo);

        console.log(`📡 API Request: ${apiInfo.method} ${apiInfo.category} - ${apiInfo.baseUrl}`);

        // Log interesting query parameters
        if (Object.keys(apiInfo.queryParams).length > 0) {
          const interestingParams = {};
          for (const [key, value] of Object.entries(apiInfo.queryParams)) {
            if (key.includes('cursor') || key.includes('count') || key.includes('id') ||
                key.includes('type') || key.includes('tab')) {
              interestingParams[key] = value;
            }
          }
          if (Object.keys(interestingParams).length > 0) {
            console.log(`   📋 Params:`, interestingParams);
          }
        }
      }
    });

    page.on('response', async (response) => {
      if (this.isApiRequest(response.url())) {
        const request = response.request();
        const existingRequest = this.apiRequests.find(r => r.url === request.url());

        if (existingRequest && response.status() === 200) {
          try {
            // Try to get response body for successful API calls
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('json')) {
              const body = await response.json();
              existingRequest.response = {
                status: response.status(),
                headers: this.filterHeaders(response.headers()),
                body: body
              };

              console.log(`✅ API Response: ${existingRequest.category} - ${response.status()}`);

              // Log interesting response structure
              if (body && typeof body === 'object') {
                const keys = Object.keys(body);
                console.log(`   📦 Response keys:`, keys.slice(0, 5));
              }
            }
          } catch (error) {
            console.log(`⚠️ Could not parse response body for ${response.url()}: ${error.message}`);
          }
        }
      }
    });

    // Navigate to For You page and let it load
    console.log('🌐 Navigating to TikTok For You page...');
    await page.goto('https://www.tiktok.com/foryou', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    console.log('⏳ Waiting for initial feed to load...');
    await page.waitForTimeout(5000);

    // Scroll a few times to trigger more API calls
    console.log('📜 Scrolling to trigger more API requests...');
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(600, 800);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(3000);
      console.log(`   Scroll ${i + 1}/3 completed`);
    }

    // Wait a bit more for any delayed requests
    await page.waitForTimeout(2000);

    // Analyze and report findings
    console.log('\n📊 Network Analysis Results:');
    console.log('=' .repeat(50));

    const categories = {};
    this.apiRequests.forEach(req => {
      if (!categories[req.category]) {
        categories[req.category] = [];
      }
      categories[req.category].push(req);
    });

    console.log(`\n🔢 Total API requests intercepted: ${this.apiRequests.length}`);
    console.log(`📂 Categories found: ${Object.keys(categories).length}`);

    for (const [category, requests] of Object.entries(categories)) {
      console.log(`\n📁 ${category.toUpperCase()} (${requests.length} requests):`);

      // Group by base URL
      const urlGroups = {};
      requests.forEach(req => {
        if (!urlGroups[req.baseUrl]) {
          urlGroups[req.baseUrl] = [];
        }
        urlGroups[req.baseUrl].push(req);
      });

      for (const [baseUrl, urlRequests] of Object.entries(urlGroups)) {
        console.log(`   🌐 ${baseUrl} (${urlRequests.length}x)`);

        // Show example parameters
        const exampleReq = urlRequests[0];
        if (Object.keys(exampleReq.queryParams).length > 0) {
          console.log(`      📋 Example params:`, Object.keys(exampleReq.queryParams));
        }
      }
    }

    // Save detailed results
    const outputPath = path.join(__dirname, '..', 'output', `network-analysis-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`);
    await fs.writeFile(outputPath, JSON.stringify({
      summary: {
        totalRequests: this.apiRequests.length,
        categories: Object.keys(categories),
        timestamp: new Date().toISOString()
      },
      requestsByCategory: categories
    }, null, 2));

    console.log(`\n💾 Detailed analysis saved to: ${path.basename(outputPath)}`);

    await browser.close();
    return categories;
  }
}

async function main() {
  try {
    const interceptor = new TikTokNetworkInterceptor();
    await interceptor.startInterception();
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = TikTokNetworkInterceptor;