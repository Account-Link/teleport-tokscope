
const crypto = require('crypto');

function getTikTokApiSecrets() {
  return {
    baseUrl: 'https://api.tiktok.com',
    headers: { userAgent: 'TikTok/1.0' },
    endpoints: { feed: 'https://api.tiktok.com/aweme/v1/feed' },
    parameters: { aid: '1180' }
  };
}

function generateDeviceId(userId) {
  const hash = crypto.createHash('md5').update(userId).digest('hex');
  return 'device_' + hash.slice(0, 8);
}

function buildApiParams(baseParams) {
  return { ...baseParams, timestamp: Date.now() };
}

module.exports = {
  getTikTokApiSecrets,
  generateDeviceId,
  buildApiParams
};
