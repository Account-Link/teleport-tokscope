#!/usr/bin/env node

/**
 * Data Extraction Tester for TikTok Development
 *
 * Tests data extraction functions against the current page
 * Useful for developing and debugging sampling logic
 */

const { chromium } = require('playwright');

async function testDataExtraction(testMode = 'all') {
  try {
    console.log('🔬 Connecting to development browser...');

    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const browser = await chromium.connectOverCDP(`http://localhost:9223`, { timeout: 5000 });
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages();
    const page = pages?.[0];

    if (!page) {
      console.log('❌ No active page found. Make sure development environment is running.');
      return;
    }

    console.log(`📍 Testing data extraction on: ${page.url()}`);

    // Test the same extraction logic used in browser-automation-client.js
    const extractionResult = await page.evaluate(() => {
      const info = {
        id: null,
        desc: null,
        author: null,
        authorDetails: {
          id: null,
          uniqueId: null,
          nickname: null,
          avatarThumb: null
        },
        likes: 0,
        views: 0,
        shares: 0,
        comments: 0,
        stats: {
          diggCount: 0,
          shareCount: 0,
          commentCount: 0,
          playCount: 0,
          collectCount: 0
        },
        webUrl: window.location.href,
        url: window.location.href,
        createTime: Math.floor(Date.now() / 1000),
        // Additional debug info
        debug: {
          foundElements: {},
          extractionSteps: [],
          pageType: 'unknown'
        }
      };

      // Helper function to log extraction steps
      const logStep = (step, result) => {
        info.debug.extractionSteps.push({ step, result: result || 'not found' });
      };

      // Determine page type
      if (window.location.href.includes('/video/')) {
        info.debug.pageType = 'video_page';
      } else if (window.location.href.includes('/foryou')) {
        info.debug.pageType = 'foryou_feed';
      } else if (window.location.href.includes('/@')) {
        info.debug.pageType = 'profile';
      }

      logStep('page_type_detected', info.debug.pageType);

      // Extract video ID from URL
      const urlMatch = window.location.href.match(/\/video\/(\d+)/);
      if (urlMatch) {
        info.id = urlMatch[1];
        logStep('video_id_from_url', info.id);
      }

      // Author extraction with multiple fallbacks
      const authorSelectors = [
        '[data-e2e="video-author-uniqueid"]',
        '[data-e2e="video-author-nickname"]',
        'a[href^="/@"]',
        '[data-e2e="browse-username"]'
      ];

      for (const sel of authorSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          const text = el.textContent.trim().replace('@', '');
          info.author = text;
          info.authorDetails.uniqueId = text;
          info.debug.foundElements.author = { selector: sel, text };
          logStep('author_found', `${sel}: ${text}`);
          break;
        }
      }

      // Nickname
      const nicknameEl = document.querySelector('[data-e2e="video-author-nickname"]');
      if (nicknameEl) {
        info.authorDetails.nickname = nicknameEl.textContent.trim();
        logStep('nickname_found', info.authorDetails.nickname);
      }

      // Description extraction
      const descSelectors = [
        '[data-e2e="video-desc"]',
        '[data-e2e="video-description"]',
        '[data-e2e="browse-video-desc"]'
      ];

      for (const sel of descSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          info.desc = el.textContent.trim();
          info.debug.foundElements.description = { selector: sel, text: info.desc.slice(0, 50) };
          logStep('description_found', `${sel}: ${info.desc.slice(0, 30)}...`);
          break;
        }
      }

      // Stats extraction with number parsing
      const parseCount = (text) => {
        if (!text) return 0;
        const clean = text.replace(/[^0-9.KMB]/gi, '');
        const num = parseFloat(clean);
        if (clean.includes('K')) return Math.floor(num * 1000);
        if (clean.includes('M')) return Math.floor(num * 1000000);
        if (clean.includes('B')) return Math.floor(num * 1000000000);
        return Math.floor(num || 0);
      };

      // Likes
      const likeSelectors = ['[data-e2e="like-count"]', '[data-e2e="browse-like-count"]'];
      for (const sel of likeSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const count = parseCount(el.textContent);
          info.likes = count;
          info.stats.diggCount = count;
          info.debug.foundElements.likes = { selector: sel, rawText: el.textContent, parsed: count };
          logStep('likes_found', `${sel}: ${el.textContent} → ${count}`);
          break;
        }
      }

      // Comments
      const commentSelectors = ['[data-e2e="comment-count"]', '[data-e2e="browse-comment-count"]'];
      for (const sel of commentSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const count = parseCount(el.textContent);
          info.comments = count;
          info.stats.commentCount = count;
          info.debug.foundElements.comments = { selector: sel, rawText: el.textContent, parsed: count };
          logStep('comments_found', `${sel}: ${el.textContent} → ${count}`);
          break;
        }
      }

      // Shares
      const shareSelectors = ['[data-e2e="share-count"]', '[data-e2e="browse-share-count"]'];
      for (const sel of shareSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const count = parseCount(el.textContent);
          info.shares = count;
          info.stats.shareCount = count;
          info.debug.foundElements.shares = { selector: sel, rawText: el.textContent, parsed: count };
          logStep('shares_found', `${sel}: ${el.textContent} → ${count}`);
          break;
        }
      }

      // Video info
      const videos = document.querySelectorAll('video');
      if (videos.length > 0) {
        const video = videos[0];
        info.debug.foundElements.video = {
          count: videos.length,
          duration: video.duration,
          currentTime: video.currentTime,
          paused: video.paused,
          src: video.src || video.currentSrc || 'no src'
        };
        logStep('video_found', `${videos.length} video(s), duration: ${video.duration}`);
      }

      return info;
    });

    // Display results
    console.log('\n📊 Extraction Results:');
    console.log(`   Page Type: ${extractionResult.debug.pageType}`);
    console.log(`   Video ID: ${extractionResult.id || 'not found'}`);
    console.log(`   Author: @${extractionResult.author || 'not found'}`);
    console.log(`   Nickname: ${extractionResult.authorDetails.nickname || 'not found'}`);
    console.log(`   Description: ${extractionResult.desc ? `"${extractionResult.desc.slice(0, 50)}..."` : 'not found'}`);

    console.log('\n📈 Stats:');
    console.log(`   Likes: ${extractionResult.likes.toLocaleString()}`);
    console.log(`   Comments: ${extractionResult.comments.toLocaleString()}`);
    console.log(`   Shares: ${extractionResult.shares.toLocaleString()}`);

    if (testMode === 'verbose' || testMode === 'debug') {
      console.log('\n🔍 Extraction Steps:');
      extractionResult.debug.extractionSteps.forEach((step, i) => {
        console.log(`   ${i + 1}. ${step.step}: ${step.result}`);
      });

      console.log('\n🎯 Found Elements:');
      Object.entries(extractionResult.debug.foundElements).forEach(([key, value]) => {
        console.log(`   ${key}:`, JSON.stringify(value, null, 4));
      });
    }

    // Quality assessment
    console.log('\n✅ Extraction Quality:');
    const hasId = !!extractionResult.id;
    const hasAuthor = !!extractionResult.author;
    const hasDesc = !!extractionResult.desc;
    const hasStats = extractionResult.likes > 0 || extractionResult.comments > 0 || extractionResult.shares > 0;

    console.log(`   Video ID: ${hasId ? '✅' : '❌'}`);
    console.log(`   Author: ${hasAuthor ? '✅' : '❌'}`);
    console.log(`   Description: ${hasDesc ? '✅' : '❌'}`);
    console.log(`   Stats: ${hasStats ? '✅' : '❌'}`);

    const score = [hasId, hasAuthor, hasDesc, hasStats].filter(Boolean).length;
    console.log(`   Overall: ${score}/4 (${Math.round(score/4*100)}%)`);

    if (score < 4) {
      console.log('\n💡 Suggestions:');
      if (!hasId) console.log('   - Check if you\'re on a video page with /video/ in URL');
      if (!hasAuthor) console.log('   - Author selectors might have changed');
      if (!hasDesc) console.log('   - Description selectors might need updating');
      if (!hasStats) console.log('   - Stats elements might not be loaded yet');
    }

    await browser.close();
    return extractionResult;

  } catch (error) {
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      console.error('❌ Cannot connect to browser. Make sure development environment is running:');
      console.error('   ./dev-sample.js start');
    } else {
      console.error('❌ Data extraction test failed:', error.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes('--verbose') || args.includes('-v') ? 'verbose' :
                  args.includes('--debug') || args.includes('-d') ? 'debug' : 'all';

  if (args.includes('--help') || args.includes('-h')) {
    console.log('🔬 Data Extraction Tester');
    console.log('Usage: node extract-data.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --verbose, -v    Show detailed extraction steps');
    console.log('  --debug, -d      Show all debug information');
    console.log('');
    console.log('This tool tests the same data extraction logic used in the main sampler.');
    console.log('It\'s useful for debugging when sampling isn\'t working correctly.');
    return;
  }

  await testDataExtraction(testMode);
}

if (require.main === module) {
  main();
}

module.exports = { testDataExtraction };