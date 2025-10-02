#!/usr/bin/env node

/**
 * Selector Testing Tool for TikTok Development
 *
 * Tests CSS selectors against the current page to help develop robust selectors
 */

const { chromium } = require('playwright');

async function testSelectors(selectorsToTest = null) {
  try {
    console.log('🧪 Connecting to development browser...');

    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const browser = await chromium.connectOverCDP(`http://localhost:9223`, { timeout: 5000 });
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages();
    const page = pages?.[0];

    if (!page) {
      console.log('❌ No active page found. Make sure development environment is running.');
      return;
    }

    console.log(`📍 Testing selectors on: ${page.url()}`);

    // Default selectors to test if none provided
    const defaultSelectors = [
      // Video selectors
      'video',
      '[data-e2e*="video"]',
      '[data-e2e="video-player"]',
      '[data-e2e="video-container"]',

      // Author selectors
      '[data-e2e="video-author-uniqueid"]',
      '[data-e2e="video-author-nickname"]',
      'a[href^="/@"]',

      // Description selectors
      '[data-e2e="video-desc"]',
      '[data-e2e="video-description"]',

      // Engagement selectors
      '[data-e2e="like-count"]',
      '[data-e2e="browse-like-count"]',
      '[data-e2e="comment-count"]',
      '[data-e2e="browse-comment-count"]',
      '[data-e2e="share-count"]',
      '[data-e2e="browse-share-count"]',

      // Navigation selectors
      '[data-e2e="recommend-list-item-container"]',
      '[data-e2e="recommend-list-item-container"] a',

      // Interactive elements
      'button[data-e2e*="like"]',
      'button[data-e2e*="comment"]',
      'button[data-e2e*="share"]'
    ];

    const selectors = selectorsToTest || defaultSelectors;

    console.log(`\n🔍 Testing ${selectors.length} selectors...\n`);

    const results = await page.evaluate((selectorsArray) => {
      return selectorsArray.map(selector => {
        try {
          const elements = document.querySelectorAll(selector);
          const result = {
            selector,
            found: elements.length,
            visible: 0,
            elements: []
          };

          Array.from(elements).forEach((el, index) => {
            if (index >= 3) return; // Limit to first 3 elements for details

            const rect = el.getBoundingClientRect();
            const styles = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && styles.display !== 'none';

            if (isVisible) result.visible++;

            result.elements.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              classes: Array.from(el.classList),
              text: el.textContent?.trim().slice(0, 50) || null,
              href: el.href || null,
              src: el.src || null,
              dataE2e: el.getAttribute('data-e2e') || null,
              visible: isVisible,
              position: isVisible ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null
            });
          });

          return result;
        } catch (error) {
          return {
            selector,
            error: error.message,
            found: 0,
            visible: 0,
            elements: []
          };
        }
      });
    }, selectors);

    // Display results
    results.forEach(result => {
      const status = result.error ? '❌ ERROR' :
                    result.found === 0 ? '❌ NOT FOUND' :
                    result.visible === 0 ? '⚠️  HIDDEN' : '✅ FOUND';

      console.log(`${status} ${result.selector}`);

      if (result.error) {
        console.log(`   Error: ${result.error}`);
      } else if (result.found > 0) {
        console.log(`   Elements: ${result.found} total, ${result.visible} visible`);

        result.elements.forEach((el, i) => {
          const visibleIcon = el.visible ? '👁️' : '👻';
          const text = el.text ? `"${el.text}"` : 'no text';
          const identifier = el.dataE2e ? `[data-e2e="${el.dataE2e}"]` :
                           el.id ? `#${el.id}` :
                           `<${el.tag}>`;

          console.log(`     ${i + 1}. ${visibleIcon} ${identifier} ${text}`);
          if (el.position) {
            console.log(`        Position: (${el.position.x}, ${el.position.y})`);
          }
        });

        if (result.found > result.elements.length) {
          console.log(`     ... and ${result.found - result.elements.length} more`);
        }
      }

      console.log('');
    });

    // Summary
    const successful = results.filter(r => !r.error && r.found > 0 && r.visible > 0).length;
    const found = results.filter(r => !r.error && r.found > 0).length;
    const errors = results.filter(r => r.error).length;

    console.log('📊 Test Summary:');
    console.log(`   ✅ Working selectors: ${successful}/${selectors.length}`);
    console.log(`   📄 Found but hidden: ${found - successful}`);
    console.log(`   ❌ Failed selectors: ${results.length - found - errors}`);
    console.log(`   🚫 Syntax errors: ${errors}`);

    // Suggestions for improvements
    const hidden = results.filter(r => !r.error && r.found > 0 && r.visible === 0);
    if (hidden.length > 0) {
      console.log('\n💡 Hidden elements found - page might not be fully loaded or elements are offscreen');
    }

    const notFound = results.filter(r => !r.error && r.found === 0);
    if (notFound.length > 0) {
      console.log('\n❓ Missing elements - page structure might have changed:');
      notFound.forEach(r => console.log(`   - ${r.selector}`));
    }

    await browser.close();

    return results;

  } catch (error) {
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      console.error('❌ Cannot connect to browser. Make sure development environment is running:');
      console.error('   ./dev-sample.js start');
    } else {
      console.error('❌ Selector testing failed:', error.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('🧪 Selector Testing Tool');
    console.log('Usage: node test-selectors.js [selector1] [selector2] ...');
    console.log('');
    console.log('Examples:');
    console.log('  node test-selectors.js                           # Test default TikTok selectors');
    console.log('  node test-selectors.js "video" "[data-e2e]"      # Test specific selectors');
    console.log('  node test-selectors.js \'button[data-e2e*="like"]\' # Test like buttons');
    console.log('');
    console.log('The tool will show:');
    console.log('  - How many elements match each selector');
    console.log('  - Which elements are visible vs hidden');
    console.log('  - Element details (text, attributes, position)');
    return;
  }

  let customSelectors = null;
  if (args.length > 0) {
    customSelectors = args;
    console.log('🎯 Testing custom selectors:', customSelectors.join(', '));
  }

  await testSelectors(customSelectors);
}

if (require.main === module) {
  main();
}

module.exports = { testSelectors };