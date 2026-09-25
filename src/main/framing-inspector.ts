import { constants, realpathSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { getJobOutput } from './file-manager'
import { assertAbsolutePath, assertMediaPath, isWithinDirectory } from './security'
import { parseFramingTrace, type FramingInspection } from '../shared/framing-trace'

export async function inspectFraming(outputDir: string, clipIndex: number, libraryDir: string): Promise<FramingInspection> {
  assertAbsolutePath(outputDir)
  if (!Number.isSafeInteger(clipIndex) || clipIndex < 0 || clipIndex > 999 || !isWithinDirectory(outputDir, libraryDir)) throw new Error('Invalid framing request')
  const run = realpathSync(outputDir)
  const output = await getJobOutput(run, libraryDir)
  const clip = output?.clips.find((c) => c.clip_index === clipIndex)
  if (!clip) throw new Error('Clip is not in this run')
  const path = clip.s3_url.startsWith('file://') ? clip.s3_url.slice(7) : clip.s3_url
  let clipPath: string | null = null
  try {
    assertMediaPath(path, libraryDir)
    if (isWithinDirectory(path, run)) clipPath = realpathSync(path)
  } catch { /* Deleted output: recorded decisions can still be inspected. */ }
  const unavailable = (message: string): FramingInspection => ({ status: 'unavailable', message, trace: null, sourcePath: null, clipPath })
  let handle
  try {
    const tracePath = join(run, `clip_${String(clipIndex).padStart(2, '0')}.framing.json`)
    handle = await open(tracePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await handle.stat()
    const current = statSync(tracePath)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || stat.dev !== current.dev || stat.ino !== current.ino || !isWithinDirectory(tracePath, run)) throw new Error('Invalid trace file')
    // Bound the read as well as the stat: another process could grow the file.
    const bytes = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used !== stat.size) throw new Error('Trace changed while reading')
    const trace = parseFramingTrace(JSON.parse(bytes.subarray(0, used).toString('utf8')))
    if (trace.clip_index !== clipIndex) throw new Error('Mismatched trace')
    let sourcePath: string | null = null
    if (trace.source.preview_status === 'available') {
      const preview = join(run, 'framing-source.mp4')
      try {
        assertMediaPath(preview, libraryDir)
        if (isWithinDirectory(preview, run)) sourcePath = realpathSync(preview)
      } catch { /* Missing preview leaves a useful trace-only view. */ }
    }
    const limited = !sourcePath || !clipPath || trace.analysis_status !== 'recorded'
    return { status: limited ? 'limited' : 'available', trace, sourcePath, clipPath,
      message: !sourcePath ? 'The source preview is missing or capture failed. Recorded decisions are still available.'
        : !clipPath ? 'The generated clip is missing. Source and recorded decisions are still available.'
          : trace.analysis_status !== 'recorded' ? 'Analysis was unavailable for this render. Only the recorded render plan is shown.' : null }
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'No framing trace was recorded for this clip. Generate it again with “Capture framing diagnostics” enabled in Format. Opening this view does not rerun analysis.'
      : 'The framing trace is invalid or uses an unsupported version. It cannot be inspected safely.')
  } finally { await handle?.close() }
}
