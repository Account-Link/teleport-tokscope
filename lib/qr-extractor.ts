import { Page } from 'playwright';

class QRExtractor {
  static async extractQRCodeFromPage(page: Page): Promise<string> {
    await page.waitForSelector('canvas, img, .qrcode, [class*="qr"], [id*="qr"]', {
      timeout: 10000
    });

    const qrData = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas');
      for (const canvas of canvases) {
        if (canvas.width > 100 && canvas.height > 100) {
          try {
            const dataUrl = canvas.toDataURL('image/png');
            if (dataUrl && dataUrl.length > 1000) {
              return dataUrl;
            }
          } catch (e) {
            console.log('Canvas extraction failed:', e);
          }
        }
      }

      const images = document.querySelectorAll('img');
      for (const img of images) {
        const src = img.src || '';
        const alt = img.alt || '';

        // SKIP CDN images - they are static placeholders!
        if (src.includes('tiktokcdn')) {
          console.log('Skipping CDN image:', src.substring(0, 80));
          continue;
        }

        if (alt.toLowerCase().includes('qr') ||
            src.includes('qr') ||
            src.includes('qrcode')) {
          return src;
        }

        if (img.naturalWidth === img.naturalHeight && img.naturalWidth > 100) {
          return src;
        }
      }

      return null;
    });

    if (!qrData) {
      throw new Error('No QR code found in page DOM');
    }

    return qrData;
  }
}

export = QRExtractor;