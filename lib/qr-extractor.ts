import { Page } from 'playwright';
import jsQR from 'jsqr';

class QRExtractor {
  static async extractQRCodeFromPage(page: Page): Promise<{ image: string, decodedUrl: string | null, error?: string }> {
    try {
      console.log('Current page URL:', page.url());

      // Wait specifically for canvas element (not images which might be CDN placeholders)
      try {
        await page.waitForSelector('canvas', {
          timeout: 8000,
          state: 'visible'
        });
        console.log('Canvas element found, waiting for render...');
        await page.waitForTimeout(1000); // Give canvas time to render content
      } catch (err) {
        console.log('No canvas found, page might be blocked or redirected');
      }

      // Helper function to attempt QR extraction from DOM
      const attemptExtraction = async () => {
        // Get DOM inspection data
        const domInspection = await page.evaluate(() => {
          const qrRelated = document.querySelectorAll('[class*="qr"], [id*="qr"], [class*="QR"], [id*="QR"]');
          const allImages = document.querySelectorAll('img');
          return {
            title: document.title,
            readyState: document.readyState,
            totalElements: document.querySelectorAll('*').length,
            canvasCount: document.querySelectorAll('canvas').length,
            imgCount: allImages.length,
            qrRelatedCount: qrRelated.length,
            bodyLength: document.body?.innerHTML?.length || 0,
            qrElements: Array.from(qrRelated).slice(0, 5).map(el => ({
              tag: el.tagName,
              id: el.id,
              class: el.className
            })),
            // LOG ALL IMAGES - especially that 1 IMG!
            allImagesInfo: Array.from(allImages).map(img => ({
              src: img.src?.substring(0, 150),
              alt: img.alt,
              width: img.naturalWidth,
              height: img.naturalHeight,
              class: img.className
            }))
          };
        });

        // Log it in Node.js context (will show in docker logs)
        console.log('=== DOM INSPECTION ===');
        console.log('Document title:', domInspection.title);
        console.log('Page readyState:', domInspection.readyState);
        console.log('Total elements:', domInspection.totalElements);
        console.log('Canvas elements:', domInspection.canvasCount);
        console.log('IMG elements:', domInspection.imgCount);
        console.log('QR-related elements:', domInspection.qrRelatedCount);
        console.log('Body innerHTML length:', domInspection.bodyLength);
        console.log('QR elements sample:', JSON.stringify(domInspection.qrElements, null, 2));
        console.log('ALL IMAGES INFO:', JSON.stringify(domInspection.allImagesInfo, null, 2));
        console.log('==================');

        // Now do actual extraction
        return await page.evaluate(() => {
        // Method 1: Canvas element (get both dataUrl and imageData)
        const canvases = document.querySelectorAll('canvas');
        console.log(`Found ${canvases.length} canvas elements`);
        for (const canvas of canvases) {
          if (canvas.width > 100 && canvas.height > 100) { // QR codes are usually square and decent size
            try {
              const dataUrl = canvas.toDataURL('image/png');
              if (dataUrl && dataUrl.length > 100) {
                // Also get imageData for QR decoding
                const ctx = canvas.getContext('2d');
                if (!ctx) continue;
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                return {
                  dataUrl: dataUrl,
                  imageData: {
                    data: Array.from(imageData.data),
                    width: imageData.width,
                    height: imageData.height
                  }
                };
              }
            } catch (e) {
              console.log('Canvas extraction failed:', e);
            }
          }
        }

        // Method 2: Image elements - DECODE ALL SQUARE IMAGES to verify they're login QR codes
        // TikTok now serves QR codes as tiktokcdn img tags, not canvas!
        const images = document.querySelectorAll('img');
        console.log(`Found ${images.length} img elements`);

        // Check all square images (potential QR codes) and DECODE them
        for (const img of images) {
          // Only check images that could be QR codes (square, reasonable size)
          if (!img.src || !img.complete || img.naturalWidth < 100) continue;
          if (img.naturalWidth !== img.naturalHeight) continue; // QR codes are square

          try {
            // Draw image to canvas to get imageData for decoding
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;

            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);

            // Get imageData for QR decoding
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            // Try to get dataUrl too
            const dataUrl = canvas.toDataURL('image/png');

            console.log(`Checking square image: ${img.src.substring(0, 100)} (${img.naturalWidth}x${img.naturalHeight})`);

            return {
              dataUrl: dataUrl || img.src,
              imageData: {
                data: Array.from(imageData.data),
                width: imageData.width,
                height: imageData.height
              }
            };
          } catch (e) {
            console.log('Failed to extract imageData from img:', e);
            // If canvas extraction fails, return the src as fallback
            if (img.src) {
              return { dataUrl: img.src, imageData: null };
            }
          }
        }

          return null;
        });
      };

      // First attempt at extraction
      let qrData = await attemptExtraction();

      // If first attempt failed, wait and retry once
      if (!qrData) {
        console.log('⚠️ First extraction attempt failed, waiting 2 seconds and retrying...');
        await page.waitForTimeout(2000);
        qrData = await attemptExtraction();
      }

      // If retry also failed, take screenshot as final fallback
      if (!qrData) {
        console.log('❌ Retry also failed, taking screenshot as final fallback');
        const screenshotBuffer = await page.screenshot();
        const screenshot = screenshotBuffer.toString('base64');
        return {
          image: `data:image/png;base64,${screenshot}`,
          decodedUrl: null
        };
      }

      // Try to decode the QR code if we have imageData
      let decodedUrl = null;
      if (qrData.imageData) {
        try {
          const code = jsQR(
            new Uint8ClampedArray(qrData.imageData.data),
            qrData.imageData.width,
            qrData.imageData.height
          );

          if (code) {
            decodedUrl = code.data;
            console.log('✅ QR code decoded successfully');
            console.log(`🔗 QR URL: ${decodedUrl}`);

            // Validate it's a TikTok login URL
            if (!decodedUrl.includes('tiktok.com')) {
              console.log('⚠️ WARNING: Decoded URL is not a TikTok URL:', decodedUrl);
              decodedUrl = null;
            }
          } else {
            console.log('⚠️ Could not decode QR code');
          }
        } catch (decodeError) {
          console.error('QR decode error:', decodeError);
        }
      }

      // Check if we got a CDN image instead of actual QR data
      if (qrData.dataUrl && qrData.dataUrl.includes('tiktokcdn')) {
        console.log('⚠️ WARNING: Got CDN image URL instead of QR data:', qrData.dataUrl.substring(0, 100));
        console.log('This likely means the QR code is not properly rendered yet');

        // Don't return CDN images as they're not real QR codes - take screenshot as fallback
        const screenshotBuffer = await page.screenshot();
        const screenshot = screenshotBuffer.toString('base64');
        return {
          image: `data:image/png;base64,${screenshot}`,
          decodedUrl: null,
          error: 'Got static CDN image instead of dynamic QR'
        };
      }

      console.log('QR data extracted, image length:', qrData.dataUrl?.length || 0);
      return {
        image: qrData.dataUrl,
        decodedUrl: decodedUrl
      };

    } catch (error) {
      console.error('QR extraction failed:', error);
      throw error;
    }
  }
}

export = QRExtractor;