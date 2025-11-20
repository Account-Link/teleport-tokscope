import { Page } from 'playwright';
import jsQR from 'jsqr';
import { QRPerformanceTracker } from './metrics/QRPerformanceTracker';
import { QRMetricsCollector } from './metrics/QRMetricsCollector';

class QRExtractor {
  static async extractQRCodeFromPage(page: Page, sessionId: string | null = null): Promise<{ image: string, decodedUrl: string | null, error?: string }> {
    // Create performance tracker for this session
    const performanceTracker = new QRPerformanceTracker(sessionId);
    performanceTracker.mark('total_start');
    performanceTracker.mark('qrExtraction_start');

    const startTime = Date.now();

    try {
      console.log('Current page URL:', page.url());

      // DISABLED: Network idle check - extraction retries handle slow page loads (saves 0-10s)
      // Re-enable if you see extraction failing on slow connections
      /*
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
        console.log('Page network idle, waiting for QR to load...');
      } catch (err) {
        console.log('Network idle timeout, proceeding anyway...');
      }
      */

      // DISABLED: Placeholder check - validation rejects wrong QRs now (saves 10s guaranteed)
      // Re-enable if you see promotional/download QR codes being returned to users
      /*
      // Wait for IMG src to change from placeholder to actual QR
      // Placeholder: c4c40812758dc8175106.png
      // Real QR: will be different (data URL or different CDN URL)
      try {
        await page.waitForFunction(() => {
          const imgs = document.querySelectorAll('img');
          for (const img of imgs) {
            if (img.naturalWidth > 100 && img.naturalWidth === img.naturalHeight) {
              // Check if it's NOT the placeholder
              if (!img.src.includes('c4c40812758dc8175106.png') &&
                  !img.src.includes('webapp-login-page')) {
                return true;
              }
            }
          }
          return false;
        }, { timeout: 10000 });
        console.log('Real QR image detected (not placeholder)');
        await page.waitForTimeout(1000); // Extra time for full load
      } catch (err) {
        console.log('⚠️ Timeout waiting for real QR, attempting extraction anyway...');
      }
      */

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
        return await page.evaluate(async () => {
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

        // OPTIMIZATION: Skip IMG if no Canvas found yet
        // Canvas contains the real login QR (fast, no CORS needed)
        // IMG is usually promotional QR (slow CORS load, 57+ seconds)
        // Strategy: Wait for Canvas to render instead of processing IMG
        if (images.length > 0 && canvases.length === 0) {
          console.log('⏭️  Skipping IMG elements - waiting for Canvas to render (optimization)');
          console.log(`   Found ${images.length} IMG but 0 Canvas - will retry`);
          return null; // Trigger retry loop to wait for Canvas
        }

        // Check all square images (potential QR codes) and DECODE them
        for (const img of images) {
          // Only check images that could be QR codes (square, reasonable size)
          if (!img.src || !img.complete || img.naturalWidth < 100) continue;
          if (img.naturalWidth !== img.naturalHeight) continue; // QR codes are square

          try {
            // FIX: Load image with CORS to avoid canvas tainting
            // This allows us to access pixel data via getImageData()
            const imgElement = new Image();
            imgElement.crossOrigin = 'anonymous';
            imgElement.src = img.src;

            // Wait for CORS-enabled image to load (max 2s timeout)
            await new Promise<void>((resolve, reject) => {
              imgElement.onload = () => resolve();
              imgElement.onerror = () => reject(new Error('CORS image load failed'));
              setTimeout(() => reject(new Error('CORS image load timeout')), 2000);
            });

            // Draw CORS-enabled image to canvas to get imageData for decoding
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;

            canvas.width = imgElement.naturalWidth;
            canvas.height = imgElement.naturalHeight;
            ctx.drawImage(imgElement, 0, 0);

            // Get imageData for QR decoding (now works without CORS error!)
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            // Try to get dataUrl too
            const dataUrl = canvas.toDataURL('image/png');

            console.log(`✅ Extracted imageData with CORS from: ${img.src.substring(0, 100)} (${imgElement.naturalWidth}x${imgElement.naturalHeight})`);

            return {
              dataUrl: dataUrl || img.src,
              imageData: {
                data: Array.from(imageData.data),
                width: imageData.width,
                height: imageData.height
              }
            };
          } catch (e) {
            console.log('Failed to extract imageData from img with CORS:', e);
            // If CORS extraction fails, return the src as fallback
            if (img.src) {
              return { dataUrl: img.src, imageData: null };
            }
          }
        }

          return null;
        });
      };

      // Simple 30-retry strategy: works reliably for img.complete timing
      let qrData = await attemptExtraction();
      let extractionAttempts = 0;
      const maxExtractionAttempts = 30;

      // If first attempt failed, retry up to 30 times with 0.2s intervals (max 6s total)
      while (!qrData && extractionAttempts < maxExtractionAttempts) {
        extractionAttempts++;
        console.log(`⚠️ Extraction attempt ${extractionAttempts}/${maxExtractionAttempts} failed, retrying in 0.2s...`);
        await page.waitForTimeout(200);
        qrData = await attemptExtraction();
      }

      // If retry also failed, take screenshot as final fallback
      if (!qrData) {
        performanceTracker.mark('qrExtraction_end');
        performanceTracker.markFailure(new Error('All 30 extraction attempts exhausted'));

        console.log('❌ Retry also failed, taking screenshot as final fallback');
        const screenshotBuffer = await page.screenshot();
        const screenshot = screenshotBuffer.toString('base64');

        // Log metrics even on failure
        performanceTracker.mark('total_end');
        const report = performanceTracker.logReport();
        QRMetricsCollector.logSession(report);

        return {
          image: `data:image/png;base64,${screenshot}`,
          decodedUrl: null,
          error: 'QR extraction failed after 30 retries'
        };
      }

      // Mark successful extraction
      performanceTracker.mark('qrExtraction_end');
      performanceTracker.markSuccess();
      console.log(`✅ QR extraction succeeded after ${extractionAttempts + 1} attempts`);

      // Validate QR in a loop with retries
      let validationAttempts = 0;
      const maxValidationAttempts = 3;

      while (validationAttempts < maxValidationAttempts) {
        validationAttempts++;
        console.log(`Validation attempt ${validationAttempts}/${maxValidationAttempts}`);

        const validationResult = await validateQRData(qrData);

        if (validationResult.valid) {
          console.log('✅ QR validation passed!');

          // Mark total end and log report
          performanceTracker.mark('cookieDetection_start'); // Placeholder for now
          performanceTracker.mark('total_end');
          const report = performanceTracker.logReport();
          QRMetricsCollector.logSession(report);

          return {
            image: qrData.dataUrl,
            decodedUrl: validationResult.decodedUrl
          };
        }

        console.log(`⚠️ Validation failed: ${validationResult.reason}`);

        if (validationAttempts < maxValidationAttempts) {
          console.log(`Waiting 0.2s for real QR to load, then retrying...`);
          await page.waitForTimeout(200);
          qrData = await attemptExtraction();
          if (!qrData) {
            console.log('❌ Re-extraction failed');
            break;
          }
        }
      }

      // All validation attempts failed
      console.log('❌ All validation attempts exhausted, taking screenshot fallback');
      performanceTracker.mark('qrExtraction_end');
      performanceTracker.markFailure(new Error('QR validation failed'));
      performanceTracker.mark('total_end');
      const report = performanceTracker.logReport();
      QRMetricsCollector.logSession(report);

      const screenshotBuffer = await page.screenshot();
      const screenshot = screenshotBuffer.toString('base64');
      return {
        image: `data:image/png;base64,${screenshot}`,
        decodedUrl: null,
        error: 'QR validation failed after multiple attempts'
      };

      // Helper function to validate QR data
      async function validateQRData(qrData: any): Promise<{ valid: boolean, decodedUrl: string | null, reason?: string }> {
        // Try to decode the QR code if we have imageData
        let decodedUrl = null;

        if (!qrData.imageData) {
          return { valid: false, decodedUrl: null, reason: 'No imageData available' };
        }

        try {
          const code = jsQR(
            new Uint8ClampedArray(qrData.imageData.data),
            qrData.imageData.width,
            qrData.imageData.height
          );

          if (!code) {
            return { valid: false, decodedUrl: null, reason: 'Could not decode QR code' };
          }

          decodedUrl = code.data;
          console.log('✅ QR code decoded successfully');
          console.log(`🔗 QR URL: ${decodedUrl}`);

          // Validate it's a TikTok LOGIN URL (not download/promotional)
          const isTikTokDomain = decodedUrl.includes('tiktok.com');
          const isLoginQR = decodedUrl.includes('/t/') || // Short link for login
                           decodedUrl.includes('/login/') ||
                           decodedUrl.includes('/qr/authorize') ||
                           decodedUrl.includes('/authorize?');
          const isDownloadQR = decodedUrl.includes('/download-link/') ||
                              decodedUrl.includes('/download') ||
                              decodedUrl.includes('apps.apple.com') ||
                              decodedUrl.includes('play.google.com') ||
                              decodedUrl.includes('oneink.me'); // oneink.me is promotional

          console.log(`   isTikTokDomain=${isTikTokDomain}, isLoginQR=${isLoginQR}, isDownloadQR=${isDownloadQR}`);

          if (!isTikTokDomain) {
            return { valid: false, decodedUrl: null, reason: `Not a TikTok domain: ${decodedUrl}` };
          }

          if (!isLoginQR) {
            return { valid: false, decodedUrl: null, reason: `Not a login QR pattern: ${decodedUrl}` };
          }

          if (isDownloadQR) {
            return { valid: false, decodedUrl: null, reason: `Download/promotional QR: ${decodedUrl}` };
          }

          // All checks passed!
          return { valid: true, decodedUrl: decodedUrl };

        } catch (decodeError) {
          console.error('QR decode error:', decodeError);
          return { valid: false, decodedUrl: null, reason: `Decode error: ${decodeError}` };
        }
      }

    } catch (error: any) {
      console.error('QR extraction failed:', error);

      // Log metrics even on catastrophic failure
      performanceTracker.mark('qrExtraction_end');
      performanceTracker.mark('total_end');
      performanceTracker.markFailure(error);
      const report = performanceTracker.logReport();
      QRMetricsCollector.logSession(report);

      throw error;
    }
  }
}

export = QRExtractor;