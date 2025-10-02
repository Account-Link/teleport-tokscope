# API Changelog

All notable changes to the Xordi Enclave API will be documented in this file.

## [Unreleased]

### Breaking Changes (2025-10-01)
- **Module endpoints now return raw API responses** to minimize TCB complexity:
  - `POST /modules/foryoupage/sample/:sessionId` response changed:
    - **Before**: `{ success: boolean, videos: Video[], ... }`
    - **After**: `{ success: boolean, raw: any, statusCode: number }`
  - `POST /modules/watchhistory/sample/:sessionId` response changed:
    - **Before**: `{ success: boolean, videos: Video[], ... }`
    - **After**: `{ success: boolean, raw: any, statusCode: number }`
  - **Migration**: Clients must transform raw responses. See `enclave-examples/response-transformers.js` for helpers.
  - **Rationale**: Keeps TCB minimal. Data transformation shouldn't be a security boundary.
  - **Note**: Browser automation endpoints (`/playwright/*`) still return `videos[]` for now.

### Added
- `POST /modules/watchhistory/sample/:sessionId` - New endpoint for watch history sampling via API modules
  - Request body: `{ count: number }` (optional, defaults to 10)
  - Response: `{ success: boolean, raw: any, statusCode: number }`
  - Requires `WATCH_HISTORY_MODULE_URL` environment variable
  - Raw response contains `aweme_list` from TikTok's watch history API

- `enclave-examples/response-transformers.js` - Client-side transformation utilities:
  - `transformWatchHistory(raw)` - Transform watch history `aweme_list` format
  - `transformForYouPage(raw)` - Transform For You page `itemList` format
  - `transformRawResponse(raw)` - Auto-detect and transform

- `GET /health` now includes `modules.watch_history` field:
  ```json
  {
    "modules": {
      "web": boolean,
      "mobile": boolean,
      "watch_history": boolean
    }
  }
  ```
  This allows clients to detect whether watch history module is loaded and available.

### Changed
- `WebApiClient` methods now return raw API responses:
  - `getRecommendedFeed()` returns `{ success, raw, statusCode }` instead of normalized videos
  - `getWatchHistory()` returns `{ success, raw, statusCode }` instead of normalized videos
  - `normalizeVideoData()` method deprecated (kept for backward compatibility but not called)
- Dashboard transforms responses client-side (outside enclave) using `response-transformers.js`

## Format

This changelog follows these principles:
- **Breaking changes** are clearly marked
- Each entry includes the endpoint, change type (Added/Changed/Removed), and description
- Response examples are provided for new fields
