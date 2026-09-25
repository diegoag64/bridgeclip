import { constants, realpathSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { assertAbsolutePath, isWithinDirectory } from './security'
import { parseEditAudit, type EditAudit } from '../shared/editorial'

async function readRecordedJson(run: string, name: string): Promise<unknown> {
  const path = join(run, name)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat(), current = statSync(path)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || stat.dev !== current.dev || stat.ino !== current.ino || !isWithinDirectory(path, run)) throw new Error('Invalid edit trace')
    const bytes = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used !== stat.size) throw new Error('Edit trace changed while reading')
    return JSON.parse(bytes.subarray(0, used).toString('utf8'))
  } finally { await handle.close() }
}

export async function inspectEdits(outputDir: string, libraryDir: string): Promise<EditAudit> {
  assertAbsolutePath(outputDir)
  if (!isWithinDirectory(outputDir, libraryDir)) throw new Error('Run is outside the library')
  const run = realpathSync(outputDir)
  if (!isWithinDirectory(run, realpathSync(libraryDir)) || run === realpathSync(libraryDir)) throw new Error('Invalid run folder')
  try { return parseEditAudit(await readRecordedJson(run, 'edit_audit.json')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The saved edit trace is invalid or unsupported.')
    const transcript = await readRecordedJson(run, 'transcript.json') as { segments?: { start_time_ms: number; end_time_ms: number; text: string }[] }
    if (!Array.isArray(transcript?.segments) || transcript.segments.length > 100000) throw new Error('Invalid saved transcript')
    return parseEditAudit({ version: 1, title: 'Recorded transcript', duration_ms: transcript.segments.reduce((end, s) => Math.max(end, s.end_time_ms), 0),
      preferred_range: [null, null], outcome: 'legacy_transcript_only', planner: { requests: [] }, candidates: [],
      transcript: (transcript.segments ?? []).map(s => ({ start_ms: s.start_time_ms, end_ms: s.end_time_ms, text: s.text })) })
  }
}
