#!/usr/bin/env node
/**
 * Teleport TikTok Nooscope - CLI Tool for TikTok Data Collection
 *
 * A command-line tool for collecting and organizing your TikTok data:
 * - Sample the public For You feed (no login required)
 * - Authenticate and sample your personalized feed
 * - Collect your Watch History
 * - Organize samples in a structured output directory
 *
 * The nooscope helps you understand TikTok content recommendation patterns,
 * track meme propagation, and analyze sentiment shifts over time.
 *
 * Usage:
 *   node tokscope.js                    # Interactive menu
 *   node tokscope.js sample             # Sample public For You feed
 *   node tokscope.js auth               # Authenticate with TikTok
 *   node tokscope.js sample --auth      # Sample authenticated feed
 *   node tokscope.js watch-history      # Collect watch history
 *   node tokscope.js status             # Show collection status
 */

const fs = require('fs').promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const BrowserAutomationClient = require('./dist/lib/browser-automation-client');

const OUTPUT_DIR = path.join(__dirname, 'output', 'nooscope');
const PUBLIC_DIR = path.join(OUTPUT_DIR, 'public-foryou');
const AUTH_DIR = path.join(OUTPUT_DIR, 'authenticated-foryou');
const WATCH_HISTORY_DIR = path.join(OUTPUT_DIR, 'watch-history');
const SESSION_DIR = path.join(__dirname, 'output');

// Ensure output directories exist
async function ensureDirectories() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await fs.mkdir(WATCH_HISTORY_DIR, { recursive: true });
}

// Find most recent session
async function loadSession() {
  try {
    const files = await fs.readdir(SESSION_DIR);
    const sessionFiles = files
      .filter(f => f.startsWith('tiktok-auth-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (sessionFiles.length > 0) {
      const sessionPath = path.join(SESSION_DIR, sessionFiles[0]);
      const content = await fs.readFile(sessionPath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Sample For You feed
async function sampleForYou(authenticated = false) {
  const session = authenticated ? await loadSession() : null;
  const type = authenticated ? 'authenticated' : 'public';
  const outputDir = authenticated ? AUTH_DIR : PUBLIC_DIR;

  console.log(`\n📱 Sampling ${type} For You feed...`);
  console.log(`   Mode: ${authenticated ? '🔐 Authenticated' : '🌍 Public'}`);

  const client = new BrowserAutomationClient(session, {
    reuseContainer: true,
    cdpUrl: 'http://localhost:9223'
  });

  try {
    await client.initialize();
    const videos = await client.sampleForYouFeed(20);
    await client.cleanup();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `foryou-${timestamp}.json`;
    const filepath = path.join(outputDir, filename);

    const data = {
      timestamp: new Date().toISOString(),
      type: 'foryou',
      authenticated,
      username: session?.user?.username || 'public',
      count: videos.length,
      videos
    };

    await fs.writeFile(filepath, JSON.stringify(data, null, 2));

    console.log(`\n✅ Collected ${videos.length} videos`);
    console.log(`📁 Saved to: ${filepath}`);

    // Show quick summary
    const creators = [...new Set(videos.map(v => v.author))];
    const hashtags = new Set();
    videos.forEach(v => {
      if (v.challenges) {
        v.challenges.forEach(c => hashtags.add(`#${c.title}`));
      }
    });

    console.log(`\n📊 Quick Summary:`);
    console.log(`   ${creators.length} unique creators`);
    console.log(`   ${hashtags.size} unique hashtags`);
    console.log(`   Top creators: ${creators.slice(0, 3).map(c => '@' + c).join(', ')}`);

    return data;
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    await client.cleanup();
    throw error;
  }
}

// Sample watch history
async function sampleWatchHistory() {
  const session = await loadSession();

  if (!session) {
    console.log('\n❌ Authentication required for watch history');
    console.log('   Run: node tokscope.js auth');
    process.exit(1);
  }

  console.log(`\n📜 Collecting watch history...`);
  console.log(`   User: @${session.user.username}`);

  const client = new BrowserAutomationClient(session, {
    reuseContainer: true,
    cdpUrl: 'http://localhost:9223'
  });

  try {
    await client.initialize();
    const history = await client.sampleWatchHistory(100);
    await client.cleanup();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `watch-history-${timestamp}.json`;
    const filepath = path.join(WATCH_HISTORY_DIR, filename);

    const data = {
      timestamp: new Date().toISOString(),
      type: 'watch-history',
      username: session.user.username,
      count: history.length,
      videos: history
    };

    await fs.writeFile(filepath, JSON.stringify(data, null, 2));

    console.log(`\n✅ Collected ${history.length} watch history items`);
    console.log(`📁 Saved to: ${filepath}`);

    return data;
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    await client.cleanup();
    throw error;
  }
}

// Show authentication QR code
async function authenticate() {
  console.log('\n🔐 TikTok Authentication');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nYou\'ll need to scan a QR code with the TikTok mobile app.');
  console.log('This enables:');
  console.log('  • Sampling your personalized For You feed');
  console.log('  • Collecting your Watch History');
  console.log('\nStarting authentication...\n');

  const { execSync } = require('child_process');
  execSync('node workbench.js auth', { stdio: 'inherit' });

  console.log('\n✅ Authentication complete!');
  console.log('\nNext steps:');
  console.log('  node tokscope.js sample --auth    # Sample your personalized feed');
  console.log('  node tokscope.js watch-history    # Collect watch history');
}

// Show collection status
async function showStatus() {
  const session = await loadSession();

  console.log('\n📊 TikTok Nooscope Collection Status');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Authentication status
  console.log('\n🔐 Authentication:');
  if (session) {
    console.log(`   ✅ Logged in as @${session.user.username}`);
    console.log(`   📅 Session from ${new Date(session.timestamp).toLocaleString()}`);
  } else {
    console.log('   ❌ Not authenticated');
    console.log('   💡 Run: node tokscope.js auth');
  }

  // Count samples
  const publicSamples = await countFiles(PUBLIC_DIR);
  const authSamples = await countFiles(AUTH_DIR);
  const watchHistory = await countFiles(WATCH_HISTORY_DIR);

  console.log('\n📁 Collections:');
  console.log(`   🌍 Public For You:        ${publicSamples} samples`);
  console.log(`   🔐 Authenticated For You: ${authSamples} samples`);
  console.log(`   📜 Watch History:         ${watchHistory} samples`);

  // Show latest samples
  if (publicSamples > 0 || authSamples > 0 || watchHistory > 0) {
    console.log('\n📅 Latest Samples:');
    if (publicSamples > 0) {
      const latest = await getLatestFile(PUBLIC_DIR);
      console.log(`   Public: ${latest}`);
    }
    if (authSamples > 0) {
      const latest = await getLatestFile(AUTH_DIR);
      console.log(`   Auth: ${latest}`);
    }
    if (watchHistory > 0) {
      const latest = await getLatestFile(WATCH_HISTORY_DIR);
      console.log(`   Watch History: ${latest}`);
    }
  }

  console.log('\n💡 Next Steps:');
  if (!session) {
    console.log('   1. node tokscope.js sample           # Sample public feed');
    console.log('   2. node tokscope.js auth             # Authenticate');
    console.log('   3. node tokscope.js sample --auth    # Sample your feed');
  } else {
    console.log('   • node tokscope.js sample           # Sample public feed');
    console.log('   • node tokscope.js sample --auth    # Sample your feed');
    console.log('   • node tokscope.js watch-history    # Collect watch history');
  }

  console.log('\n📂 Data location: output/nooscope/');
}

// Helper: Count files in directory
async function countFiles(dir) {
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// Helper: Get latest file
async function getLatestFile(dir) {
  try {
    const files = await fs.readdir(dir);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
    if (jsonFiles.length > 0) {
      const stat = await fs.stat(path.join(dir, jsonFiles[0]));
      return `${jsonFiles[0]} (${new Date(stat.mtime).toLocaleString()})`;
    }
    return 'None';
  } catch {
    return 'None';
  }
}

// Interactive menu
async function showMenu() {
  const session = await loadSession();

  console.log('\n🔭 Teleport TikTok Nooscope');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nWhat would you like to do?\n');

  console.log('  1. Sample public For You feed (no login required)');
  console.log('  2. Authenticate with TikTok');
  if (session) {
    console.log('  3. Sample your personalized For You feed');
    console.log('  4. Collect your Watch History');
  }
  console.log('  5. Show collection status');
  console.log('  0. Exit');

  console.log('\nOr use commands directly:');
  console.log('  node tokscope.js sample           # Sample public feed');
  console.log('  node tokscope.js auth             # Authenticate');
  if (session) {
    console.log('  node tokscope.js sample --auth    # Sample your feed');
    console.log('  node tokscope.js watch-history    # Collect history');
  }
  console.log('  node tokscope.js status           # Show status');
}

// Main CLI
async function main() {
  await ensureDirectories();

  const argv = yargs(hideBin(process.argv))
    .command('sample', 'Sample For You feed', {
      auth: {
        type: 'boolean',
        default: false,
        describe: 'Use authenticated session'
      }
    })
    .command('auth', 'Authenticate with TikTok')
    .command('watch-history', 'Collect watch history')
    .command('status', 'Show collection status')
    .help()
    .argv;

  const command = argv._[0];

  if (!command) {
    await showMenu();
    return;
  }

  switch (command) {
    case 'sample':
      await sampleForYou(argv.auth);
      break;

    case 'auth':
      await authenticate();
      break;

    case 'watch-history':
      await sampleWatchHistory();
      break;

    case 'status':
      await showStatus();
      break;

    default:
      console.log(`Unknown command: ${command}`);
      console.log('Run "node tokscope.js --help" for usage');
  }
}

// Note about TikTok's download feature
function showDownloadNote() {
  console.log('\n💡 Note: TikTok Download Your Data');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nTikTok offers a "Download your data" feature in settings');
  console.log('that provides your watch history as a downloadable file.');
  console.log('\nHowever, the nooscope approach has advantages:');
  console.log('  ✅ Real-time collection (no waiting for data export)');
  console.log('  ✅ Easy to update (just run again)');
  console.log('  ✅ Also captures For You feed samples');
  console.log('  ✅ Includes video metadata for analysis');
  console.log('\nFor one-time historical data, TikTok\'s download feature');
  console.log('is useful as a complement to nooscope\'s ongoing collection.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  sampleForYou,
  sampleWatchHistory,
  authenticate,
  showStatus
};
