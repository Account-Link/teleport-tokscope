/**
 * Xordi Security Module - Python Subprocess Wrapper
 * Runs Python security service as subprocess in same container
 * Communication via stdin/stdout (IPC, not HTTP)
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class PythonSecurityModule {
  constructor() {
    this.pythonProcess = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.isReady = false;
  }

  async initialize() {
    if (this.isReady) return;

    console.log('🔧 Starting Python security service subprocess...');

    // Spawn Python subprocess
    this.pythonProcess = spawn('python3', [
      '/app/security-service/security_service_subprocess.py'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout, stderr
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'  // Disable Python buffering
      }
    });

    // Handle stderr (Python logging)
    this.pythonProcess.stderr.on('data', (data) => {
      console.log(`[Python Subprocess] ${data.toString().trim()}`);
    });

    // Handle stdout (responses)
    const rl = readline.createInterface({
      input: this.pythonProcess.stdout
    });

    rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        const requestId = response.requestId;

        if (this.pendingRequests.has(requestId)) {
          const { resolve, reject } = this.pendingRequests.get(requestId);
          this.pendingRequests.delete(requestId);

          if (response.success) {
            resolve(response);
          } else {
            reject(new Error(response.error || 'Unknown error'));
          }
        }
      } catch (error) {
        console.error('Failed to parse Python response:', error);
      }
    });

    // Handle process exit
    this.pythonProcess.on('exit', (code) => {
      console.error(`Python subprocess exited with code ${code}`);
      this.isReady = false;

      // Reject all pending requests
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error('Python subprocess terminated'));
      }
      this.pendingRequests.clear();
    });

    // Wait a bit for Python to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    this.isReady = true;
    console.log('✅ Python security service subprocess ready');
  }

  async sendRequest(action, data = {}) {
    if (!this.isReady) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      const request = {
        requestId,
        action,
        ...data
      };

      // Store promise callbacks
      this.pendingRequests.set(requestId, { resolve, reject });

      // Send request to Python subprocess
      this.pythonProcess.stdin.write(JSON.dumps(request) + '\n');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  // ProprietaryModule interface - required by PublicApiClient

  getApiConfig() {
    // Return synchronously (Python will provide same config)
    return {
      baseUrl: 'https://api16-normal-c-useast1a.tiktokv.com',
      userAgent: 'okhttp/3.12.13',
      endpoints: {
        feed: '/aweme/v1/feed/',
        recommended: '/aweme/v1/feed/'
      }
    };
  }

  async generateDeviceAuth(secUserId) {
    const response = await this.sendRequest('generateDeviceAuth', {
      secUserId
    });
    return response.deviceAuth;
  }

  async buildAuthenticatedParams(baseParams, sessionData) {
    const response = await this.sendRequest('buildAuthenticatedParams', {
      baseParams,
      sessionData
    });
    return response.params;
  }

  async cleanup() {
    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
      this.isReady = false;
    }
  }
}

// Export singleton instance
module.exports = new PythonSecurityModule();
