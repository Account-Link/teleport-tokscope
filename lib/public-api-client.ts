import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface SessionData {
  user: {
    username: string;
    sec_user_id: string;
  };
  cookies: Array<{
    name: string;
    value: string;
  }>;
  tokens: {
    device_id: string;
    install_id: string;
  };
}

export interface ProprietaryModule {
  getApiConfig(): any;
  // Web module methods (optional)
  generateBrowserFingerprint?(deviceId?: string): any;
  buildAuthenticatedUrl?(endpoint: string, params: any, credentials: any): string;
  generateAuthHeaders?(credentials: any): any;
  // Mobile module methods (optional)
  generateDeviceAuth?(secUserId: string): any;
  buildAuthenticatedParams?(baseParams: any, sessionCredentials: any): any;
}

export class PublicApiClient {
  private sessionData: SessionData;
  private proprietaryModule: ProprietaryModule;
  private client!: AxiosInstance;
  private startTime: number;
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 2000;

  constructor(sessionData: SessionData, proprietaryModule: ProprietaryModule) {
    this.sessionData = sessionData;
    this.proprietaryModule = proprietaryModule;
    this.startTime = Date.now();
  }

  async initialize() {
    console.log(`🚀 Initializing API client for user @${this.sessionData.user.username}`);

    const apiSecrets = this.proprietaryModule.getApiConfig();

    this.client = axios.create({
      baseURL: apiSecrets.baseUrl,
      timeout: 30000,
      headers: {
        'User-Agent': apiSecrets.userAgent,
        'Accept-Encoding': 'gzip, deflate',
        'Host': new URL(apiSecrets.baseUrl).hostname,
        'Connection': 'keep-alive'
      }
    });

    this.client.interceptors.request.use((config) => {
      if (this.sessionData.cookies && Array.isArray(this.sessionData.cookies)) {
        const cookieString = this.sessionData.cookies
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        if (cookieString) {
          config.headers['Cookie'] = cookieString;
        }
      }
      return config;
    });

    console.log('✅ Public API client initialized with proprietary configuration');
  }

  async sampleTimeline(requestedCount: number = 30) {
    await this.initialize();
    const startTime = Date.now();

    console.log(`📱 Fetching timeline (requested: ${requestedCount} videos)...`);

    const apiSecrets = this.proprietaryModule.getApiConfig();

    let allVideos: any[] = [];
    let currentCursor = Math.floor(Date.now() / 1000);
    let requestCount = 0;
    const maxRequests = Math.ceil(requestedCount / 8) + 1;

    // Detect module type
    const isWebModule = !!this.proprietaryModule.generateBrowserFingerprint;
    const isMobileModule = !!this.proprietaryModule.generateDeviceAuth;

    console.log(`   Using ${isWebModule ? 'web' : 'mobile'} module interface`);

    while (allVideos.length < requestedCount && requestCount < maxRequests) {
      requestCount++;
      console.log(`   Batch ${requestCount}: Fetching (cursor: ${currentCursor})...`);

      let response;

      if (isWebModule && this.proprietaryModule.generateBrowserFingerprint && this.proprietaryModule.buildAuthenticatedUrl) {
        // Web module approach - use fresh device_id to avoid user-specific routing
        const fingerprint = this.proprietaryModule.generateBrowserFingerprint();
        const baseParams = {
          count: '1',  // Match working version exactly
          ...fingerprint
        };

        // Only add cursor for subsequent requests (web API starts with no cursor)
        if (requestCount > 1 && currentCursor) {
          baseParams.cursor = currentCursor.toString();
        }

        const authenticatedUrl = this.proprietaryModule.buildAuthenticatedUrl(
          apiSecrets.endpoints.recommended || apiSecrets.endpoints.feed,
          baseParams,
          this.sessionData
        );

        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
          const waitTime = this.minRequestInterval - timeSinceLastRequest;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();

        // For web API, use minimal headers without authentication cookies to get generic feed
        const authHeaders = {
          'User-Agent': this.client.defaults.headers['User-Agent'],
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://www.tiktok.com/',
          'Origin': 'https://www.tiktok.com',
          'Sec-Ch-Ua': '"Chromium";v="138", "Not=A?Brand";v="8", "Google Chrome";v="138"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        };

        // Log complete request for comparison
        const timestamp = new Date().toISOString();
        const requestLog = {
          timestamp,
          method: 'GET',
          url: authenticatedUrl,
          headers: { ...this.client.defaults.headers, ...authHeaders },
          body: null,
          userAgent: this.client.defaults.headers['User-Agent'],
          sessionId: this.sessionData?.user?.sec_user_id || 'unknown'
        };

        console.log('🔍 FULL REQUEST:', JSON.stringify(requestLog, null, 2));

        response = await this.client.get(authenticatedUrl, { headers: authHeaders });

        // Log complete response for comparison
        const responseLog = {
          timestamp: new Date().toISOString(),
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data: response.data,
          requestUrl: authenticatedUrl,
          requestMethod: 'GET'
        };

        console.log('✅ FULL RESPONSE:', JSON.stringify(responseLog, null, 2));

        // Save to file for inspection
        const fs = require('fs');
        const outputDir = './output';
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const logEntry = {
          request: requestLog,
          response: responseLog
        };

        const filename = `${outputDir}/our-web-api-${Date.now()}.json`;
        fs.writeFileSync(filename, JSON.stringify(logEntry, null, 2));
        console.log(`📁 Request/Response saved to: ${filename}`);

      } else if (isMobileModule && this.proprietaryModule.generateDeviceAuth && this.proprietaryModule.buildAuthenticatedParams) {
        // Mobile module approach
        const deviceAuth = this.proprietaryModule.generateDeviceAuth(this.sessionData.user.sec_user_id);
        const baseParams = {
          count: '20',
          max_cursor: currentCursor.toString(),
          pull_type: requestCount === 1 ? '1' : '2',
          type: '0',
          ...deviceAuth
        };

        const authenticatedParams = this.proprietaryModule.buildAuthenticatedParams(baseParams, this.sessionData);

        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
          const waitTime = this.minRequestInterval - timeSinceLastRequest;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();

        response = await this.client.get(apiSecrets.endpoints.feed || apiSecrets.endpoints.recommended, {
          params: authenticatedParams
        });

      } else {
        throw new Error('Unknown module type - missing required methods');
      }

      try {

        // Handle both web and mobile API response formats
        const statusCode = response.data.statusCode !== undefined ? response.data.statusCode : response.data.status_code;
        if (statusCode && statusCode !== 0) {
          const statusMsg = response.data.status_msg || 'Unknown error';
          throw new Error(`API error ${statusCode}: ${statusMsg}`);
        }

        // Web API uses itemList, mobile API uses aweme_list
        // If we get minimal response from web endpoint, treat as empty (TikTok routing issue)
        const batchVideos = response.data.itemList || response.data.aweme_list || [];

        // Log routing detection
        if (response.data.itemList) {
          console.log(`   Web API format detected (itemList)`);
        } else if (response.data.aweme_list) {
          console.log(`   Mobile API format detected (aweme_list)`);
        } else if (statusCode === 0 && !batchVideos.length) {
          console.log(`   Minimal response - likely mobile routing on web endpoint`);
        }

        console.log(`      Got ${batchVideos.length} videos`);

        batchVideos.slice(0, Math.min(batchVideos.length, requestedCount - allVideos.length)).forEach((video: any) => {
          const transformedVideo = this.transformVideo(video);
          console.log(`✅ Extracted: "${transformedVideo.desc || 'No description'}" (@${transformedVideo.author})`);
        });

        allVideos = allVideos.concat(batchVideos);
        currentCursor = response.data.cursor || response.data.max_cursor || 0;

        // Check hasMore for both web (hasMore) and mobile (has_more) APIs
        const hasMore = response.data.hasMore !== undefined ? response.data.hasMore : response.data.has_more;
        if (batchVideos.length === 0 || !hasMore) {
          break;
        }
      } catch (error: any) {
        console.error(`   Batch ${requestCount} failed:`, error.message);
        if (requestCount === 1) {
          throw error;
        }
        break;
      }
    }

    const finalVideos = allVideos.slice(0, requestedCount);
    const processingTime = Date.now() - startTime;

    console.log(`✅ Timeline sampling completed!`);
    console.log(`   Total videos: ${finalVideos.length}/${requestedCount} requested`);
    console.log(`   API requests: ${requestCount}`);
    console.log(`   Total time: ${processingTime}ms`);

    return {
      success: true,
      videos: finalVideos.map(v => this.transformVideo(v)),
      hasMore: currentCursor > 0,
      maxCursor: currentCursor,
      executionTime: processingTime,
      method: 'proprietary_api',
      totalRequests: requestCount
    };
  }

  private transformVideo(video: any) {
    if (!video) throw new Error('Video is null');

    const videoId = video.aweme_id;
    const author = video.author ? video.author.unique_id : 'unknown';
    const webUrl = `https://www.tiktok.com/@${author}/video/${videoId}`;

    return {
      id: videoId,
      desc: video.desc || '',
      createTime: video.create_time,
      author: author,
      authorDetails: video.author ? {
        id: video.author.uid,
        uniqueId: video.author.unique_id,
        nickname: video.author.nickname,
        avatarThumb: video.author.avatar_thumb?.url_list?.[0]
      } : undefined,
      views: video.statistics?.play_count || 0,
      likes: video.statistics?.digg_count || 0,
      shares: video.statistics?.share_count || 0,
      comments: video.statistics?.comment_count || 0,
      stats: {
        diggCount: video.statistics?.digg_count || 0,
        shareCount: video.statistics?.share_count || 0,
        commentCount: video.statistics?.comment_count || 0,
        playCount: video.statistics?.play_count || 0,
        collectCount: video.statistics?.collect_count || 0
      },
      video: {
        duration: video.video?.duration,
        ratio: video.video?.ratio,
        cover: video.video?.cover?.url_list?.[0],
        dynamicCover: video.video?.dynamic_cover?.url_list?.[0],
        playAddr: video.video?.play_addr?.url_list?.[0],
        downloadAddr: video.video?.download_addr?.url_list?.[0]
      },
      music: {
        id: video.music?.id,
        title: video.music?.title,
        author: video.music?.author,
        duration: video.music?.duration,
        coverThumb: video.music?.cover_thumb?.url_list?.[0]
      },
      challenges: (video.text_extra || [])
        .filter((t: any) => t.hashtag_name)
        .map((t: any) => ({
          id: t.hashtag_id,
          title: t.hashtag_name
        })),
      isReposted: false,
      webUrl: webUrl,
      url: webUrl,
      sampled_at: new Date().toISOString()
    };
  }

  private generateInstallId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  getStats() {
    const uptime = Date.now() - this.startTime;
    return {
      uptime,
      secUserId: this.sessionData.user.sec_user_id,
      username: this.sessionData.user.username,
      cookieCount: this.sessionData.cookies ? this.sessionData.cookies.length : 0,
      proprietaryModuleLoaded: !!this.proprietaryModule
    };
  }
}