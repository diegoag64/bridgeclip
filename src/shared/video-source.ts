/** Twitch pages require the VOD extractor; other links retain direct-video support. */
export const TWITCH_VOD_HINT = 'Choose a public, completed Twitch VOD using its video link. Live channels, collections and Twitch clips are not supported.'
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv'])

export function twitchVodId(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!TWITCH_HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    return url.pathname.match(/^\/videos\/([0-9]+)\/?$/)?.[1] ?? null
  } catch { return null }
}

export function twitchSourceError(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return (host === 'twitch.tv' || host.endsWith('.twitch.tv')) && !twitchVodId(value) ? TWITCH_VOD_HINT : null
  } catch { return null }
}

export function normalizeVideoSource(value: string): string {
  const id = twitchVodId(value)
  return id ? `https://www.twitch.tv/videos/${id}` : value.trim()
}

/** Canonical public video link for source navigation and metadata lookups. */
export function youtubeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
    let id: string | null = null
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1)
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)$/.exec(url.pathname)?.[1] ?? null
    }
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
  } catch { return null }
}
