/**
 * TEE Cryptography Utilities
 * Handles cookie encryption/decryption with TEE-derived keys
 *
 * Key lifecycle:
 * 1. Constructor: starts with fallback key (for staging or until DStack initializes)
 * 2. setDStackKey(): called by initDStack() after TEE key derivation succeeds
 * 3. All encrypt/decrypt operations use this.encryptionKey (whichever is active)
 * 4. decryptCookiesWithFallback(): tries current key, falls back to hardcoded key
 */

const crypto = require('crypto');

const FALLBACK_KEY_MATERIAL = process.env.FALLBACK_KEY_MATERIAL;
if (!FALLBACK_KEY_MATERIAL) {
  console.error('FATAL: FALLBACK_KEY_MATERIAL environment variable is required.');
  console.error('This key is used for cookie encryption fallback when DStack is not initialized.');
  process.exit(1);
}

class TEECrypto {
  constructor() {
    // Start with fallback key (for staging or until DStack initializes)
    const keyMaterial = process.env.TEE_ENCRYPTION_KEY || FALLBACK_KEY_MATERIAL;
    this.encryptionKey = crypto.createHash('sha256').update(keyMaterial).digest();
    this._usingDStackKey = false;
    console.log('🔐 TEE crypto initialized with fallback key (awaiting DStack)');
  }

  /**
   * Upgrade encryption key to DStack-derived key
   * Called by initDStack() in server.ts after successful TEE key derivation
   */
  setDStackKey(derivedKeyBuffer) {
    this.encryptionKey = derivedKeyBuffer;
    this._usingDStackKey = true;
    console.log('🔐 TEE crypto upgraded to DStack-derived key');
  }

  /**
   * Check if currently using DStack-derived key
   */
  isDStackKey() {
    return this._usingDStackKey === true;
  }

  /**
   * Encrypt cookies with current key (AES-256-GCM)
   * @param {any} cookiesData - Cookies array or string
   * @returns {string} Hex-encoded encrypted data
   */
  encryptCookies(cookiesData) {
    try {
      const plaintext = JSON.stringify(cookiesData);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      const authTag = cipher.getAuthTag();

      // Wire format: IV (12) + AuthTag (16) + Ciphertext
      const combined = Buffer.concat([iv, authTag, encrypted]);
      return combined.toString('hex');
    } catch (error) {
      console.error('Cookie encryption failed:', error);
      throw new Error('TEE encryption failed');
    }
  }

  /**
   * Decrypt cookies with current key (AES-256-GCM)
   * @param {string} encryptedHex - Hex-encoded encrypted data
   * @returns {any} Decrypted cookies data
   */
  decryptCookies(encryptedHex) {
    try {
      const combined = Buffer.from(encryptedHex, 'hex');
      const iv = combined.slice(0, 12);
      const authTag = combined.slice(12, 28);
      const encrypted = combined.slice(28);

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      console.error('Cookie decryption failed:', error);
      throw new Error('TEE decryption failed');
    }
  }

  /**
   * Try current key first, fall back to hardcoded key if DStack key fails.
   * Used on decrypt paths so existing fallback-encrypted cookies still work
   * after DStack key is active.
   */
  decryptCookiesWithFallback(encryptedHex) {
    try {
      return this.decryptCookies(encryptedHex);
    } catch (e) {
      if (this._usingDStackKey) {
        console.log('⚠️ DStack key failed, trying fallback key...');
        return this._decryptWithFallbackKey(encryptedHex);
      }
      throw e;
    }
  }

  /**
   * Check if data can be decrypted with the hardcoded fallback key.
   * Used by verify-encryption to classify cookies.
   */
  canDecryptWithFallback(encryptedHex) {
    try {
      this._decryptWithFallbackKey(encryptedHex);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Decrypt with the hardcoded fallback key (for migration/verification)
   */
  _decryptWithFallbackKey(encryptedHex) {
    const fallbackKey = crypto.createHash('sha256').update(FALLBACK_KEY_MATERIAL).digest();
    const combined = Buffer.from(encryptedHex, 'hex');
    const iv = combined.slice(0, 12);
    const authTag = combined.slice(12, 28);
    const encrypted = combined.slice(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', fallbackKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return JSON.parse(decrypted.toString('utf8'));
  }

  /**
   * Test encryption/decryption roundtrip
   */
  test() {
    const testData = {
      cookies: [
        { name: 'sessionid', value: 'test123', domain: '.tiktok.com' },
        { name: 'msToken', value: 'abc456', domain: '.tiktok.com' }
      ]
    };

    console.log('🧪 Testing TEE crypto...');
    const encrypted = this.encryptCookies(testData);
    console.log(`  Encrypted (${encrypted.length} chars): ${encrypted.substring(0, 32)}...`);

    const decrypted = this.decryptCookies(encrypted);
    console.log(`  Decrypted:`, decrypted);

    const match = JSON.stringify(testData) === JSON.stringify(decrypted);
    console.log(`  Roundtrip test: ${match ? '✅ PASS' : '❌ FAIL'}`);

    return match;
  }
}

// Export singleton
module.exports = new TEECrypto();
