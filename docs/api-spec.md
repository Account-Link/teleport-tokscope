# Xordi Enclave API Specification

## Endpoints

### Authentication

**POST /auth/start/:sessionId**
```json
Request: {}
Response: {
  "authSessionId": "uuid",
  "status": "awaiting_scan"
}
```

**GET /auth/poll/:authSessionId**
```json
Response (pending): {
  "status": "awaiting_scan",
  "qrCodeData": "data:image/png;base64,..."
}

Response (complete): {
  "status": "complete",
  "sessionData": SessionData
}

Response (failed): {
  "status": "failed"
}
```

### Session Management

**POST /load-session**
```json
Request: {
  "sessionData": SessionData
}
Response: {
  "sessionId": "string",
  "status": "loaded"
}
```

**GET /sessions**
```json
Response: {
  "count": number,
  "sessions": [
    { "id": "truncated", "fullId": "full_sec_user_id" }
  ]
}
```

### Sampling - Playwright (Browser Automation)

**POST /playwright/foryoupage/sample/:sessionId**
```json
Request: {
  "count": number
}
Response: {
  "success": boolean,
  "videos": Video[],
  "method": "browser_automation",
  "sampled_at": "ISO8601"
}
```

**POST /playwright/watchhistory/sample/:sessionId**
```json
Request: {
  "count": number
}
Response: {
  "success": boolean,
  "videos": Video[],
  "method": "browser_automation",
  "sampled_at": "ISO8601"
}
```

### Sampling - Module (API Calls)

**POST /modules/foryoupage/sample/:sessionId**
```json
Request: {
  "count": number,
  "module_type": "web" | "mobile",
  "proxy"?: {
    "type": "socks5",
    "host": "string",
    "port": number,
    "username"?: "string",
    "password"?: "string"
  }
}
Response: {
  "success": boolean,
  "raw": any,  // Raw TikTok API response (no transformation in enclave)
  "statusCode": number
}
```

**Note**: The enclave returns the **raw API response** to keep the TCB minimal. Clients should transform the response outside the enclave. The raw response for For You Page contains `itemList[]` array. See `enclave-examples/response-transformers.js` for transformation examples.

**POST /modules/watchhistory/sample/:sessionId**
```json
Request: {
  "count": number,
  "module_type": "web" | "mobile",
  "proxy"?: {
    "type": "socks5",
    "host": "string",
    "port": number,
    "username"?: "string",
    "password"?: "string"
  }
}
Response: {
  "success": boolean,
  "raw": any,  // Raw TikTok API response (no transformation in enclave)
  "statusCode": number
}
```

**Note**: The enclave returns the **raw API response** to keep the TCB minimal. Clients should transform the response outside the enclave. The raw response for Watch History contains `aweme_list[]` array. See `enclave-examples/response-transformers.js` for transformation examples.

### Browser Container Management

**POST /containers/create**
```json
Request: {
  "proxy"?: {
    "type": "socks5",
    "host": "string",
    "port": number,
    "username"?: "string",
    "password"?: "string"
  }
}
Response: {
  "containerId": "string",
  "ip": "string",
  "cdpUrl": "string",
  "status": "available"
}
```

**DELETE /containers/:containerId**
```json
Response: {
  "success": boolean
}
```

**GET /containers**
```json
Response: {
  "total": number,
  "available": number,
  "assigned": number,
  "containers": [
    {
      "containerId": "string",
      "ip": "string",
      "status": "available" | "assigned",
      "sessionId": "string" | null,
      "createdAt": number,
      "lastUsed": number
    }
  ]
}
```

### System

**GET /health**
```json
Response: {
  "status": "healthy" | "degraded",
  "system": "healthy" | "degraded",
  "sessions": number,
  "activeSessions": number,
  "maxSessions": number,
  "uptime": number,
  "dstack": boolean,
  "encryption": boolean,
  "browserContainers": {
    "total": number,
    "available": number,
    "assigned": number
  },
  "modules": {
    "web": boolean,
    "mobile": boolean
  }
}
```

## Data Types

**SessionData**
```typescript
{
  extracted_at: string;
  user: {
    sec_user_id: string;
    username: string;
    nickname: string;
    uid: string;
  };
  cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  tokens: {
    device_id: string;
    install_id: string;
    sessionid: string;
    msToken: string;
  };
  metadata: {
    user_agent: string;
    extraction_method: string;
    success: boolean;
    url?: string;
  };
}
```

**Video**
```typescript
{
  id: string;
  description: string;
  author: string;
  url: string;
  method: string;
}
```

## Error Responses

All endpoints return HTTP status codes:
- 200: Success
- 400: Bad request
- 404: Not found
- 410: Endpoint deprecated
- 500: Internal server error

Error response body:
```json
{
  "error": "string"
}
```

## Proxy Configuration

**Per-container proxy (browser automation):**
- Set at container creation time via `/containers/create`
- All browser requests from that container use the configured proxy
- Proxy is applied via Chromium launch args

**Per-request proxy (module API calls):**
- Specified in each `/modules/*/sample/:sessionId` request
- Overrides default `SOCKS_PROXY`/`HTTPS_PROXY` environment variables
- Proxy is applied via axios/SocksProxyAgent

## TODO

**Not yet implemented or exercised:**
- Container management endpoints (`/containers/create`, `/containers/:containerId`, `/containers`)
- Module-based sampling endpoints (`/modules/foryoupage/sample/:sessionId` and `/modules/watchhistory/sample/:sessionId`)
- Module loading system (gist-based proprietary modules)
- Manual session loading UI in dashboard (currently only happens automatically after auth)
- Dashboard UI for browser container management