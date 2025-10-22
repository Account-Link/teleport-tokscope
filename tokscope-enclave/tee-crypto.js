/**
 * TEE Cryptography Utilities
 * Handles cookie encryption/decryption with TEE-derived keys
 */

const crypto = require('crypto');

class TEECrypto {
  constructor() {
    // TEE-derived encryption key (AES-256-GCM)
    // In production, this would be derived from Dstack SDK or hardware TEE
    // For now, using environment variable or default (for staging/testing)
    const keyMaterial = process.env.TEE_ENCRYPTION_KEY || 'tee-enclave-key-material-32chars';

    // Derive 32-byte key via SHA-256
    this.encryptionKey = crypto.createHash('sha256').update(keyMaterial).digest();

    console.log('🔐 TEE crypto initialized (AES-256-GCM)');
  }

  /**
   * Encrypt cookies with TEE-derived key
   * @param {any} cookiesData - Cookies array or string
   * @returns {string} Hex-encoded encrypted data
   */
  encryptCookies(cookiesData) {
    try {
      // Convert to JSON string
      const plaintext = JSON.stringify(cookiesData);

      // Generate random IV (12 bytes for GCM)
      const iv = crypto.randomBytes(12);

      // Create cipher
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

      // Encrypt data
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      // Get authentication tag
      const authTag = cipher.getAuthTag();

      // Combine: IV (12) + AuthTag (16) + Ciphertext
      const combined = Buffer.concat([iv, authTag, encrypted]);

      // Return as hex string
      return combined.toString('hex');

    } catch (error) {
      console.error('Cookie encryption failed:', error);
      throw new Error('TEE encryption failed');
    }
  }

  /**
   * Decrypt cookies with TEE-derived key
   * @param {string} encryptedHex - Hex-encoded encrypted data
   * @returns {any} Decrypted cookies data
   */
  decryptCookies(encryptedHex) {
    try {
      // Convert from hex
      const combined = Buffer.from(encryptedHex, 'hex');

      // Extract components
      const iv = combined.slice(0, 12);
      const authTag = combined.slice(12, 28);
      const encrypted = combined.slice(28);

      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      // Parse JSON
      return JSON.parse(decrypted.toString('utf8'));

    } catch (error) {
      console.error('Cookie decryption failed:', error);
      throw new Error('TEE decryption failed');
    }
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
