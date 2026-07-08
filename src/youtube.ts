import { withRetry } from './retry.js';

/**
 * Thin client for the YouTube Data API v3 (video listing only — transcripts
 * come from the youtube-transcript package, per spec).
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';

export interface ChannelInfo {
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
}

export interface VideoListing {
  videoId: string;
  title: string;
  publishedAt: string;
}

export type FetchLike = typeof fetch;

export class YouTubeClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private async get(endpoint: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.apiKey);
    return withRetry(`YouTube API ${endpoint}`, async () => {
      const res = await this.fetchFn(url.toString());
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
      }
      return res.json();
    });
  }

  /**
   * Resolve any supported channel URL format to channel metadata.
   * Supported: /channel/UC..., /@handle, /c/name, /user/name.
   */
  async resolveChannel(channelUrl: string): Promise<ChannelInfo> {
    const url = new URL(channelUrl);
    const path = url.pathname.replace(/\/+$/, '');

    let data: any;
    const channelMatch = path.match(/\/channel\/(UC[\w-]+)/);
    const handleMatch = path.match(/\/(@[\w.-]+)/);
    const legacyMatch = path.match(/\/(?:c|user)\/([^/]+)/);

    const part = 'snippet,contentDetails';
    if (channelMatch) {
      data = await this.get('channels', { part, id: channelMatch[1]! });
    } else if (handleMatch) {
      data = await this.get('channels', { part, forHandle: handleMatch[1]! });
    } else if (legacyMatch) {
      // Legacy /user/ URLs resolve via forUsername; /c/ custom URLs have no
      // direct lookup, so fall back to treating the slug as a handle, then
      // to forUsername.
      data = await this.get('channels', { part, forHandle: `@${legacyMatch[1]!}` });
      if (!data.items?.length) {
        data = await this.get('channels', { part, forUsername: legacyMatch[1]! });
      }
    } else {
      throw new Error(
        `Unrecognized channel URL format: ${channelUrl} (expected /channel/UC..., /@handle, /c/name, or /user/name)`,
      );
    }

    const item = data.items?.[0];
    if (!item) {
      throw new Error(`Channel not found for URL: ${channelUrl}`);
    }
    return {
      channelId: item.id,
      title: item.snippet.title,
      uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    };
  }

  /** List videos from the uploads playlist, newest first, capped at maxVideos. */
  async listVideos(uploadsPlaylistId: string, maxVideos: number): Promise<VideoListing[]> {
    const videos: VideoListing[] = [];
    let pageToken: string | undefined;
    while (videos.length < maxVideos) {
      const params: Record<string, string> = {
        part: 'snippet,contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: String(Math.min(50, maxVideos - videos.length)),
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await this.get('playlistItems', params);
      for (const item of data.items ?? []) {
        videos.push({
          videoId: item.contentDetails.videoId,
          title: item.snippet.title,
          publishedAt: item.contentDetails.videoPublishedAt ?? item.snippet.publishedAt,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    // Uploads playlists are returned newest-first already; sort defensively.
    videos.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return videos.slice(0, maxVideos);
  }
}
