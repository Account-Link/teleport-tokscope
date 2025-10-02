
const crypto = require('crypto');

function getApiConfig() {
  return {
    baseUrl: 'https://api.tiktok.com',
    userAgent: 'TikTok/1.0',
    endpoints: {
      recommended: 'https://api.tiktok.com/aweme/v1/feed/recommended',
      preload: 'https://api.tiktok.com/aweme/v1/feed/preload'
    }
  };
}

function generateAuthHeaders(sessionData) {
  return {
    'User-Agent': 'TikTok/1.0',
    'Cookie': sessionData.cookies?.map(c => c.name + '=' + c.value).join('; ') || ''
  };
}

function buildAuthenticatedUrl(endpoint, params) {
  return endpoint + '?' + new URLSearchParams(params).toString();
}

module.exports = {
  getApiConfig,
  generateAuthHeaders,
  buildAuthenticatedUrl
};
