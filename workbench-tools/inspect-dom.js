#!/usr/bin/env node

/**
 * DOM Inspector for TikTok Development
 *
 * Connects to running browser and shows current page structure,
 * focusing on TikTok-specific elements and data attributes
 */

const { chromium } = require('playwright');

async function inspectCurrentState() {
  try {
    console.log('🔍 Connecting to development browser...');

    // Connect to running browser
    const thirdOctet = process.env.XORDI_SUBNET_THIRD_OCTET || '100';
    const browser = await chromium.connectOverCDP(`http://localhost:9223`, { timeout: 5000 });
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages();
    const page = pages?.[0];

    if (!page) {
      console.log('❌ No active page found. Make sure container is running and browser is open.');
      console.log('💡 Run: node coscroll.js start');
      return;
    }

    console.log(`📍 Current URL: ${page.url()}`);
    console.log(`📱 Page Title: ${await page.title()}`);

    // Get comprehensive page structure
    const analysis = await page.evaluate(() => {
      const result = {
        url: window.location.href,
        title: document.title,
        pageType: 'unknown',
        pageState: 'unknown',
        tiktokElements: [],
        videos: [],
        dataAttributes: new Set(),
        interactiveElements: [],
        structure: [],
        allElements: [],
        forms: [],
        loadingIndicators: []
      };

      // Helper to get element info
      const getElementInfo = (element, depth = 0) => {
        const rect = element.getBoundingClientRect();
        const styles = window.getComputedStyle(element);

        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          classes: Array.from(element.classList),
          dataE2e: element.getAttribute('data-e2e') || null,
          text: element.textContent?.slice(0, 100) || null,
          visible: rect.width > 0 && rect.height > 0 && styles.display !== 'none',
          position: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          href: element.href || null,
          src: element.src || null,
          depth
        };
      };

      // Detect page type and state
      const detectPageType = () => {
        const url = window.location.href;
        const pathname = window.location.pathname;

        if (url.includes('/login')) return 'login';
        if (url.includes('/signup')) return 'signup';
        if (url.includes('/foryou')) return 'foryou-feed';
        if (url.includes('/following')) return 'following-feed';
        if (url.includes('/video/')) return 'video-page';
        if (url.includes('/@') && !url.includes('/video/')) return 'profile';
        if (url.includes('/tpp/watch-history')) return 'watch-history';
        if (url.includes('/tpp/')) return 'privacy-settings';
        if (url.includes('/search')) return 'search';
        if (url.includes('/trending')) return 'trending';
        if (url.includes('/live')) return 'live';
        if (pathname === '/' || pathname === '') return 'homepage';

        return 'other';
      };

      const detectPageState = () => {
        const url = window.location.href;

        // Check for loading indicators
        if (document.querySelector('.loading') ||
            document.querySelector('[class*="loading"]') ||
            document.querySelector('[class*="Loading"]')) return 'loading';

        // Check for login/signup pages (these are normal, not errors)
        if (url.includes('/login') || url.includes('/signup')) {
          // Check if login page is functioning
          if (document.querySelector('[data-e2e="qr-code"]') ||
              document.querySelector('[data-e2e="login"]') ||
              document.querySelector('form') ||
              document.querySelector('input[type="email"]') ||
              document.querySelector('input[type="password"]')) {
            return 'login-ready';
          }
          return 'login-loading';
        }

        // Check for actual error states (not login pages)
        const bodyText = document.body ? document.body.textContent : '';
        if (document.querySelector('.error') ||
            document.querySelector('[class*="error"]') ||
            document.querySelector('[class*="Error"]') ||
            (bodyText && bodyText.includes('Try again')) ||
            (bodyText && bodyText.includes('Something went wrong')) ||
            (bodyText && bodyText.includes('Page not found')) ||
            (bodyText && bodyText.includes('Network error'))) return 'error';

        // Check if page seems empty (but exclude login pages)
        const visibleElements = document.querySelectorAll('*').length;
        if (visibleElements < 50) return 'minimal';

        // Check for common success indicators
        if (document.querySelector('video') ||
            document.querySelector('[data-e2e]') ||
            document.querySelector('main') ||
            document.querySelector('#app')) return 'loaded';

        return 'unknown';
      };

      result.pageType = detectPageType();
      result.pageState = detectPageState();

      // Collect all data-e2e attributes
      document.querySelectorAll('[data-e2e]').forEach(el => {
        result.dataAttributes.add(el.getAttribute('data-e2e'));
      });

      // Find TikTok-specific elements
      const tiktokSelectors = [
        '[data-e2e*="video"]',
        '[data-e2e*="recommend"]',
        '[data-e2e*="browse"]',
        '[data-e2e*="like"]',
        '[data-e2e*="comment"]',
        '[data-e2e*="share"]',
        '[data-e2e*="author"]',
        '[data-e2e*="desc"]',
        'video',
        '[class*="tiktok"]'
      ];

      tiktokSelectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            const info = getElementInfo(el);
            if (info.visible || info.dataE2e) {
              result.tiktokElements.push({ selector, ...info });
            }
          });
        } catch (e) {
          // Skip invalid selectors
        }
      });

      // Find videos specifically
      document.querySelectorAll('video').forEach(video => {
        result.videos.push({
          src: video.src || video.currentSrc || 'no src',
          duration: video.duration || 'unknown',
          paused: video.paused,
          currentTime: video.currentTime,
          muted: video.muted,
          visible: getElementInfo(video).visible,
          poster: video.poster || null
        });
      });

      // Find interactive elements
      document.querySelectorAll('button, a, [onclick], [role="button"]').forEach(el => {
        const info = getElementInfo(el);
        if (info.visible && (info.text || info.dataE2e)) {
          result.interactiveElements.push(info);
        }
      });

      // Find forms
      document.querySelectorAll('form, input, select, textarea').forEach(el => {
        const info = getElementInfo(el);
        if (info.visible) {
          result.forms.push({
            ...info,
            type: el.type || null,
            name: el.name || null,
            placeholder: el.placeholder || null,
            value: el.value ? (el.value.length > 50 ? el.value.slice(0, 50) + '...' : el.value) : null
          });
        }
      });

      // Find loading indicators
      document.querySelectorAll('[class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"], .loading').forEach(el => {
        const info = getElementInfo(el);
        result.loadingIndicators.push(info);
      });

      // Get ALL significant elements (not just TikTok-specific)
      const significantSelectors = [
        'main', 'section', 'article', 'div[class]', 'div[id]',
        'nav', 'header', 'footer', 'aside',
        'h1, h2, h3, h4, h5, h6',
        'p', 'span[class]', 'span[id]',
        'img', 'svg',
        '[role]', '[aria-label]',
        '[class*="container"]', '[class*="wrapper"]', '[class*="content"]',
        '[class*="page"]', '[class*="view"]', '[class*="panel"]'
      ];

      significantSelectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            const info = getElementInfo(el);
            if (info.visible && (info.text?.length > 2 || info.classes.length > 0 || info.id)) {
              result.allElements.push({ selector, ...info });
            }
          });
        } catch (e) {
          // Skip invalid selectors
        }
      });

      // Get basic page structure (top 3 levels)
      const getStructure = (element, depth = 0) => {
        if (depth > 2) return [];

        const items = [];
        Array.from(element.children).forEach(child => {
          const info = getElementInfo(child, depth);
          if (info.visible || info.dataE2e || depth === 0) {
            items.push(info);
            items.push(...getStructure(child, depth + 1));
          }
        });
        return items;
      };

      result.structure = getStructure(document.body);
      result.dataAttributes = Array.from(result.dataAttributes).sort();

      return result;
    });

    console.log('\n📊 Page Analysis:');
    console.log(`   🏷️  Page Type: ${analysis.pageType}`);
    console.log(`   ⚡ Page State: ${analysis.pageState}`);
    console.log(`   🎯 TikTok elements: ${analysis.tiktokElements.length}`);
    console.log(`   🎥 Videos found: ${analysis.videos.length}`);
    console.log(`   🔗 Interactive elements: ${analysis.interactiveElements.length}`);
    console.log(`   📝 Form elements: ${analysis.forms.length}`);
    console.log(`   ⏳ Loading indicators: ${analysis.loadingIndicators.length}`);
    console.log(`   📋 Data attributes: ${analysis.dataAttributes.length}`);
    console.log(`   🧩 Total significant elements: ${analysis.allElements.length}`);

    // Show videos
    if (analysis.videos.length > 0) {
      console.log('\n🎥 Videos Found:');
      analysis.videos.forEach((video, i) => {
        console.log(`   ${i + 1}. ${video.paused ? '⏸️' : '▶️'} Duration: ${typeof video.duration === 'number' ? Math.floor(video.duration) + 's' : video.duration}`);
        console.log(`      Visible: ${video.visible ? '✅' : '❌'} | Muted: ${video.muted ? '🔇' : '🔊'}`);
        if (video.src && video.src !== 'no src') {
          console.log(`      Source: ${video.src.slice(0, 80)}...`);
        }
      });
    }

    // Show TikTok elements
    console.log('\n🎯 TikTok Elements (data-e2e):');
    const uniqueDataE2e = [...new Set(analysis.tiktokElements.filter(el => el.dataE2e).map(el => el.dataE2e))];
    uniqueDataE2e.slice(0, 15).forEach(attr => {
      const elements = analysis.tiktokElements.filter(el => el.dataE2e === attr);
      const visible = elements.filter(el => el.visible).length;
      console.log(`   [data-e2e="${attr}"] (${visible}/${elements.length} visible)`);
    });

    if (uniqueDataE2e.length > 15) {
      console.log(`   ... and ${uniqueDataE2e.length - 15} more`);
    }

    // Show page-specific insights based on page state
    if (analysis.pageState === 'login-ready') {
      console.log('\n🔐 Login Page Ready:');
      console.log('   TikTok login page is loaded and ready for authentication.');
      if (analysis.pageType === 'login' && Array.from(analysis.dataAttributes).includes('qr-code')) {
        console.log('   📱 QR code is available for mobile scanning.');
        console.log('   💡 Scan with TikTok mobile app or access via http://localhost:8080');
      }
    } else if (analysis.pageState === 'login-loading') {
      console.log('\n⏳ Login Page Loading:');
      console.log('   Login page is loading. QR code may appear shortly.');
    } else if (analysis.pageState === 'error') {
      console.log('\n❌ Error State Detected:');
      console.log('   The page appears to have encountered an error or failed to load properly.');
      if (analysis.interactiveElements.some(el => el.text?.includes('Try again'))) {
        console.log('   💡 There may be a "Try again" button available.');
      }
    } else if (analysis.pageState === 'loading') {
      console.log('\n⏳ Loading State Detected:');
      console.log('   The page appears to be still loading. Try running inspect again in a moment.');
    } else if (analysis.pageState === 'minimal') {
      console.log('\n⚠️  Minimal Content Detected:');
      console.log('   The page has very few elements. This could indicate:');
      console.log('   - Authentication required');
      console.log('   - Content blocked');
      console.log('   - Page still loading');
    }

    // Show forms if any
    if (analysis.forms.length > 0) {
      console.log('\n📝 Form Elements:');
      analysis.forms.slice(0, 5).forEach(form => {
        const identifier = form.name ? `[name="${form.name}"]` : form.id ? `[id="${form.id}"]` : `<${form.tag}>`;
        console.log(`   ${identifier}${form.type ? ` (${form.type})` : ''}${form.placeholder ? ` - "${form.placeholder}"` : ''}`);
      });
    }

    // Show interactive elements
    console.log('\n🔗 Interactive Elements:');
    if (analysis.interactiveElements.length === 0) {
      console.log('   No visible interactive elements found.');
    } else {
      analysis.interactiveElements.slice(0, 10).forEach(el => {
        const text = el.text?.trim().slice(0, 30) || 'no text';
        const identifier = el.dataE2e ? `[data-e2e="${el.dataE2e}"]` : `<${el.tag}>`;
        console.log(`   ${identifier}: "${text}"`);
      });
      if (analysis.interactiveElements.length > 10) {
        console.log(`   ... and ${analysis.interactiveElements.length - 10} more`);
      }
    }

    // Show significant elements summary
    if (analysis.allElements.length > 0) {
      console.log('\n🧩 Page Structure Summary:');
      const elementTypes = {};
      analysis.allElements.forEach(el => {
        const key = el.tag;
        elementTypes[key] = (elementTypes[key] || 0) + 1;
      });

      Object.entries(elementTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .forEach(([tag, count]) => {
          console.log(`   ${tag}: ${count} elements`);
        });
    }

    // All available data-e2e attributes
    if (process.argv.includes('--verbose') || process.argv.includes('-v')) {
      console.log('\n📋 All data-e2e attributes:');
      if (analysis.dataAttributes.length === 0) {
        console.log('   No data-e2e attributes found on this page.');
      } else {
        analysis.dataAttributes.forEach(attr => {
          console.log(`   - ${attr}`);
        });
      }

      console.log('\n🔍 Most Common Element Classes:');
      const classNames = new Map();
      analysis.allElements.forEach(el => {
        el.classes.forEach(cls => {
          if (cls.length > 2) { // Skip very short class names
            classNames.set(cls, (classNames.get(cls) || 0) + 1);
          }
        });
      });

      Array.from(classNames.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .forEach(([cls, count]) => {
          console.log(`   .${cls} (${count}x)`);
        });
    } else {
      console.log(`\n💡 Use --verbose to see all ${analysis.dataAttributes.length} data-e2e attributes and detailed class analysis`);
    }

    await browser.close();

  } catch (error) {
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      console.error('❌ Cannot connect to browser. Make sure development environment is running:');
      console.error('   ./dev-sample.js start');
    } else {
      console.error('❌ Inspection failed:', error.message);
    }
  }
}

if (require.main === module) {
  inspectCurrentState();
}

module.exports = { inspectCurrentState };