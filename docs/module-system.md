# Proprietary Module System

The enclave supports loading proprietary authentication modules at runtime from GitHub gists or URLs.

## Module Format

Modules are published as JSON packages containing the source code and metadata:

```json
{
  "moduleId": "web-auth-v1",
  "source": "module.exports = { ... }",
  "metadata": {
    "version": "1.0.0",
    "author": "xordi",
    "description": "TikTok web auth module",
    "timestamp": "2025-09-30T...",
    "sourceHash": "sha256..."
  }
}
```

## Publishing Modules

Use the publishing script to upload modules to GitHub gists:

```bash
# Set GitHub token (create at https://github.com/settings/tokens with gist scope)
export GITHUB_TOKEN=ghp_...

# Publish a module
node scripts/publish-module-gist.js private-modules/web-auth.js web-auth-v1 "TikTok web auth"

# Output includes the raw URL for the enclave
```

Add the raw URL to your `.env`:

```
WEB_AUTH_MODULE_URL=https://gist.githubusercontent.com/.../web-auth-v1.json
MOBILE_AUTH_MODULE_URL=https://gist.githubusercontent.com/.../mobile-auth-v1.json
```

## Module Loading

Modules are loaded at request time using `EnclaveModuleLoader`:

```typescript
const moduleLoader = new EnclaveModuleLoader();
const webAuth = await moduleLoader.loadModuleFromUrl(process.env.WEB_AUTH_MODULE_URL);
```

The loader:
1. Fetches the module package from the URL
2. Validates the module structure (optional AST analysis)
3. Writes source to a temp file
4. Loads via `require()`
5. Deletes temp file

## Module Interface

Modules must export specific interfaces depending on their type.

### Web Auth Module

```javascript
module.exports = {
  getApiConfig() {
    return {
      baseUrl: 'https://www.tiktok.com',
      userAgent: '...',
      endpoints: {
        recommended: '/api/recommend/item_list/',
        preload: '/api/preload/'
      }
    };
  },

  generateBrowserFingerprint(deviceId) {
    return { /* fingerprint params */ };
  },

  buildAuthenticatedUrl(endpoint, params, credentials) {
    // Build URL with auth params
  },

  generateAuthHeaders(credentials) {
    // Generate request headers
  }
};
```

### Mobile Auth Module

Similar structure but for mobile API endpoints.

## Security

- Modules are verified before loading (configurable constraints)
- Module source hash is included in metadata
- Private gists provide access control
- Future: add encryption, attestation, policy verification
