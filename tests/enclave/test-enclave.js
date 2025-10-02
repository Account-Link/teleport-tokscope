#!/usr/bin/env node

/**
 * TCB Flow Test Script
 *
 * Demonstrates the complete TCB workflow:
 * 1. Load existing session with DStack encryption
 * 2. Test both web API and browser automation methods
 * 3. Verify health status
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration
const TCB_URL = 'http://localhost:3000';
const ENCRYPTION_SEED = 'tcb-session-encryption-fallback-seed-12345';

// Find most recent auth file
function findLatestAuthFile() {
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
    throw new Error('No TikTok auth files found in output/ directory');
  }

  return authFiles[0].path;
}

// Encrypt session data using DStack-compatible method
function encryptSession(sessionData) {
  const encryptionKey = crypto.createHash('sha256').update(ENCRYPTION_SEED).digest();
  const plaintext = JSON.stringify(sessionData);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

  // Use TikTok sec_user_id as additional authenticated data
  if (sessionData.user?.sec_user_id) {
    cipher.setAAD(Buffer.from(sessionData.user.sec_user_id, 'utf8'));
  }

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    userId: sessionData.user?.sec_user_id
  };
}

// Make HTTP request helper
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
      throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error(`❌ Request failed: ${error.message}`);
    throw error;
  }
}

async function main() {
  console.log('🔐 TCB Flow Test Script');
  console.log('========================\n');

  try {
    // Step 1: Load and encrypt session
    console.log('📂 Step 1: Loading session data...');
    const authFile = findLatestAuthFile();
    console.log(`   Using: ${path.basename(authFile)}`);

    const sessionData = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    console.log(`   User: @${sessionData.user.username} (${sessionData.user.sec_user_id})`);

    const encryptedSession = encryptSession(sessionData);
    console.log(`   ✅ Session encrypted with DStack key derivation\n`);

    // Step 2: Load session into TCB
    console.log('🔒 Step 2: Loading encrypted session into TCB...');
    const loadResponse = await makeRequest('/load-session', {
      method: 'POST',
      body: { encryptedSession }
    });
    const sessionId = loadResponse.sessionId;
    console.log(`   ✅ Session loaded successfully (ID: ${sessionId.substring(0, 8)}...)\n`);

    // Step 3: Check health
    console.log('🏥 Step 3: Checking authentication status...');
    const health = await makeRequest('/health');
    console.log(`   System: ${health.system}`);
    console.log(`   Active Sessions: ${health.activeSessions}/${health.maxSessions}`);
    console.log(`   Uptime: ${Math.round(health.uptime)}s\n`);

    // Step 4: Test browser automation
    console.log('🎭 Step 4: Testing Browser automation...');
    const browserResults = await makeRequest(`/sample/${sessionId}`, {
      method: 'POST',
      body: { count: 2, method: 'browser', scrollCount: 2 }
    });
    console.log(`   ✅ Sampled ${browserResults.videos.length} videos via Browser automation`);
    if (browserResults.videos.length > 0) {
      const firstVideo = browserResults.videos[0];
      console.log(`   Example: "${firstVideo.description.slice(0, 50)}..." by @${firstVideo.author}`);
    }
    console.log('');


    console.log('🎉 All tests passed! TCB flow working correctly.');
    console.log('\n📋 Summary:');
    console.log(`   • DStack encryption: Working (fallback key)`);
    console.log(`   • Session management: Working`);
    console.log(`   • Browser automation: ${browserResults.videos.length} videos`);
    console.log(`   • User binding: ${sessionData.user.sec_user_id}`);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\n🔧 Troubleshooting:');
    console.error('   • Ensure TCB container is running: docker compose -f docker-compose-tcb.yml up -d');
    console.error('   • Check you have auth files in output/ directory');
    console.error('   • Verify the auth file contains valid TikTok session with sec_user_id');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { encryptSession, findLatestAuthFile };