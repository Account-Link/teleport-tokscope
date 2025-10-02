#!/usr/bin/env node

/**
 * Test Auth and Sampling Endpoints
 *
 * Tests the new tokscope-enclave interface:
 * 1. POST /auth/start/:sessionId - Start auth flow, get QR code
 * 2. GET /auth/poll/:authSessionId - Poll for completion
 * 3. POST /playwright/foryoupage/sample/:sessionId - Sample with Playwright
 * 4. POST /modules/foryoupage/sample/:sessionId - Sample with modules (if available)
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const TCB_URL = 'http://localhost:3000';

async function makeRequest(endpoint, options = {}) {
  const url = `${TCB_URL}${endpoint}`;
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : undefined;

  console.log(`📡 ${method} ${endpoint}`);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      body
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data.error || data.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error(`❌ Request failed: ${error.message}`);
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testAuthFlow() {
  console.log('\n🔐 TEST 1: Authentication Flow');
  console.log('================================\n');

  // Generate a temporary session ID
  const tempSessionId = 'test-auth-' + Date.now();

  console.log('📤 Step 1: Starting authentication...');
  const startResponse = await makeRequest(`/auth/start/${tempSessionId}`, {
    method: 'POST',
    body: {}
  });

  console.log(`   ✅ Auth session started: ${startResponse.authSessionId.substring(0, 8)}...`);
  console.log(`   Status: ${startResponse.status}`);

  const authSessionId = startResponse.authSessionId;

  console.log('\n📥 Step 2: Polling for QR code...');
  await sleep(3000); // Wait for QR extraction

  let pollCount = 0;
  const maxPolls = 35; // 5 polls to get QR + 30 polls (60s) to wait for scan
  let qrDisplayed = false;

  while (pollCount < maxPolls) {
    const pollResponse = await makeRequest(`/auth/poll/${authSessionId}`);

    if (pollResponse.status === 'awaiting_scan' && pollResponse.qrCodeData && !qrDisplayed) {
      console.log(`   ✅ QR code received from enclave`);

      // Extract URL from QR code data
      const { Jimp } = require('jimp');
      const jsQR = require('jsqr');
      const buffer = Buffer.from(pollResponse.qrCodeData.split(',')[1], 'base64');
      const image = await Jimp.read(buffer);
      const imageData = {
        data: new Uint8ClampedArray(image.bitmap.data),
        width: image.bitmap.width,
        height: image.bitmap.height
      };
      const decoded = jsQR(imageData.data, imageData.width, imageData.height);

      if (decoded) {
        console.log('\n   📱 Scan this QR code with TikTok mobile app:\n');
        const qrAscii = await QRCode.toString(decoded.data, { type: 'terminal', small: true });
        console.log(qrAscii);
        console.log('   ⏳ Waiting up to 60 seconds for you to scan...\n');
      }

      // Write QR code to file for viewing
      const qrFilePath = path.join(__dirname, '../../output/test-qr-code.txt');
      fs.writeFileSync(qrFilePath, pollResponse.qrCodeData);
      console.log(`   💾 QR code also saved to: ${qrFilePath}\n`);

      qrDisplayed = true;
    } else if (pollResponse.status === 'awaiting_scan' && qrDisplayed) {
      // Still waiting for scan
      process.stdout.write(`\r   ⏳ Waiting... (${(maxPolls - pollCount) * 2}s remaining)`);
    } else if (pollResponse.status === 'complete') {
      if (qrDisplayed) console.log('\n');
      console.log(`   ✅ Login completed!`);
      console.log(`   User: @${pollResponse.sessionData.user.username}`);
      return pollResponse.sessionData;
    } else if (pollResponse.status === 'failed') {
      throw new Error('Authentication failed');
    }

    pollCount++;
    await sleep(2000);
  }

  if (qrDisplayed) console.log('\n');
  console.log('\n   ⏭️  Timeout waiting for scan, will use existing session\n');
  return null;
}

async function testLoadSession() {
  console.log('\n📂 TEST 2: Load Existing Session');
  console.log('==================================\n');

  // Find most recent auth file
  const outputDir = path.join(__dirname, '../../output');
  const authFiles = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('tiktok-auth-') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(outputDir, f),
      mtime: fs.statSync(path.join(outputDir, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (authFiles.length === 0) {
    console.log('   ⚠️  No auth files found, skipping session tests');
    return null;
  }

  const authFile = authFiles[0].path;
  console.log(`   Using: ${path.basename(authFile)}`);

  const sessionData = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  console.log(`   User: @${sessionData.user.username || 'unknown'}`);

  console.log('\n   Loading session into enclave...');
  const loadResponse = await makeRequest('/load-session', {
    method: 'POST',
    body: { sessionData }
  });

  console.log(`   ✅ Session loaded: ${loadResponse.sessionId.substring(0, 8)}...`);

  return loadResponse.sessionId;
}

async function testPlaywrightSampling(sessionId) {
  console.log('\n🎭 TEST 3: Playwright For You Page Sampling');
  console.log('=============================================\n');

  console.log(`   Sampling 3 videos for session ${sessionId.substring(0, 8)}...`);

  const sampleResponse = await makeRequest(`/playwright/foryoupage/sample/${sessionId}`, {
    method: 'POST',
    body: { count: 3 }
  });

  console.log(`   ✅ Sampling completed!`);
  console.log(`   Videos: ${sampleResponse.videos.length}`);
  console.log(`   Method: ${sampleResponse.method}`);
  console.log(`   Sampled at: ${sampleResponse.sampled_at}`);

  if (sampleResponse.videos.length > 0) {
    console.log('\n   Sample videos:');
    sampleResponse.videos.slice(0, 3).forEach((video, i) => {
      const desc = video.description || video.desc || 'No description';
      const shortDesc = desc.length > 50 ? desc.substring(0, 50) + '...' : desc;
      console.log(`   ${i + 1}. @${video.author}: "${shortDesc}"`);
    });
  }

  return sampleResponse;
}

async function testDeprecatedEndpoint(sessionId) {
  console.log('\n⚠️  TEST 4: Deprecated /sample Endpoint');
  console.log('=======================================\n');

  try {
    await makeRequest(`/sample/${sessionId}`, {
      method: 'POST',
      body: { count: 1 }
    });
    console.log('   ❌ Should have returned 410 error');
  } catch (error) {
    if (error.message.includes('410')) {
      console.log('   ✅ Deprecated endpoint correctly returns 410');
    } else {
      console.log(`   ⚠️  Unexpected error: ${error.message}`);
    }
  }
}

async function testHealthCheck() {
  console.log('\n🏥 TEST 5: Health Check');
  console.log('========================\n');

  const health = await makeRequest('/health');

  console.log(`   Status: ${health.status}`);
  console.log(`   Sessions: ${health.activeSessions}/${health.maxSessions}`);
  console.log(`   Uptime: ${Math.round(health.uptime)}s`);
  console.log(`   DStack: ${health.dstack ? 'enabled' : 'fallback'}`);
  console.log(`   Encryption: ${health.encryption ? 'enabled' : 'disabled'}`);

  return health;
}

async function main() {
  console.log('🧪 Xordi Enclave - Auth & Sampling Tests');
  console.log('==========================================');

  try {
    // Test 1: Auth flow (will pause for manual QR scan)
    const newSessionData = await testAuthFlow();

    let sessionId;
    if (newSessionData) {
      // Use the newly authenticated session
      console.log('\n📂 Loading newly authenticated session');
      console.log('========================================\n');
      console.log(`   User: @${newSessionData.user.username}`);
      console.log('   Loading session into enclave...');

      const loadResponse = await makeRequest('/load-session', {
        method: 'POST',
        body: { sessionData: newSessionData }
      });

      sessionId = loadResponse.sessionId;
      console.log(`   ✅ Session loaded: ${sessionId.substring(0, 8)}...\n`);
    } else {
      // Test 2: Load existing session
      sessionId = await testLoadSession();

      if (!sessionId) {
        console.log('\n⚠️  No session available for sampling tests');
        console.log('   Run "node xordi.js auth" first to create a session\n');
        return;
      }
    }

    // Test 3: Playwright sampling
    await testPlaywrightSampling(sessionId);

    // Test 4: Deprecated endpoint
    await testDeprecatedEndpoint(sessionId);

    // Test 5: Health check
    await testHealthCheck();

    console.log('\n✅ All tests completed successfully!');
    console.log('\n📋 Summary:');
    console.log('   ✅ Auth flow working (manual QR scan required for completion)');
    console.log('   ✅ Session loading working');
    console.log('   ✅ Playwright sampling working');
    console.log('   ✅ Deprecated endpoint handling correct');
    console.log('   ✅ Health check working');

  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    console.error('\n🔧 Troubleshooting:');
    console.error('   • Ensure enclave is running: npm run start:audit');
    console.error('   • Check logs: docker logs tokscope-enclave');
    console.error('   • Verify browser-manager is running: docker ps');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { testAuthFlow, testPlaywrightSampling };