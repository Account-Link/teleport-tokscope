import { chromium, Browser, BrowserContext, Page } from 'playwright';

interface BrowserConnection {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

class BrowserConnectionManager {
  static async connectToBrowser(cdpUrl = 'http://localhost:9222'): Promise<BrowserConnection> {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      console.log(`🌐 Connected to browser at ${cdpUrl}`);

      const contexts = browser.contexts();
      if (contexts.length === 0) {
        throw new Error('No browser contexts found');
      }

      const context = contexts[0];
      const pages = context.pages();
      if (pages.length === 0) {
        throw new Error('No pages found in browser context');
      }

      const page = pages[0];
      return { browser, context, page };

    } catch (error: any) {
      throw new Error(`Failed to connect to browser: ${error.message}`);
    }
  }
}

export = BrowserConnectionManager;