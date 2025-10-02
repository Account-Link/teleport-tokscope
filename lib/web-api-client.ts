import * as crypto from 'crypto';
import axios from 'axios';
import { configureAxiosProxy } from './proxy-config';

interface Cookie {
  name: string;
  value: string;
  domain?: string;
}

interface SessionData {
  device_id?: string;
  cookies?: Cookie[];
  user?: {
    sec_user_id?: string;
  };
}

interface WebAuthModule {
  getApiConfig(): {
    baseUrl: string;
    userAgent: string;
    endpoints: { recommended: string; preload: string };
  };
  generateBrowserFingerprint(deviceId?: string): any;
  buildAuthenticatedUrl(endpoint: string, params: any, credentials: any): string;
  generateAuthHeaders(credentials: any): any;
}

interface BrowserFingerprint {
  aid: string;
  device_id: string;
  device_type: string;
  screen_width: string;
  window_width: string;
  screen_height: string;
  window_height: string;
  browser_language: string;
  browser_name: string;
  browser_online: string;
  browser_platform: string;
  browser_version: string;
  app_language: string;
  app_name: string;
  channel: string;
  cookie_enabled: string;
  data_collection_enabled: string;
  device_platform: string;
  focus_state: string;
  from_page: string;
  history_len: string;
  is_fullscreen: string;
  is_page_visible: string;
  os: string;
  priority_region: string;
  referer: string;
  region: string;
  root_referer: string;
  tz_name: string;
  user_is_login: string;
  verifyFp: string;
  webcast_language: string;
  WebIdLastTime: string;
}

interface VideoStats {
  diggCount: number;
  shareCount: number;
  commentCount: number;
  playCount: number;
  collectCount: number;
}

interface Author {
  id?: string;
  uniqueId?: string;
  nickname?: string;
  avatarThumb?: string;
}

interface Music {
  title?: string;
  authorName?: string;
}

interface Video {
  id?: string;
  duration?: number;
  ratio?: string;
  cover?: string;
  playAddr?: string;
  downloadAddr?: string;
}

interface VideoData {
  id: string;
  desc: string;
  author: string;
  authorDetails: Author;
  music: {
    title?: string;
    author?: string;
  };
  likes: number;
  views: number;
  comments: number;
  shares: number;
  stats: VideoStats;
  video: Video;
  webUrl: string;
  url: string;
  createTime?: number;
  sampled_at: string;
  method: string;
}

interface ApiResponse {
  statusCode: number;
  itemList?: any[];
  hasMore?: boolean;
  cursor?: string;
}

interface FeedResult {
  success: boolean;
  raw?: any;  // Raw API response (no transformation)
  videos?: VideoData[];  // Deprecated: kept for backward compatibility
  hasMore?: boolean;
  cursor?: string;
  statusCode?: number;
  error?: string;
}

class WebApiClient {
  private sessionData: SessionData;
  private webAuth: WebAuthModule;
  private watchHistoryAuth: any;
  private options: any;
  private userAgent: string;

  constructor(sessionData: SessionData, webAuth: WebAuthModule, options: any = {}) {
    this.sessionData = sessionData;
    this.webAuth = webAuth;
    this.watchHistoryAuth = (webAuth as any).buildWatchHistoryUrl ? webAuth : null;
    this.options = options;
    this.userAgent = webAuth.getApiConfig().userAgent;
  }

  private getHeaders(): any {
    const credentials = {
      cookies: this.sessionData?.cookies || [],
      deviceId: this.sessionData?.device_id
    };
    return this.webAuth.generateAuthHeaders(credentials);
  }


  private async makeRequest(url: string, method = 'GET', body: any = null, customHeaders?: any): Promise<any> {
    const timestamp = new Date().toISOString();
    const headers = customHeaders || this.getHeaders();

    // Log complete request
    const requestLog = {
      timestamp,
      method,
      url,
      headers,
      body: body || null,
      userAgent: this.userAgent,
      sessionId: this.sessionData?.user?.sec_user_id || 'unknown'
    };

    console.log('🔍 FULL REQUEST:', JSON.stringify(requestLog, null, 2));

    try {
      const config = configureAxiosProxy({
        method,
        url,
        headers,
        data: body,
        timeout: 30000
      });
      const response = await axios(config);

      // Log complete response
      const responseLog = {
        timestamp: new Date().toISOString(),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data,
        requestUrl: url,
        requestMethod: method
      };

      console.log('✅ FULL RESPONSE:', JSON.stringify(responseLog, null, 2));

      // Also save to file for inspection (use /tmp in read-only containers)
      const fs = require('fs');
      const outputDir = process.env.OUTPUT_DIR || '/tmp/output';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const logEntry = {
        request: requestLog,
        response: responseLog
      };

      const filename = `${outputDir}/web-api-${Date.now()}.json`;
      fs.writeFileSync(filename, JSON.stringify(logEntry, null, 2));
      console.log(`📁 Request/Response saved to: ${filename}`);

      return response.data;
    } catch (error: any) {
      // Log error response if available
      if (error.response) {
        const errorLog = {
          timestamp: new Date().toISOString(),
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
          data: error.response.data,
          requestUrl: url,
          requestMethod: method,
          error: true
        };

        console.log('❌ ERROR RESPONSE:', JSON.stringify(errorLog, null, 2));

        // Save error to file too (use /tmp in read-only containers)
        const fs = require('fs');
        const outputDir = process.env.OUTPUT_DIR || '/tmp/output';
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const logEntry = {
          request: requestLog,
          errorResponse: errorLog
        };

        const filename = `${outputDir}/web-api-error-${Date.now()}.json`;
        fs.writeFileSync(filename, JSON.stringify(logEntry, null, 2));
        console.log(`📁 Error Request/Response saved to: ${filename}`);

        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      }
      throw error;
    }
  }

  async getRecommendedFeed(count = 6, cursor: string | null = null): Promise<FeedResult> {
    // Validate authentication before attempting to get authenticated timeline
    if (!this.sessionData?.user?.sec_user_id) {
      throw new Error('Web API requires authenticated session with valid sec_user_id. Current session has no user data - this would only return public timeline, not your authenticated feed.');
    }

    console.log(`🌐 Fetching recommended feed (${count} videos)...`);

    const params: Record<string, string> = {
      count: count.toString(),
      video_encoding: 'mp4',
      vv_count: '0',
      vv_count_fyp: '0'
    };

    if (cursor) params.cursor = cursor.toString();

    const config = this.webAuth.getApiConfig();
    const url = this.webAuth.buildAuthenticatedUrl(config.endpoints.recommended, params, this.sessionData);

    try {
      const response: ApiResponse = await this.makeRequest(url);

      if (response.statusCode === 0 && response.itemList) {
        console.log(`✅ Got ${response.itemList.length} videos from web API (raw response)`);

        return {
          success: true,
          raw: response,  // Return raw response instead of normalized
          statusCode: response.statusCode
        };
      } else {
        console.warn(`⚠️ API returned status: ${response.statusCode}`);
        return {
          success: false,
          error: `API status: ${response.statusCode}`,
          statusCode: response.statusCode
        };
      }
    } catch (error: any) {
      console.error(`❌ Feed request failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getWatchHistory(count = 10, cursor: string | null = null): Promise<FeedResult> {
    if (!this.watchHistoryAuth) {
      throw new Error('Watch history module not loaded');
    }

    console.log(`📺 Fetching watch history (${count} videos)...`);

    const params: Record<string, string> = {
      count: count.toString()
    };

    if (cursor) params.cursor = cursor.toString();

    const credentials = {
      cookies: this.sessionData?.cookies || [],
      device_id: (this.sessionData as any)?.tokens?.device_id
    };
    const url = this.watchHistoryAuth.buildWatchHistoryUrl(params, credentials);
    const queryString = new URL(url).search.substring(1);
    const headers = this.watchHistoryAuth.generateAuthHeaders(queryString, credentials);

    console.log(`🔧 Watch History Auth Debug:`);
    console.log(`   device_id: ${credentials.device_id}`);
    console.log(`   cookies count: ${credentials.cookies?.length}`);
    console.log(`   First cookie:`, credentials.cookies?.[0]);
    console.log(`   queryString length: ${queryString.length}`);
    console.log(`   Module function type:`, typeof this.watchHistoryAuth.generateAuthHeaders);
    console.log(`   Raw headers returned:`, JSON.stringify(headers, null, 2));
    console.log(`   All header keys:`, Object.keys(headers));
    console.log(`   X-Bogus: ${headers['X-Bogus']}`);
    console.log(`   Cookie length: ${headers['Cookie']?.length}`);

    try {
      const response: ApiResponse = await this.makeRequest(url, 'GET', null, headers);
      const statusCode = (response as any).status_code ?? response.statusCode;
      const itemList = (response as any).aweme_list || response.itemList;

      if (statusCode === 0 && itemList) {
        console.log(`✅ Got ${itemList.length} watch history videos (raw response)`);

        return {
          success: true,
          raw: response,  // Return raw response instead of normalized
          statusCode: statusCode
        };
      } else {
        console.warn(`⚠️ API returned status: ${statusCode}${(response as any).status_msg ? ` - ${(response as any).status_msg}` : ''}`);
        return {
          success: false,
          error: `API status: ${statusCode}${(response as any).status_msg ? ` - ${(response as any).status_msg}` : ''}`,
          statusCode: statusCode
        };
      }
    } catch (error: any) {
      console.error(`❌ Watch history request failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getPreloadFeed(count = 3, vvCount = 0, vvCountFyp = 0): Promise<FeedResult> {
    console.log(`🔄 Fetching preload feed (${count} videos)...`);

    const params: Record<string, string> = {
      count: count.toString(),
      video_encoding: 'mp4',
      vv_count: vvCount.toString(),
      vv_count_fyp: vvCountFyp.toString()
    };

    const config = this.webAuth.getApiConfig();
    const url = this.webAuth.buildAuthenticatedUrl(config.endpoints.preload, params, this.sessionData);

    try {
      const response: ApiResponse = await this.makeRequest(url);

      if (response.statusCode === 0 && response.itemList) {
        console.log(`✅ Got ${response.itemList.length} preload videos`);

        return {
          success: true,
          videos: response.itemList.map(item => this.normalizeVideoData(item)),
          statusCode: response.statusCode
        };
      } else {
        return {
          success: false,
          error: `API status: ${response.statusCode}`,
          statusCode: response.statusCode
        };
      }
    } catch (error: any) {
      console.error(`❌ Preload request failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  private normalizeVideoData(item: any): VideoData {
    // Handle both For You Page format (id, uniqueId, stats) and Watch History format (aweme_id, unique_id, statistics)
    const videoId = item.aweme_id || item.id;
    const authorUniqueId = item.author?.unique_id || item.author?.uniqueId;
    const stats = item.statistics || item.stats || {};

    return {
      id: videoId,
      desc: item.desc || '',
      author: authorUniqueId || 'Unknown',
      authorDetails: {
        id: item.author?.id,
        uniqueId: authorUniqueId,
        nickname: item.author?.nickname,
        avatarThumb: item.author?.avatarThumb || item.author?.avatar_thumb
      },
      music: {
        title: item.music?.title,
        author: item.music?.authorName || item.music?.author_name
      },
      likes: stats?.diggCount || stats?.digg_count || 0,
      views: stats?.playCount || stats?.play_count || 0,
      comments: stats?.commentCount || stats?.comment_count || 0,
      shares: stats?.shareCount || stats?.share_count || 0,
      stats: {
        diggCount: stats?.diggCount || stats?.digg_count || 0,
        shareCount: stats?.shareCount || stats?.share_count || 0,
        commentCount: stats?.commentCount || stats?.comment_count || 0,
        playCount: stats?.playCount || stats?.play_count || 0,
        collectCount: stats?.collectCount || stats?.collect_count || 0
      },
      video: {
        id: item.video?.id,
        duration: item.video?.duration,
        ratio: item.video?.ratio,
        cover: item.video?.cover,
        playAddr: item.video?.playAddr || item.video?.play_addr,
        downloadAddr: item.video?.downloadAddr || item.video?.download_addr
      },
      webUrl: `https://www.tiktok.com/@${authorUniqueId}/video/${videoId}`,
      url: `https://www.tiktok.com/@${authorUniqueId}/video/${videoId}`,
      createTime: item.create_time || item.createTime,
      sampled_at: new Date().toISOString(),
      method: 'web_api'
    };
  }

  async testConnection(): Promise<boolean> {
    console.log('🔍 Testing web API connection...');

    try {
      const result = await this.getRecommendedFeed(1);

      if (result.success) {
        console.log('✅ Web API connection successful!');
        console.log(`   Got ${result.videos?.length} video(s)`);
        if (result.videos?.length) {
          const video = result.videos[0];
          console.log(`   Sample: "${video.desc.substring(0, 50)}..." by @${video.authorDetails.uniqueId}`);
        }
        return true;
      } else {
        console.error(`❌ Web API test failed: ${result.error}`);
        return false;
      }
    } catch (error: any) {
      console.error(`❌ Web API test error: ${error.message}`);
      return false;
    }
  }
}

export = WebApiClient;