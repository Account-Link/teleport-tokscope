#!/usr/bin/env node

/**
 * Navigation Helper for TikTok Development
 *
 * Quick navigation to common TikTok pages
 */

const { chromium } = require('playwright');

async function navigateToPage(destination = 'foryou') {
  try {
    console.log('🌐 Connecting to development browser...');

    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const browser = await chromium.connectOverCDP(`http://localhost:9223`, { timeout: 5000 });
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages();
    const page = pages?.[0];

    if (!page) {
      console.log('❌ No active page found. Make sure development environment is running.');
      return;
    }

    const urls = {
      foryou: 'https://www.tiktok.com/foryou',
      home: 'https://www.tiktok.com',
      profile: 'https://www.tiktok.com/profile',
      login: 'https://www.tiktok.com/login',
      trending: 'https://www.tiktok.com/trending',
      live: 'https://www.tiktok.com/live'
    };

    const targetUrl = urls[destination] || destination;

    console.log(`🎯 Navigating to: ${targetUrl}`);

    // Use smart navigation like the browser automation client
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });

    // If this is TikTok For You page, wait for feed content to be ready
    if (targetUrl.includes('/foryou')) {
      console.log('⏳ Waiting for FYP content to load...');
      const startTime = Date.now();

      let attempts = 0;
      const maxAttempts = 50; // 50 attempts x 200ms = 10 seconds max

      while (attempts < maxAttempts) {
        const feedReady = await page.evaluate(() => {
          const feedVideos = document.querySelectorAll('[data-e2e="feed-video"]');
          if (feedVideos.length === 0) return { ready: false, reason: 'No feed videos found' };

          let hasContent = false;
          for (const container of feedVideos) {
            const desc = container.querySelector('[data-e2e="video-desc"]');
            const author = container.querySelector('[data-e2e="video-author-uniqueid"]');
            if (desc?.textContent?.trim() || author?.textContent?.trim()) {
              hasContent = true;
              break;
            }
          }

          if (!hasContent) return { ready: false, reason: 'Feed videos have no content yet' };

          return {
            ready: true,
            feedCount: feedVideos.length,
            reason: `Found ${feedVideos.length} feed videos with content`
          };
        });

        if (feedReady.ready) {
          const elapsed = Date.now() - startTime;
          console.log(`✅ FYP ready in ${elapsed}ms: ${feedReady.reason}`);

          // Golf autoplay blocker injection
          await page.evaluate(() => {
            if (!window.autoplayBlockerInstalled) {
              window.originalVideoPlay = HTMLVideoElement.prototype.play;
              HTMLVideoElement.prototype.play = () => Promise.resolve();
              document.querySelectorAll('video').forEach(v => v.paused || v.pause());
              window.toggleVideo = () => { const v = document.querySelector('video'); return v && (v.paused ? window.originalVideoPlay.call(v) : v.pause()); };
              window.autoplayBlockerInstalled = true;
              console.log('🚫 Autoplay blocked');
            }
          });

          await page.waitForTimeout(500); // Brief pause to ensure stability
          break;
        }

        await page.waitForTimeout(200);
        attempts++;
      }

      if (attempts >= maxAttempts) {
        console.log('⚠️ FYP content detection timeout, but page may be loaded');
      }
    } else {
      await page.waitForTimeout(1000);
    }

    console.log(`✅ Successfully navigated to: ${page.url()}`);

    await browser.close();

  } catch (error) {
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      console.error('❌ Cannot connect to browser. Make sure development environment is running:');
      console.error('   ./dev-sample.js start');
    } else if (error.message.includes('Navigation timeout')) {
      console.error('⚠️ Navigation timeout, but page may have loaded. Check browser manually.');
    } else {
      console.error('❌ Navigation failed:', error.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const destination = args[0] || 'foryou';

  if (args.includes('--help') || args.includes('-h')) {
    console.log('🌐 Navigation Helper');
    console.log('Usage: node navigate.js [destination]');
    console.log('');
    console.log('Available destinations:');
    console.log('  foryou    - For You feed (default)');
    console.log('  home      - TikTok homepage');
    console.log('  profile   - User profile page');
    console.log('  login     - Login page');
    console.log('  trending  - Trending page');
    console.log('  live      - Live streams');
    console.log('');
    console.log('Or provide a custom URL:');
    console.log('  node navigate.js "https://www.tiktok.com/custom-page"');
    return;
  }

  await navigateToPage(destination);
}

if (require.main === module) {
  main();
}

module.exports = { navigateToPage };