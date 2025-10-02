#!/usr/bin/env node

/**
 * Action Simulation Tool for TikTok Development
 *
 * Simulates user actions like clicking, scrolling, navigation
 * Useful for testing automation flows interactively
 */

const { chromium } = require('playwright');

async function simulateActions(actionList = null) {
  try {
    console.log('🎮 Connecting to development browser...');

    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const browser = await chromium.connectOverCDP(`http://localhost:9223`, { timeout: 5000 });
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages();
    const page = pages?.[0];

    let likeIndex = 0; // Track which like button to click (0 = first, 1 = second)

    if (!page) {
      console.log('❌ No active page found. Make sure development environment is running.');
      return;
    }

    console.log(`📍 Current page: ${page.url()}`);

    // Available actions
    const actions = {
      async navigate(url) {
        console.log(`🌐 Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(2000);
        console.log(`✅ Navigated to: ${page.url()}`);
      },

      async clickFirst(selector) {
        console.log(`👆 Looking for first: ${selector}`);
        const element = page.locator(selector).first();
        if (await element.isVisible()) {
          await element.click();
          await page.waitForTimeout(1000);
          console.log(`✅ Clicked: ${selector}`);
        } else {
          console.log(`❌ Element not found or not visible: ${selector}`);
        }
      },

      async scroll(direction = 'down', amount = 3) {
        console.log(`📜 Scrolling ${direction} ${amount} times`);
        for (let i = 0; i < amount; i++) {
          if (direction === 'down') {
            await page.evaluate(() => {
              const containers = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
              let currentVisibleIndex = -1;

              // Find which container is currently fully visible
              for (let j = 0; j < containers.length; j++) {
                const rect = containers[j].getBoundingClientRect();
                const isFullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
                if (isFullyVisible) {
                  currentVisibleIndex = j;
                  break;
                }
              }

              if (currentVisibleIndex >= 0 && currentVisibleIndex + 1 < containers.length) {
                const nextContainer = containers[currentVisibleIndex + 1];
                console.log(`Scrolling from container ${currentVisibleIndex} to ${currentVisibleIndex + 1}`);
                nextContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            });
          } else if (direction === 'up') {
            await page.evaluate(() => {
              const containers = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
              let currentVisibleIndex = -1;

              // Find which container is currently fully visible
              for (let j = 0; j < containers.length; j++) {
                const rect = containers[j].getBoundingClientRect();
                const isFullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
                if (isFullyVisible) {
                  currentVisibleIndex = j;
                  break;
                }
              }

              if (currentVisibleIndex > 0) {
                const prevContainer = containers[currentVisibleIndex - 1];
                console.log(`Scrolling from container ${currentVisibleIndex} to ${currentVisibleIndex - 1}`);
                prevContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            });
          }
          await page.waitForTimeout(2000);
          console.log(`  ${i + 1}/${amount}`);
        }
        console.log(`✅ Scrolled ${direction} ${amount} times`);
      },

      async waitFor(ms) {
        console.log(`⏳ Waiting ${ms}ms...`);
        await page.waitForTimeout(ms);
        console.log(`✅ Wait complete`);
      },

      async type(selector, text) {
        console.log(`⌨️ Typing "${text}" into: ${selector}`);
        await page.fill(selector, text);
        await page.waitForTimeout(500);
        console.log(`✅ Text entered`);
      },

      async press(key) {
        console.log(`⌨️ Pressing key: ${key}`);
        await page.keyboard.press(key);
        await page.waitForTimeout(500);
        console.log(`✅ Key pressed: ${key}`);
      },

      async clickVideo() {
        console.log('🎥 Looking for first video to click...');
        const selectors = [
          '[data-e2e="recommend-list-item-container"] a',
          '[data-e2e="video-container"]',
          'a[href*="/video/"]',
          'video'
        ];

        for (const selector of selectors) {
          try {
            const element = page.locator(selector).first();
            if (await element.isVisible()) {
              await element.click();
              await page.waitForTimeout(3000);
              console.log(`✅ Clicked video via: ${selector}`);
              return true;
            }
          } catch (e) {
            continue;
          }
        }
        console.log('❌ No clickable video found');
        return false;
      },

      async nextVideo() {
        console.log('⏭️ Going to next video...');
        // Focus the page first
        const { width, height } = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight
        }));

        await page.mouse.click(width - 100, height / 2);
        await page.waitForTimeout(100);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(2000);
        console.log('✅ Navigated to next video');
      },

      async like() {
        console.log(`❤️ Attempting to like video (button ${likeIndex + 1})...`);
        try {
          // Count total like buttons available
          const totalLikeButtons = await page.locator('[data-e2e="like-icon"]').count();
          console.log(`📊 Found ${totalLikeButtons} like buttons total`);

          // Use current index, but cap it at the last available button
          const buttonIndex = Math.min(likeIndex, totalLikeButtons - 1);

          const likeButton = page.locator('[data-e2e="like-icon"]').nth(buttonIndex);
          if (await likeButton.isVisible()) {
            await likeButton.click();
            await page.waitForTimeout(1000);
            console.log(`✅ Liked video successfully! (used button ${buttonIndex + 1})`);

            // Increment index for next time, but cap at max available
            likeIndex = Math.min(likeIndex + 1, totalLikeButtons - 1);
            console.log(`🔢 Next like will use button ${likeIndex + 1}`);
            return true;
          } else {
            console.log('❌ Like button not visible');
            return false;
          }
        } catch (error) {
          console.log(`❌ Error liking video: ${error.message}`);
          return false;
        }
      },

      async goToForYou() {
        return await actions.navigate('https://www.tiktok.com/foryou');
      },

      async dismissPopup() {
        console.log('❌ Looking for popup to dismiss...');
        const popupSelectors = [
          'button:has-text("Not now")',
          '[data-testid="close-button"]',
          'button[aria-label="Close"]',
          '.close-button'
        ];

        for (const selector of popupSelectors) {
          try {
            const element = page.locator(selector).first();
            if (await element.isVisible()) {
              await element.click();
              await page.waitForTimeout(1000);
              console.log(`✅ Dismissed popup via: ${selector}`);
              return true;
            }
          } catch (e) {
            continue;
          }
        }
        console.log('ℹ️ No popup found to dismiss');
        return false;
      },

      async goToVideo(videoId) {
        return await actions.navigate(`https://www.tiktok.com/@user/video/${videoId}`);
      },

      async screenshot(filename = null) {
        const name = filename || `action-${Date.now()}.png`;
        console.log(`📸 Taking screenshot: ${name}`);
        await page.screenshot({ path: `workbench-tools/../output/screenshots/${name}` });
        console.log(`✅ Screenshot saved`);
      },

      async inspectVideoContainers() {
        console.log('🔍 Inspecting video containers on page...');
        const containerInfo = await page.evaluate(() => {
          const containers = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
          const videoContainers = document.querySelectorAll('[data-e2e="video-container"]');
          const allVideos = document.querySelectorAll('video');

          const getElementInfo = (el, index) => {
            const rect = el.getBoundingClientRect();
            const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
            const isFullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
            return {
              index,
              tagName: el.tagName,
              className: el.className,
              id: el.id,
              rect: {
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                width: rect.width,
                height: rect.height
              },
              isVisible,
              isFullyVisible,
              parentElement: el.parentElement?.tagName,
              hasVideo: el.querySelector('video') ? true : false
            };
          };

          return {
            recommendContainers: Array.from(containers).map(getElementInfo),
            videoContainers: Array.from(videoContainers).map(getElementInfo),
            videos: Array.from(allVideos).map(getElementInfo),
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight
            }
          };
        });

        console.log(`📊 Found ${containerInfo.recommendContainers.length} recommend containers`);
        console.log(`📊 Found ${containerInfo.videoContainers.length} video containers`);
        console.log(`📊 Found ${containerInfo.videos.length} video elements`);
        console.log(`📊 Viewport: ${containerInfo.viewport.width}x${containerInfo.viewport.height}`);

        containerInfo.recommendContainers.forEach((container, i) => {
          const status = container.isFullyVisible ? '🟢 FULLY VISIBLE' :
                        container.isVisible ? '🟡 PARTIALLY VISIBLE' : '🔴 NOT VISIBLE';
          console.log(`  Recommend Container ${i}: ${status} (top: ${container.rect.top}, bottom: ${container.rect.bottom})`);
        });

        containerInfo.videoContainers.forEach((container, i) => {
          const status = container.isFullyVisible ? '🟢 FULLY VISIBLE' :
                        container.isVisible ? '🟡 PARTIALLY VISIBLE' : '🔴 NOT VISIBLE';
          console.log(`  Video Container ${i}: ${status} (top: ${container.rect.top}, bottom: ${container.rect.bottom})`);
        });

        containerInfo.videos.forEach((video, i) => {
          const status = video.isFullyVisible ? '🟢 FULLY VISIBLE' :
                        video.isVisible ? '🟡 PARTIALLY VISIBLE' : '🔴 NOT VISIBLE';
          console.log(`  Video Element ${i}: ${status} (top: ${video.rect.top}, bottom: ${video.rect.bottom})`);
        });

        return containerInfo;
      }
    };

    // Default action sequence if none provided
    const defaultActions = [
      ['goToForYou'],
      ['waitFor', 3000],
      ['clickVideo'],
      ['waitFor', 2000],
      ['screenshot', 'video-page.png'],
      ['nextVideo'],
      ['nextVideo'],
      ['screenshot', 'after-navigation.png']
    ];

    const sequence = actionList || defaultActions;

    console.log(`\n🎬 Running ${sequence.length} actions...\n`);

    for (let i = 0; i < sequence.length; i++) {
      const [actionName, ...args] = sequence[i];

      console.log(`\n--- Action ${i + 1}/${sequence.length}: ${actionName} ---`);

      if (actions[actionName]) {
        try {
          await actions[actionName](...args);
        } catch (error) {
          console.log(`⚠️ Action failed: ${error.message}`);
          if (actionName === 'navigate') {
            console.log('Continuing with next action...');
          }
        }
      } else {
        console.log(`❌ Unknown action: ${actionName}`);
      }
    }

    console.log('\n🎉 Action sequence completed!');
    console.log(`📍 Final page: ${page.url()}`);

    await browser.close();

  } catch (error) {
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      console.error('❌ Cannot connect to browser. Make sure development environment is running:');
      console.error('   ./dev-sample.js start');
    } else {
      console.error('❌ Action simulation failed:', error.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('🎮 Action Simulation Tool');
    console.log('Usage: node simulate-actions.js [preset]');
    console.log('');
    console.log('Available presets:');
    console.log('  default          Navigate to ForYou, click video, scroll, take screenshots');
    console.log('  scroll-test      Test video scrolling navigation');
    console.log('  like-test        Test liking videos');
    console.log('  navigation-test  Test different page navigation');
    console.log('');
    console.log('Custom actions can also be defined programmatically.');
    console.log('');
    console.log('Available actions:');
    console.log('  navigate(url)           - Go to URL');
    console.log('  clickFirst(selector)    - Click first matching element');
    console.log('  scroll(direction, num)  - Scroll up/down/page');
    console.log('  waitFor(ms)            - Wait milliseconds');
    console.log('  clickVideo()           - Click first video');
    console.log('  nextVideo()           - Navigate to next video');
    console.log('  like()                - Like current video');
    console.log('  screenshot(name)      - Take screenshot');
    return;
  }

  const preset = args[0] || 'default';
  let customSequence = null;

  switch (preset) {
    case 'scroll-test':
      customSequence = [
        ['goToForYou'],
        ['waitFor', 3000],
        ['dismissPopup'],
        ['screenshot', 'video-1.png'],
        ['scroll', 'down', 1],
        ['screenshot', 'video-2.png'],
        ['scroll', 'down', 1],
        ['screenshot', 'video-3.png'],
        ['scroll', 'down', 1],
        ['screenshot', 'video-4.png'],
        ['scroll', 'down', 1],
        ['screenshot', 'video-5.png']
      ];
      break;

    case 'like-test':
      customSequence = [
        ['goToForYou'],
        ['waitFor', 3000],
        ['dismissPopup'],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like'],
        ['scroll', 'down', 1],
        ['like']
      ];
      break;

    case 'navigation-test':
      customSequence = [
        ['navigate', 'https://www.tiktok.com'],
        ['waitFor', 2000],
        ['screenshot', 'homepage.png'],
        ['goToForYou'],
        ['waitFor', 2000],
        ['screenshot', 'foryou.png'],
        ['clickVideo'],
        ['waitFor', 2000],
        ['screenshot', 'video-page.png']
      ];
      break;

    case 'inspect':
      customSequence = [
        ['goToForYou'],
        ['waitFor', 3000],
        ['dismissPopup'],
        ['inspectVideoContainers'],
        ['screenshot', 'inspection.png']
      ];
      break;

    case 'default':
    default:
      customSequence = null; // Use default
      break;
  }

  console.log(`🎯 Running preset: ${preset}`);
  await simulateActions(customSequence);
}

if (require.main === module) {
  main();
}

module.exports = { simulateActions };