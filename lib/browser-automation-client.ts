import { chromium, Browser, Page, BrowserContext } from 'playwright';

interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

interface User {
  username?: string;
  sec_user_id?: string;
  nickname?: string;
  uid?: string;
}

interface SessionData {
  user?: User;
  cookies?: Cookie[];
  tokens?: any;
  metadata?: any;
}

interface VideoData {
  id: string;
  description: string;
  author: string;
  url: string;
  method: string;
}

interface Options {
  cdpUrl?: string;
}

class BrowserAutomationClient {
  private sessionData: SessionData;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdpUrl: string;
  private forYouVideos: VideoData[] = [];
  private watchHistoryVideos: VideoData[] = [];

  constructor(sessionData: SessionData, options: Options = {}) {
    this.sessionData = sessionData;
    this.cdpUrl = options.cdpUrl || 'http://127.0.0.1:9222';
  }

  async initialize(): Promise<void> {
    console.log(`🚀 Initializing Browser Automation for user @${this.sessionData?.user?.username || 'anonymous (--loggedout)'}`);

    await this.connectToBrowser();
    await this.loadSessionCookies();

    console.log('✅ Browser automation initialized');
  }

  private async connectToBrowser(): Promise<void> {
    console.log(`🔌 Connecting to browser via CDP: ${this.cdpUrl}...`);
    this.browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 10000 });

    const contexts = this.browser.contexts();
    const context = contexts[0] || await this.browser.newContext();

    const pages = context.pages();
    this.page = pages[0] || await context.newPage();

    this.page.setDefaultTimeout(30000);
    this.page.setDefaultNavigationTimeout(30000);

    await this.setupNetworkInterception();
    console.log('✅ Connected to browser automation');
  }

  private async setupNetworkInterception(): Promise<void> {
    if (!this.page) return;

    console.log('🕸️ Setting up network interception...');

    this.page.on('response', async response => {
      const url = response.url();

      // For You feed interception
      if ((url.includes('/api/preload/item_list/') || url.includes('/api/post/item_list/') || url.includes('/api/recommend/item_list/')) &&
          (url.includes('from_page=fyp') || url.includes('recommendType=0') || url.includes('/api/recommend/item_list/'))) {
        try {
          const data = await response.json();
          if (data.itemList && Array.isArray(data.itemList)) {
            console.log(`📱 Captured ${data.itemList.length} For You videos from ${url.includes('preload') ? 'preload' : 'post'} API`);

            data.itemList.forEach((item: any) => {
              if (item.id && !this.forYouVideos.find(v => v.id === item.id)) {
                this.forYouVideos.push({
                  id: item.id,
                  description: item.desc || '',
                  author: item.author?.uniqueId || '',
                  url: item.author?.uniqueId ? `https://www.tiktok.com/@${item.author.uniqueId}/video/${item.id}` : `https://www.tiktok.com/video/${item.id}`,
                  method: 'foryou_api'
                });
              }
            });
          }
        } catch (error) {
          console.log('⚠️ Failed to parse For You API response');
        }
      }

      // Watch history interception
      if (url.includes('/tiktok/watch/history/list/')) {
        try {
          const data = await response.json();
          if (data.aweme_list && Array.isArray(data.aweme_list)) {
            console.log(`📜 Captured ${data.aweme_list.length} Watch History videos from API`);

            data.aweme_list.forEach((item: any) => {
              if (item.aweme_id && !this.watchHistoryVideos.find(v => v.id === item.aweme_id)) {
                this.watchHistoryVideos.push({
                  id: item.aweme_id,
                  description: item.desc || '',
                  author: item.author?.unique_id || '',
                  url: item.author?.unique_id ? `https://www.tiktok.com/@${item.author.unique_id}/video/${item.aweme_id}` : `https://www.tiktok.com/video/${item.aweme_id}`,
                  method: 'history_api'
                });
              }
            });
          }
        } catch (error) {
          console.log('⚠️ Failed to parse Watch History API response');
        }
      }
    });
  }

  private async loadSessionCookies(): Promise<void> {
    if (!this.page) return;

    console.log('🍪 Loading session cookies...');

    if (this.sessionData?.cookies?.length) {
      await this.page.context().addCookies(this.sessionData.cookies);
      console.log(`✅ Loaded ${this.sessionData.cookies.length} session cookies`);
    } else {
      console.log('⚠️ No session cookies provided (--loggedout mode)');
    }
  }

  async navigateToTikTok(): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log('🌐 Navigating to TikTok...');
    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded' });
    console.log('✅ Navigated to TikTok For You page');
  }

  async sampleForYouFeed(targetVideoCount = 10): Promise<VideoData[]> {
    if (!this.page) throw new Error('Browser not initialized');

    // For small requests (<=5), optimize by limiting scrolls
    const maxScrolls = targetVideoCount <= 5 ? targetVideoCount + 2 : Math.max(10, targetVideoCount);

    console.log(`📱 Starting For You feed sampling (target: ${targetVideoCount} videos)...`);

    this.forYouVideos = [];
    await this.navigateToTikTok();

    await new Promise(resolve => setTimeout(resolve, 3000));

    for (let i = 0; i < maxScrolls; i++) {
      // Early exit if we have enough videos for small requests
      if (targetVideoCount <= 5 && this.forYouVideos.length >= targetVideoCount) {
        console.log(`✅ Target reached: ${this.forYouVideos.length} videos captured`);
        break;
      }

      console.log(`📱 Scroll ${i + 1}/${maxScrolls}`);

      // Smooth scroll to next video container (2025-10-01: improved from ArrowDown)
      await this.page.evaluate(() => {
        const containers = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
        let currentVisibleIndex = -1;

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
          nextContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      if (i % 3 === 0) {
        console.log(`📊 Progress: ${this.forYouVideos.length} videos captured so far`);
      }
    }

    console.log(`✅ Sampling complete: ${this.forYouVideos.length} For You videos captured`);
    return this.forYouVideos;
  }

  async sampleWatchHistory(targetVideoCount = 10): Promise<VideoData[]> {
    if (!this.page) throw new Error('Browser not initialized');

    const maxScrolls = targetVideoCount <= 5 ? targetVideoCount + 2 : Math.max(10, targetVideoCount);

    console.log(`📜 Starting Watch History sampling (target: ${targetVideoCount} videos)...`);

    this.watchHistoryVideos = [];

    console.log('🌐 Navigating to Watch History page...');
    await this.page.goto('https://www.tiktok.com/tpp/watch-history', { waitUntil: 'domcontentloaded' });
    console.log('✅ Navigated to Watch History page');

    await new Promise(resolve => setTimeout(resolve, 5000));

    for (let i = 0; i < maxScrolls; i++) {
      if (targetVideoCount <= 5 && this.watchHistoryVideos.length >= targetVideoCount) {
        console.log(`✅ Target reached: ${this.watchHistoryVideos.length} videos captured`);
        break;
      }

      console.log(`📜 Scroll ${i + 1}/${maxScrolls}`);

      // Smooth scroll down page (2025-10-01: improved from fixed scrollBy)
      await this.page.evaluate(() => {
        window.scrollBy({ top: 1000, behavior: 'smooth' });
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      if (i % 3 === 0) {
        console.log(`📊 Progress: ${this.watchHistoryVideos.length} videos captured so far`);
      }
    }

    console.log(`✅ Sampling complete: ${this.watchHistoryVideos.length} Watch History videos captured`);
    return this.watchHistoryVideos;
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.browser) {
        await this.connectToBrowser();
      }

      if (!this.page) throw new Error('Page not available');

      await this.page.goto('https://www.tiktok.com', { timeout: 10000 });
      console.log('✅ Browser automation connection test successful');
      return true;
    } catch (error: any) {
      console.error(`❌ Browser automation test failed: ${error.message}`);
      return false;
    }
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up browser automation...');
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  // Static auth extraction methods
  static async extractUserData(page: Page): Promise<User> {
    const domResult = await page.evaluate(() => {
      try {
        const methods = [
          () => {
            const sigiState = (window as any).SIGI_STATE;
            if (sigiState?.UserModule?.currentUser) {
              const user = sigiState.UserModule.currentUser;
              return {
                sec_user_id: user.id,
                username: user.uniqueId,
                nickname: user.nickname,
                uid: user.uid || user.id
              };
            }
            return null;
          },
          () => {
            const universalEl = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (universalEl) {
              const data = JSON.parse(universalEl.textContent || '{}');
              const defaultScope = data['__DEFAULT_SCOPE__'];

              for (const [key, value] of Object.entries(defaultScope || {})) {
                const anyValue = value as any;
                if (anyValue?.userInfo?.user || anyValue?.userDetail?.user || anyValue?.user) {
                  const user = anyValue.userInfo?.user || anyValue.userDetail?.user || anyValue.user;
                  if (user?.id) {
                    return {
                      sec_user_id: user.id,
                      username: user.uniqueId || user.username,
                      nickname: user.nickname,
                      uid: user.uid || user.id
                    };
                  }
                }
              }
            }
            return null;
          }
        ];

        for (const method of methods) {
          try {
            const result = method();
            if (result && (result.sec_user_id || result.username)) {
              return result;
            }
          } catch (e) {
            // Continue to next method
          }
        }

        return null;
      } catch (error) {
        return null;
      }
    });

    if (domResult && (domResult.sec_user_id || domResult.username)) {
      return domResult;
    }

    return {
      sec_user_id: undefined,
      username: undefined,
      nickname: undefined,
      uid: undefined
    };
  }

  static extractTokensFromCookies(cookies: Cookie[]): any {
    const tokens: any = {};

    const importantCookies = [
      'sessionid', 'msToken', 'ttwid', 'tt_webid',
      'sid_guard', 'uid_tt', 'sid_tt', 'tt_token',
      'odin_tt', 'passport_csrf_token'
    ];

    cookies.forEach(cookie => {
      if (importantCookies.includes(cookie.name)) {
        tokens[cookie.name] = cookie.value;
      }
    });

    return tokens;
  }

  static generateDeviceIds(secUserId: string): any {
    const hash = require('crypto').createHash('sha256').update(secUserId || 'default').digest('hex');
    return {
      deviceId: hash.substring(0, 19),
      install_id: hash.substring(20, 39)
    };
  }

  static async extractAuthData(page: Page): Promise<SessionData> {
    // CRITICAL FIX (v3-m): Extract cookies FIRST, before any navigation
    // This matches v2.4 behavior that worked reliably for months
    // The /profile navigation was corrupting/losing cookies
    console.log('Extracting cookies from current page...');

    // Filter to TikTok domain only - prevents capturing Google NID from CAPTCHAs
    const cookies = await page.context().cookies(['https://www.tiktok.com']);
    const cookieNames = cookies.map(c => c.name);
    console.log(`Found ${cookies.length} TikTok cookies: ${cookieNames.join(', ') || 'none'}`);

    // Validate sessionid exists - fail fast if auth didn't work
    if (!cookieNames.includes('sessionid')) {
      console.error('Validation failed: missing sessionid');
      throw new Error('Auth failed: missing sessionid cookie');
    }
    console.log('Validation passed: sessionid present');

    // Now navigate to profile to extract user data
    // Cookies are already captured, so navigation issues won't affect them
    console.log('Navigating to profile for user data...');
    await page.goto('https://www.tiktok.com/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    const userData = await BrowserAutomationClient.extractUserData(page);
    const tokens = BrowserAutomationClient.extractTokensFromCookies(cookies);
    const deviceIds = BrowserAutomationClient.generateDeviceIds(userData.sec_user_id || '');

    console.log(`Auth complete: user=${userData.sec_user_id?.substring(0, 8)}..., cookies=${cookies.length}`);

    return {
      user: userData,
      cookies: cookies,  // Use cookies captured BEFORE navigation
      tokens: {
        ...tokens,
        device_id: deviceIds.deviceId,
        install_id: deviceIds.install_id
      },
      metadata: {
        extracted_at: new Date().toISOString(),
        user_agent: await page.evaluate(() => navigator.userAgent),
        extraction_method: 'browser-automation-client-v3m'
      }
    };
  }
}

export = BrowserAutomationClient;