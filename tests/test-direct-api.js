#!/usr/bin/env node

/**
 * Test Direct API Access to TikTok Watch History
 */

const fs = require('fs').promises;
const path = require('path');
const WatchHistoryApiClient = require('../lib/watch-history-api-client.js');

async function findLatestSession() {
  try {
    const outputDir = path.join(__dirname, '../output');
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

async function loadSession(sessionPath) {
  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load session: ${error.message}`);
  }
}

async function testDirectApi() {
  try {
    console.log('🔍 Finding latest authentication session...');
    const sessionPath = await findLatestSession();

    if (!sessionPath) {
      console.log('❌ No authentication session found. Run authentication first.');
      console.log('💡 Try: node coscroll.js --auth');
      return;
    }

    console.log(`📄 Loading session: ${path.basename(sessionPath)}`);
    const sessionData = await loadSession(sessionPath);
    console.log(`👤 Session user: @${sessionData.user?.username || 'unknown'}`);

    console.log('\n🚀 Initializing Watch History API Client...');
    const client = new WatchHistoryApiClient(sessionData);

    console.log('\n📊 Testing single API call...');
    const result = await client.getWatchHistory({ count: 10 });

    if (result.success) {
      console.log('\n✅ SUCCESS! Watch history API working!');
      console.log(`📹 Found ${result.data?.list?.length || 0} watch history items`);

      if (result.data?.list && result.data.list.length > 0) {
        console.log('\n🎬 Sample watch history items:');
        result.data.list.slice(0, 3).forEach((item, i) => {
          const video = item.aweme_info;
          console.log(`  ${i + 1}. ${video?.desc || 'No description'}`);
          console.log(`     ID: ${video?.aweme_id}`);
          console.log(`     Author: @${video?.author?.unique_id}`);
        });
      }
    } else {
      console.log('\n❌ API call failed');
      console.log(`🏷️ Status: ${result.tiktokStatusCode} - ${result.tiktokStatusMsg}`);

      if (result.tiktokStatusCode === 5) {
        console.log('\n🧪 Testing different parameter combinations to fix "Invalid parameters"...');
        await client.testApiParameters();
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testDirectApi();