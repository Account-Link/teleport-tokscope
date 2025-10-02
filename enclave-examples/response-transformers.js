/**
 * Client-Side Response Transformers
 *
 * These transformers run OUTSIDE the enclave (in the dashboard/host).
 * The enclave returns raw API responses, and clients transform them as needed.
 *
 * This keeps the TCB (Trusted Computing Base) minimal and allows flexibility.
 */

/**
 * Transform raw Watch History API response to video objects
 */
function transformWatchHistory(raw) {
  const items = raw.aweme_list || [];

  return items.map(item => ({
    id: item.aweme_id,
    desc: item.desc || '',
    author: item.author?.unique_id || 'Unknown',
    authorDetails: {
      uniqueId: item.author?.unique_id,
      nickname: item.author?.nickname,
      avatarThumb: item.author?.avatar_thumb
    },
    music: {
      title: item.music?.title,
      author: item.music?.author_name
    },
    likes: item.statistics?.digg_count || 0,
    views: item.statistics?.play_count || 0,
    comments: item.statistics?.comment_count || 0,
    shares: item.statistics?.share_count || 0,
    stats: {
      diggCount: item.statistics?.digg_count || 0,
      shareCount: item.statistics?.share_count || 0,
      commentCount: item.statistics?.comment_count || 0,
      playCount: item.statistics?.play_count || 0,
      collectCount: item.statistics?.collect_count || 0
    },
    video: {
      duration: item.video?.duration,
      ratio: item.video?.ratio,
      cover: item.video?.cover,
      playAddr: item.video?.play_addr,
      downloadAddr: item.video?.download_addr
    },
    url: `https://www.tiktok.com/@${item.author?.unique_id}/video/${item.aweme_id}`,
    createTime: item.create_time,
    sampled_at: new Date().toISOString(),
    method: 'web_api'
  }));
}

/**
 * Transform raw For You Page API response to video objects
 */
function transformForYouPage(raw) {
  const items = raw.itemList || [];

  return items.map(item => ({
    id: item.id,
    desc: item.desc || '',
    author: item.author?.uniqueId || 'Unknown',
    authorDetails: {
      uniqueId: item.author?.uniqueId,
      nickname: item.author?.nickname,
      avatarThumb: item.author?.avatarThumb
    },
    music: {
      title: item.music?.title,
      author: item.music?.authorName
    },
    likes: item.stats?.diggCount || 0,
    views: item.stats?.playCount || 0,
    comments: item.stats?.commentCount || 0,
    shares: item.stats?.shareCount || 0,
    stats: {
      diggCount: item.stats?.diggCount || 0,
      shareCount: item.stats?.shareCount || 0,
      commentCount: item.stats?.commentCount || 0,
      playCount: item.stats?.playCount || 0,
      collectCount: item.stats?.collectCount || 0
    },
    video: {
      duration: item.video?.duration,
      ratio: item.video?.ratio,
      cover: item.video?.cover,
      playAddr: item.video?.playAddr,
      downloadAddr: item.video?.downloadAddr
    },
    url: `https://www.tiktok.com/@${item.author?.uniqueId}/video/${item.id}`,
    createTime: item.createTime,
    sampled_at: new Date().toISOString(),
    method: 'web_api'
  }));
}

/**
 * Auto-detect and transform based on response structure
 */
function transformRawResponse(raw) {
  if (raw.aweme_list) {
    return transformWatchHistory(raw);
  } else if (raw.itemList) {
    return transformForYouPage(raw);
  } else {
    throw new Error('Unknown response format: no aweme_list or itemList found');
  }
}

module.exports = {
  transformWatchHistory,
  transformForYouPage,
  transformRawResponse
};
