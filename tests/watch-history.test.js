#!/usr/bin/env node

/**
 * Basic automated tests for watch-history functionality
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

// Simple test framework
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('🧪 Running watch-history tests...\n');

    for (const { name, fn } of this.tests) {
      try {
        await fn();
        console.log(`✅ ${name}`);
        this.passed++;
      } catch (error) {
        console.log(`❌ ${name}: ${error.message}`);
        this.failed++;
      }
    }

    console.log(`\n📊 Results: ${this.passed} passed, ${this.failed} failed`);
    return this.failed === 0;
  }

  assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  async assertFileExists(filePath) {
    try {
      await fs.access(filePath);
    } catch (error) {
      throw new Error(`File does not exist: ${filePath}`);
    }
  }
}

const runner = new TestRunner();

// Test 1: Watch-history script syntax check
runner.test('watch-history.js syntax check', async () => {
  try {
    execSync('node -c watch-history.js', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  } catch (error) {
    throw new Error('Syntax error in watch-history.js');
  }
});

// Test 2: WatchHistoryApiClient syntax check
runner.test('WatchHistoryApiClient syntax check', async () => {
  try {
    execSync('node -c lib/watch-history-api-client.js', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  } catch (error) {
    throw new Error('Syntax error in lib/watch-history-api-client.js');
  }
});

// Test 3: Watch-history command integration
runner.test('watch-history command integration', async () => {
  const coscrollPath = path.join(__dirname, '..', 'coscroll.js');
  const content = await fs.readFile(coscrollPath, 'utf-8');

  runner.assert(content.includes('watch-history'), 'watch-history command not found in coscroll.js');
  runner.assert(content.includes("'watch-history'"), 'watch-history not in devCommands array');
});

// Test 4: Help text includes watch-history examples
runner.test('help text includes watch-history examples', async () => {
  const coscrollPath = path.join(__dirname, '..', 'coscroll.js');
  const content = await fs.readFile(coscrollPath, 'utf-8');

  runner.assert(content.includes('watch-history'), 'watch-history examples not found in help text');
  runner.assert(content.includes('--cursor'), 'cursor parameter example not found');
});

// Test 5: Watch-history module exports
runner.test('watch-history module exports', async () => {
  const watchHistoryPath = path.join(__dirname, '..', 'watch-history.js');
  const content = await fs.readFile(watchHistoryPath, 'utf-8');

  runner.assert(content.includes('module.exports'), 'watch-history.js does not export functions');
  runner.assert(content.includes('formatOutput'), 'formatOutput function not exported');
});

// Test 6: API client basic structure
runner.test('WatchHistoryApiClient structure', async () => {
  const clientPath = path.join(__dirname, '..', 'lib', 'watch-history-api-client.js');
  const content = await fs.readFile(clientPath, 'utf-8');

  runner.assert(content.includes('class WatchHistoryApiClient'), 'WatchHistoryApiClient class not found');
  runner.assert(content.includes('getWatchHistory'), 'getWatchHistory method not found');
  runner.assert(content.includes('module.exports'), 'Module not exported');
});

// Test 7: Output format validation
runner.test('output format validation', async () => {
  const watchHistoryPath = path.join(__dirname, '..', 'watch-history.js');

  // Mock require to test formatOutput
  const { formatOutput } = require(watchHistoryPath);

  const mockApiResponse = {
    success: true,
    raw: {
      aweme_list: [
        {
          aweme_id: '12345',
          desc: 'Test video',
          author: { nickname: 'Test User', unique_id: 'testuser', uid: '123' },
          statistics: { play_count: 1000 },
          create_time: 1234567890
        }
      ],
      aweme_watch_history: ['1234567890123'],
      has_more: 0,
      min_cursor: '1234567890123'
    }
  };

  const output = formatOutput(mockApiResponse, 'timeline');
  const parsed = JSON.parse(output);

  runner.assert(parsed.sampled_at, 'Missing sampled_at field');
  runner.assert(parsed.authenticated === true, 'Missing authenticated field');
  runner.assert(parsed.api_stats, 'Missing api_stats field');
  runner.assert(parsed.pagination, 'Missing pagination field');
  runner.assert(Array.isArray(parsed.api_stats.videos), 'Videos should be an array');
  runner.assert(parsed.api_stats.videos.length === 1, 'Should have one video');

  const video = parsed.api_stats.videos[0];
  runner.assert(video.id === '12345', 'Video ID mismatch');
  runner.assert(video.desc === 'Test video', 'Video description mismatch');
  runner.assert(video.method === 'watch_history_api', 'Missing method field');
});

// Test 8: Error handling structure
runner.test('error handling structure', async () => {
  const watchHistoryPath = path.join(__dirname, '..', 'watch-history.js');
  const content = await fs.readFile(watchHistoryPath, 'utf-8');

  runner.assert(content.includes('try {'), 'Missing try-catch blocks');
  runner.assert(content.includes('catch'), 'Missing catch blocks');
  runner.assert(content.includes('process.exit(1)'), 'Missing error exit handling');
});

// Run tests
async function main() {
  const success = await runner.run();
  process.exit(success ? 0 : 1);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
}

module.exports = { TestRunner };