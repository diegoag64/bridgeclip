import { execFile } from 'child_process'
import { promisify } from 'util'
import { youtubeSourceUrl } from '../shared/video-source'
import type { YouTubePreview } from '../shared/youtube-preview'
import { readResponseText } from './http-response'
import { resolveBinary } from './tools'

const execFileAsync = promisify(execFile)
const cache = new Map<string, { at: number; value: YouTubePreview }>()
const pending = new Map<string, Promise<YouTubePreview>>()

function text(value: unknown): string | null {
  return typeof value === 'string' ? Array.from(value).map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').trim().slice(0, 1024) || null : null
}

export function parseYouTubePreview(value: unknown, details: boolean): YouTubePreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid video details')
  const info = value as Record<string, unknown>
  const title = text(info.title)
  if (!title) throw new Error('Missing video title')
  const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const rawDate = details && typeof info.upload_date === 'string' && /^\d{8}$/.test(info.upload_date) ? info.upload_date : null
  const isoDate = rawDate ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : null
  const date = isoDate ? new Date(`${isoDate}T00:00:00Z`) : null
  return {
    title,
    channel: text(details ? info.channel ?? info.uploader : info.author_name),
    durationSeconds: details && info.is_live !== true ? number(info.duration) : null,
    viewCount: details ? number(info.view_count) : null,
    uploadedOn: date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === isoDate ? isoDate : null
  }
}

async function fetchPreview(url: string, details: boolean): Promise<YouTubePreview> {
  if (!details) {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' }
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Preview unavailable') }
    return parseYouTubePreview(JSON.parse(await readResponseText(response, 64 * 1024)), false)
  }
  // Metadata only, with no local config, cookies, playlist expansion or media downloads.
  const { stdout } = await execFileAsync(resolveBinary('yt-dlp'), [
    '--ignore-config', '--skip-download', '--no-playlist', '--no-warnings', '--no-cache-dir', '--use-extractors', 'youtube',
    '--socket-timeout', '5', '--retries', '0', '--extractor-retries', '0',
    '--print', '{"title":%(title)j,"channel":%(channel)j,"uploader":%(uploader)j,"duration":%(duration)j,"view_count":%(view_count)j,"upload_date":%(upload_date)j,"is_live":%(is_live)j}',
    '--', url
  ], { timeout: 20000, maxBuffer: 64 * 1024, windowsHide: true })
  return parseYouTubePreview(JSON.parse(stdout.trim()), true)
}

/** Title/channel load independently of optional, slower extractor metadata. */
export async function getYouTubePreview(source: unknown, details: unknown = false): Promise<YouTubePreview> {
  const url = youtubeSourceUrl(source)
  if (!url || typeof details !== 'boolean') throw new Error('Choose a valid YouTube video link.')
  const key = `${details ? 'details' : 'summary'}:${url}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value
  const existing = pending.get(key)
  if (existing) return existing
  if ([...pending.keys()].filter((k) => k.startsWith(details ? 'details:' : 'summary:')).length >= 3) {
    throw new Error('Video details are busy. Try again shortly.')
  }
  const request = fetchPreview(url, details).then((value) => {
    if (cache.size >= 100) cache.delete(cache.keys().next().value!)
    cache.set(key, { at: Date.now(), value })
    return value
  }).catch(() => { throw new Error('Could not load YouTube details. You can still continue or try again.') })
  pending.set(key, request)
  try { return await request } finally { pending.delete(key) }
}
