import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { promisify } from 'util'
import type { AutomationSourceContext } from '../shared/automations'
import type { JobOutput } from '../shared/job-output'
import { getJobHistory, getJobOutput } from './file-manager'
import { isWithinDirectory, openAuthorizedMedia } from './security'
import { resolveBinary } from './tools'

const execFileAsync = promisify(execFile)

/** Resolve actual clip provenance; enhanced titles are not stable identifiers. */
export async function findLibraryRunForClip(bankFile: string | null, library: string, sourceClipPath?: string): Promise<string | null> {
  const runs = (await getJobHistory(library)).filter((run) => run.status === 'completed')
  if (sourceClipPath && isWithinDirectory(sourceClipPath, library)) {
    for (const run of runs) {
      if (!isWithinDirectory(sourceClipPath, run.outputDir)) continue
      const output = await getJobOutput(run.outputDir, library)
      if (output?.clips.some((clip) => {
        try { return realpathSync(clip.s3_url.replace(/^file:\/\//, '')) === realpathSync(sourceClipPath) } catch { return false }
      })) return run.outputDir
    }
  }
  if (!bankFile) return null
  let bank: Awaited<ReturnType<typeof openAuthorizedMedia>>
  try { bank = await openAuthorizedMedia(bankFile, library) } catch { return null }
  try {
    let bankHash: string | null = null
    for (const run of runs) {
      const output = await getJobOutput(run.outputDir, library)
      for (const clip of output?.clips ?? []) {
        const path = clip.s3_url.replace(/^file:\/\//, '')
        if (!isWithinDirectory(path, run.outputDir)) continue
        try {
          const candidate = await openAuthorizedMedia(path, library)
          try {
            if (candidate.size !== bank.size) continue
            if (!bankHash) {
              const hash = createHash('sha256')
              for await (const chunk of bank.handle.createReadStream({ autoClose: false })) hash.update(chunk)
              bankHash = hash.digest('hex')
            }
            const hash = createHash('sha256')
            for await (const chunk of candidate.handle.createReadStream({ autoClose: false })) hash.update(chunk)
            if (hash.digest('hex') === bankHash) return run.outputDir
          } finally { await candidate.handle.close() }
        } catch { /* Deleted or unreadable clips are not a match. */ }
      }
    }
    return null
  } finally { await bank.handle.close() }
}

/** Only pass an extracted video ID to the metadata tool, never an arbitrary URL. */
export function youtubeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
    let id: string | null = null
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1)
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[1] ?? null
    }
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
  } catch { return null }
}

export function parseSourceContext(value: unknown): AutomationSourceContext | null {
  if (value === null || value === undefined) return null
  const source = value as AutomationSourceContext
  if (!source || typeof source !== 'object' || typeof source.title !== 'string' || source.title.length > 1024 ||
      typeof source.description !== 'string' || source.description.length > 20000 || typeof source.channel !== 'string' || source.channel.length > 1024 ||
      (source.url !== null && (typeof source.url !== 'string' || !youtubeSourceUrl(source.url)))) throw new Error('Enter a source title, description and an optional YouTube video URL.')
  if (source.videoId !== undefined && (typeof source.videoId !== 'string' || !/^[a-f0-9]{64}$/.test(source.videoId))) throw new Error('Invalid source identity.')
  return { ...(source.videoId ? { videoId: source.videoId } : {}), title: source.title.trim(), description: source.description.trim(), channel: source.channel.trim(), url: youtubeSourceUrl(source.url) }
}

export function sourceFromOutput(output: JobOutput): AutomationSourceContext {
  return { ...(!youtubeSourceUrl(output.source_video_url) && (output.source_video_url || output.job_id) ? { videoId: createHash('sha256').update(output.source_video_url || output.job_id).digest('hex') } : {}), title: output.source_video_title, description: output.source_video_description ?? '', channel: output.source_video_channel ?? '', url: youtubeSourceUrl(output.source_video_url) }
}

const sourceCache = new Map<string, { at: number; source: AutomationSourceContext }>()
/** Metadata only: no video download, cookies, user config, playlists or generic extractor. */
export async function completeSourceContext(source: AutomationSourceContext | null): Promise<AutomationSourceContext | null> {
  if (!source?.url || source.description) return source
  const url = youtubeSourceUrl(source.url)
  if (!url) return source
  const cached = sourceCache.get(url)
  if (cached && Date.now() - cached.at < 3600000) return { ...cached.source, title: source.title || cached.source.title }
  try {
    const { stdout } = await execFileAsync(resolveBinary('yt-dlp'), [
      '--ignore-config', '--skip-download', '--no-playlist', '--no-warnings', '--use-extractors', 'youtube',
      '--socket-timeout', '10', '--retries', '1', '--extractor-retries', '1',
      '--print', '{"title":%(title)j,"description":%(description)j,"channel":%(uploader)j}', '--', url
    ], { timeout: 35000, maxBuffer: 200000 })
    const info = JSON.parse(stdout.trim())
    const result = { title: source.title || String(info.title ?? '').slice(0, 1024), description: String(info.description ?? '').slice(0, 20000),
      channel: source.channel || String(info.channel ?? '').slice(0, 1024), url }
    if (sourceCache.size >= 50) sourceCache.delete(sourceCache.keys().next().value!)
    sourceCache.set(url, { at: Date.now(), source: result })
    return result
  } catch { return source } // UI explicitly shows an empty description, never claims it was retrieved.
}

/** Recover old bank imports only when the original media bytes agree. A title alone is not provenance. */
export async function recoverSourceContext(bankFile: string, title: string, library: string): Promise<AutomationSourceContext | null> {
  const bank = await openAuthorizedMedia(bankFile, library)
  try {
    let bankHash: string | null = null
    let checked = 0
    const runs = (await getJobHistory(library)).filter((run) => run.clipCount > 0).slice(0, 100)
    for (const run of runs) {
      const output = await getJobOutput(run.outputDir, library)
      if (!output) continue
      for (const clip of output.clips) {
        const originalTitle = (clip.summary || `Clip ${clip.clip_index + 1}`).replace(/[_-]+/g, ' ').trim().slice(0, 500)
        if (originalTitle !== title) continue
        const path = clip.s3_url.replace(/^file:\/\//, '')
        if (!isWithinDirectory(path, run.outputDir)) continue
        if (++checked > 12) return null
        try {
          const candidate = await openAuthorizedMedia(path, library)
          try {
            if (candidate.size !== bank.size) continue
            if (!bankHash) {
              const hash = createHash('sha256')
              for await (const chunk of bank.handle.createReadStream({ autoClose: false })) hash.update(chunk)
              bankHash = hash.digest('hex')
            }
            const hash = createHash('sha256')
            for await (const chunk of candidate.handle.createReadStream({ autoClose: false })) hash.update(chunk)
            if (hash.digest('hex') === bankHash) return sourceFromOutput(output)
          } finally { await candidate.handle.close() }
        } catch { /* A removed clip must not prevent another verified match. */ }
      }
    }
    return null
  } finally { await bank.handle.close() }
}

/** Exact context fingerprint: edited descriptions and different videos never share research. */
export function sourceResearchKey(source: AutomationSourceContext | null): string | null {
  const identity = source?.url ? youtubeSourceUrl(source.url) : source?.videoId
  if (!identity || !source) return null
  return createHash('sha256').update(JSON.stringify(['source-research-v1', identity, source.title, source.channel, source.description])).digest('hex')
}
