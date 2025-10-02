#!/usr/bin/env node

/**
 * Screenshot Tool for TikTok Development
 *
 * Takes screenshots of current browser state for debugging and documentation
 */

const fs = require('fs').promises;
const path = require('path');
const BrowserConnection = require('../dist/lib/browser-connection.js');

async function takeScreenshot(options = {}) {
  try {
    console.log('📸 Connecting to development browser...');

    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const cdpPort = process.env.CDP_PORT || 9223;
    const cdpUrl = `http://17.${thirdOctet}.0.3:${cdpPort}`;

    const { browser, page } = await BrowserConnection.connectToBrowser(cdpUrl);

    // Create screenshots directory
    const screenshotDir = path.join(__dirname, '..', 'output', 'screenshots');
    await fs.mkdir(screenshotDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const url = page.url();
    const urlPart = url.includes('foryou') ? 'foryou' :
                   url.includes('video') ? 'video' :
                   url.includes('profile') ? 'profile' : 'page';

    let screenshotOptions = {
      path: path.join(screenshotDir, `${urlPart}-${timestamp}.png`),
      fullPage: options.fullPage !== false, // Default to full page
    };

    // Add optional clip area
    if (options.clip) {
      screenshotOptions.clip = options.clip;
      screenshotOptions.fullPage = false;
    }

    console.log(`📍 Current page: ${url}`);
    console.log('📸 Taking screenshot...');

    await page.screenshot(screenshotOptions);

    console.log(`✅ Screenshot saved: ${screenshotOptions.path}`);

    // Also take a mobile viewport screenshot for comparison
    if (options.mobile !== false) {
      await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE size
      await page.waitForTimeout(1000); // Let layout adjust

      const mobileScreenshotPath = path.join(screenshotDir, `${urlPart}-${timestamp}-mobile.png`);
      await page.screenshot({
        path: mobileScreenshotPath,
        fullPage: options.fullPage !== false
      });

      console.log(`📱 Mobile screenshot saved: ${mobileScreenshotPath}`);

      // Reset to desktop size
      await page.setViewportSize({ width: 1280, height: 720 });
    }

    // Take a focused screenshot of video area if on video page
    if (url.includes('video') || url.includes('foryou')) {
      try {
        const videoElement = await page.locator('video').first();
        if (await videoElement.isVisible()) {
          const videoPath = path.join(screenshotDir, `video-element-${timestamp}.png`);
          await videoElement.screenshot({ path: videoPath });
          console.log(`🎥 Video element screenshot: ${videoPath}`);
        }
      } catch (e) {
        // Video element might not be available
      }
    }

    await browser.close();

    return screenshotOptions.path;

  } catch (error) {
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      console.error('❌ Cannot connect to browser. Make sure development environment is running:');
      console.error('   ./dev-sample.js start');
    } else {
      console.error('❌ Screenshot failed:', error.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    fullPage: !args.includes('--viewport-only'),
    mobile: !args.includes('--no-mobile')
  };

  // Parse clip coordinates if provided
  const clipArg = args.find(arg => arg.startsWith('--clip='));
  if (clipArg) {
    const coords = clipArg.split('=')[1].split(',').map(n => parseInt(n));
    if (coords.length === 4) {
      options.clip = { x: coords[0], y: coords[1], width: coords[2], height: coords[3] };
      console.log(`🎯 Using clip area: ${coords.join(', ')}`);
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log('📸 Screenshot Tool');
    console.log('Usage: node screenshot.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --viewport-only    Take only viewport screenshot (not full page)');
    console.log('  --no-mobile       Skip mobile screenshot');
    console.log('  --clip=x,y,w,h    Take screenshot of specific area');
    console.log('');
    console.log('Examples:');
    console.log('  node screenshot.js                    # Full page + mobile');
    console.log('  node screenshot.js --viewport-only    # Just current viewport');
    console.log('  node screenshot.js --clip=100,200,800,600  # Specific area');
    return;
  }

  await takeScreenshot(options);
}

if (require.main === module) {
  main();
}

module.exports = { takeScreenshot };