import { createHash, randomUUID } from 'crypto'
import { resolve } from 'path'
import { AUTOMATION_PLATFORMS, type AutomationSourceContext, type MetadataEnhancement } from '../shared/automations'
import type { ClipArtifact, JobOutput } from '../shared/job-output'
import { clipPostingStatus, type LibraryClipPostingStatus, type LibraryEnhancementOptions } from '../shared/library-posting'
import { loadSettings } from './settings-store'
import { getJobOutput } from './file-manager'
import { assertMediaPath, authorizeMedia, isWithinDirectory, openAuthorizedMedia } from './security'
import { isAutomationMedia, listAutomations } from './automations'
import { listPosts } from './zernio/posts'
import { completeSourceContext, parseSourceContext, sourceFromOutput } from './automation-source'
import { generateAutomationMetadata, researchAutomationTopic, transcribeAutomationClip } from './automation-metadata'

const mediaPath = (value: string): string => resolve(value.replace(/^file:\/\//, ''))
const pathKey = (value: string): string => process.platform === 'win32' ? mediaPath(value).toLowerCase() : mediaPath(value)

async function libraryRun(raw: unknown): Promise<NonNullable<Awaited<ReturnType<typeof getJobOutput>>>> {
  const library = loadSettings().outputDirectory
  if (typeof raw !== 'string' || !isWithinDirectory(raw, library)) throw new Error('Choose a run in your Library.')
  const output = await getJobOutput(raw, library)
  if (!output) throw new Error('This run is no longer available in the Library.')
  return output
}

async function libraryClip(outputDir: unknown, clipIndex: unknown): Promise<{ output: JobOutput; clip: ClipArtifact; path: string }> {
  const output = await libraryRun(outputDir)
  if (!Number.isSafeInteger(clipIndex)) throw new Error('Choose a clip from this run.')
  const clip = output.clips.find((item) => item.clip_index === clipIndex)
  if (!clip) throw new Error('This clip is no longer in the run.')
  const path = mediaPath(clip.s3_url)
  if (!isWithinDirectory(path, outputDir as string)) throw new Error('The clip is outside its Library run.')
  assertMediaPath(path, loadSettings().outputDirectory)
  return { output, clip, path }
}

// Byte identity recovers old bank copies without guessing from titles or filenames.
const hashes = new Map<string, string>()
async function fingerprint(path: string): Promise<{ size: number; hash: () => Promise<string> }> {
  const opened = await openAuthorizedMedia(path, loadSettings().outputDirectory)
  const stats = await opened.handle.stat()
  const key = JSON.stringify([opened.canonical, stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino])
  await opened.handle.close()
  return { size: stats.size, hash: async () => {
    const cached = hashes.get(key)
    if (cached) return cached
    const file = await openAuthorizedMedia(path, loadSettings().outputDirectory)
    try {
      const current = await file.handle.stat()
      if (JSON.stringify([file.canonical, current.size, current.mtimeMs, current.ctimeMs, current.ino]) !== key) throw new Error('Clip changed while checking its posting history. Try again.')
      const hash = createHash('sha256')
      for await (const chunk of file.handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const after = await file.handle.stat()
      if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw new Error('Clip changed while checking its posting history. Try again.')
      const value = hash.digest('hex')
      if (hashes.size >= 256) hashes.delete(hashes.keys().next().value!)
      hashes.set(key, value)
      return value
    } finally { await file.handle.close() }
  } }
}

export async function libraryPostingStatus(outputDir: unknown): Promise<LibraryClipPostingStatus[]> {
  const output = await libraryRun(outputDir)
  const workspaceKey = loadSettings().zernioApiKey
  if (!workspaceKey) return output.clips.map((clip) => clipPostingStatus(clip.clip_index, []))
  const posts = listPosts()
  const origins = new Map(listAutomations().flatMap((automation) => automation.content.filter((item) => item.postId && item.sourceClipPath).map((item) => [item.postId!, pathKey(item.sourceClipPath!)] as const)))
  const bankPosts = posts.filter((post) => !origins.has(post.id) && isAutomationMedia(post.clipPath))
  const bankFiles = new Map<string, Awaited<ReturnType<typeof fingerprint>>>()
  for (const post of bankPosts) {
    if (bankFiles.has(post.clipPath)) continue
    try { authorizeMedia(post.clipPath); bankFiles.set(post.clipPath, await fingerprint(post.clipPath)) } catch { /* A removed bank copy cannot be matched. */ }
  }
  const statuses: LibraryClipPostingStatus[] = []
  for (const clip of output.clips) {
    const path = mediaPath(clip.s3_url)
    if (!isWithinDirectory(path, outputDir as string)) throw new Error('A clip is outside its Library run.')
    const matches = posts.filter((post) => pathKey(post.clipPath) === pathKey(path) || origins.get(post.id) === pathKey(path))
    if (bankFiles.size) {
      let original: Awaited<ReturnType<typeof fingerprint>> | null = null
      try { original = await fingerprint(path) } catch { /* Direct history remains available for removed originals. */ }
      if (original) for (const post of bankPosts) {
        const bank = bankFiles.get(post.clipPath)
        if (bank && bank.size === original.size && await bank.hash() === await original.hash()) matches.push(post)
      }
    }
    statuses.push(clipPostingStatus(clip.clip_index, matches))
  }
  if (loadSettings().zernioApiKey !== workspaceKey) throw new Error('The posting workspace changed. Refresh the Library.')
  return statuses
}

export async function libraryMetadataSource(outputDir: unknown, clipIndex: unknown): Promise<AutomationSourceContext | null> {
  const { output } = await libraryClip(outputDir, clipIndex)
  return completeSourceContext(sourceFromOutput(output))
}

const enhancing = new Set<string>()
export async function enhanceLibraryMetadata(outputDir: unknown, clipIndex: unknown, raw: unknown): Promise<MetadataEnhancement> {
  if (!raw || typeof raw !== 'object') throw new Error('Choose enhancement options.')
  const options = raw as LibraryEnhancementOptions
  if (!Array.isArray(options.platforms) || !options.platforms.length || options.platforms.length > AUTOMATION_PLATFORMS.length ||
      !options.platforms.every((platform) => AUTOMATION_PLATFORMS.includes(platform)) || new Set(options.platforms).size !== options.platforms.length ||
      typeof options.research !== 'boolean' || (options.notes !== undefined && (typeof options.notes !== 'string' || options.notes.length > 63206)) ||
      (options.facebookFormat !== undefined && !['feed', 'reel'].includes(options.facebookFormat))) throw new Error('Choose valid platforms and enhancement options.')
  const { output, clip, path } = await libraryClip(outputDir, clipIndex)
  const settings = loadSettings()
  if (!settings.openrouterApiKey) throw new Error('Add an OpenRouter key in Settings to enhance metadata.')
  if (enhancing.has(path) || enhancing.size >= 2) throw new Error('Wait for the current metadata enhancement to finish.')
  let source = options.source === undefined ? sourceFromOutput(output) : parseSourceContext(options.source)
  const ensureCurrent = (): void => {
    const current = loadSettings()
    if (current.openrouterApiKey !== settings.openrouterApiKey || current.outputDirectory !== settings.outputDirectory || current.zernioApiKey !== settings.zernioApiKey) throw new Error('Settings changed during enhancement. Try again.')
  }
  enhancing.add(path)
  try {
    source = await completeSourceContext(source); ensureCurrent()
    const transcript = await transcribeAutomationClip(path); ensureCurrent()
    const research = options.research ? await researchAutomationTopic(transcript, source)
      : { status: 'skipped' as const, summary: 'Web research was turned off.', sources: [] }
    ensureCurrent()
    const posts = await generateAutomationMetadata(transcript, clip.summary || 'Untitled clip', options.notes ?? '', options.platforms, { source, research, facebookFormat: options.facebookFormat })
    ensureCurrent()
    return { id: randomUUID(), createdAt: new Date().toISOString(), platforms: options.platforms, source, research, posts }
  } finally { enhancing.delete(path) }
}
