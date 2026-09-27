import { execFile, spawn, type ChildProcess } from 'child_process'
import { constants, closeSync, createWriteStream, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { pipeline } from 'stream/promises'
import { delimiter, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { parseCandidateEdit, parseEditorProject, renderEditKey, sourceReplacementErrors, type CandidateEdit, type EditorSession } from '../shared/clip-editor'
import { loadSettings, getSettingsForBridge } from './settings-store'
import { assertAbsolutePath, assertMediaPath, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, resolvePythonPath, runtimeEnvironment } from './pipeline-runner'
import { resolveBinary } from './tools'

interface EditorOperation { progress?: EditorSession['progress']; action: NonNullable<EditorSession['operation']>; child?: ChildProcess; cancelled?: boolean; abort?: AbortController; batch?: { completed: number; total: number } }
const operations = new Map<string, EditorOperation>()
export function editorBusy(path: string): boolean { return operations.has(realpathSync(path)) }
function runPath(path: unknown): string {
  assertAbsolutePath(path)
  const run = realpathSync(path as string), library = realpathSync(loadSettings().outputDirectory)
  if (dirname(run) !== library || lstatSync(path as string).isSymbolicLink()) throw new Error('Editor project is outside the library')
  return run
}
function readProject(run: string): ReturnType<typeof parseEditorProject> {
  const path = join(run, 'editor-project.json')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !isWithinDirectory(path, run)) throw new Error('Invalid editor file')
    const data = Buffer.alloc(stat.size + 1)
    let used = 0, count = 0
    do { count = readSync(fd, data, used, data.length - used, null); used += count } while (count && used < data.length)
    if (used !== stat.size) throw new Error('Editor project changed while reading')
    return parseEditorProject(JSON.parse(data.subarray(0, used).toString('utf8')))
  } finally { closeSync(fd) }
}
export async function openEditor(path: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (!(await getJobOutput(run, loadSettings().outputDirectory))?.editor_project) throw new Error('This run has no editor project')
  const project = readProject(run), suffix = project.source_id ? `-${project.source_id}` : ''
  const sourcePath = join(run, `editor-source${suffix}.mp4`), previewPath = join(run, `editor-preview${project.preview_id ? `-${project.preview_id}` : suffix}.mp4`)
  for (const file of [sourcePath, previewPath]) {
    if (lstatSync(file).isSymbolicLink() || !isWithinDirectory(file, run)) throw new Error('Editor source is missing')
    assertMediaPath(file, loadSettings().outputDirectory)
  }
  return { project, sourcePath, previewPath, progress: operations.get(run)?.progress ? { ...operations.get(run)!.progress! } : undefined, operation: operations.get(run)?.action ?? null, batch: operations.get(run)?.batch ? { ...operations.get(run)!.batch! } : undefined }
}
export async function saveEditor(path: unknown, revision: unknown, edits: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    const { project } = await openEditor(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error('This project changed. Reopen it before saving.')
    if (!Array.isArray(edits) || edits.length !== project.candidates.length) throw new Error('Invalid candidate edits')
    const clean = edits.map((c) => parseCandidateEdit(c, project.duration_ms, project.transcript.length))
    if (new Set(clean.map((c) => c.id)).size !== clean.length) throw new Error('Duplicate candidates')
    project.candidates = project.candidates.map((c) => {
      const edit = clean.find((e) => e.id === c.id)
      if (!edit) throw new Error('Candidate is missing')
      if (edit.status === 'baked' && (c.status !== 'baked' || renderEditKey(edit) !== renderEditKey(c))) throw new Error('Only a completed render can mark a clip as baked')
      return { ...c, ...edit }
    })
    project.revision++
    const data = JSON.stringify(project)
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('This editor project has too many caption edits to save')
    if (runPath(run) !== run) throw new Error('Editor folder changed')
    const temporary = join(run, `.editor-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, join(run, 'editor-project.json'))
    } finally { try { unlinkSync(temporary) } catch { /* Already committed. */ } }
  } finally { operations.delete(run) }
  return openEditor(run)
}
function stop(child?: ChildProcess, force = false): void {
  if (!child?.pid) return
  try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => {}); else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Already exited. */ }
}
export function stopEditorsForQuit(): void { for (const op of operations.values()) { op.abort?.abort(); stop(op.child, true) } }
export function cancelEditor(path: unknown): void {
  const operation = operations.get(runPath(path))
  if (operation) operation.cancelled = true
  operation?.abort?.abort()
  const child = operation?.child
  stop(child)
  if (child) { const timer = setTimeout(() => stop(child, true), 3000); timer.unref(); child.once('close', () => clearTimeout(timer)) }
}
export async function replaceEditorSource(path: unknown, revision: unknown, replacement: unknown): Promise<EditorSession> {
  assertAbsolutePath(replacement)
  return executeEditor(path, revision, undefined, 'replace-source', replacement)
}
export async function runEditor(path: unknown, revision: unknown, candidateId: unknown, action: unknown): Promise<EditorSession> {
  if (action !== 'review' && action !== 'export' && action !== 'export-all' && action !== 'scan-cameras') throw new Error('Invalid editor operation')
  return executeEditor(path, revision, candidateId, action)
}
async function executeEditor(path: unknown, revision: unknown, candidateId: unknown, action: 'review' | 'export' | 'export-all' | 'scan-cameras' | 'replace-source', replacement?: string): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action, ...(action === 'scan-cameras' ? { progress: { phase: 'scan', percent: 0 } as const } : {}) }
  operations.set(run, operation)
  const sourceId = action === 'replace-source' ? randomUUID().replaceAll('-', '') : undefined
  const previewId = action === 'scan-cameras' ? randomUUID().replaceAll('-', '') : undefined
  let previousPreview: string | undefined
  let previousMedia: string[] = []
  try {
    const session = await openEditor(run)
    previousPreview = session.previewPath
    if (revision !== session.project.revision || (action !== 'export-all' && action !== 'replace-source' && !session.project.candidates.some((c) => c.id === candidateId))) throw new Error('Project changed. Reopen it and retry.')
    if (sourceId) {
      const media = await openAuthorizedMedia(replacement!, loadSettings().outputDirectory)
      operation.abort = new AbortController()
      try {
        if (operation.cancelled) throw new Error('Source replacement cancelled.')
        await pipeline(media.handle.createReadStream({ autoClose: false }), createWriteStream(join(run, `editor-source-${sourceId}.mp4`), { flags: 'wx', mode: 0o600 }), { signal: operation.abort.signal })
      } finally { await media.handle.close() }
      previousMedia = [session.sourcePath, session.previewPath]
    }
    if (action === 'export' && session.project.candidates.find((c) => c.id === candidateId)!.status !== 'ready') throw new Error('Mark this clip ready before baking it')
    const candidates = action === 'replace-source' ? session.project.candidates.slice(0, 1) : action === 'export-all' ? session.project.candidates.filter((c) => c.status === 'ready') : session.project.candidates.filter((c) => c.id === candidateId)
    if (!candidates.length) throw new Error('Mark at least one clip ready before baking.')
    if (action === 'export-all') operation.batch = { completed: 0, total: candidates.length }
    const settings = loadSettings(), engine = getEnginePath()
    if (action === 'review' && (!settings.openrouterApiKey || settings.jevEnabled !== 'on')) throw new Error('Enable Jev and add your OpenRouter key in Settings to run this review.')
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge(settings), PYTHONPATH: engine, PYTHONUNBUFFERED: '1' }
    const ffmpeg = resolveBinary('ffmpeg')
    if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
    for (const candidate of candidates) {
      if (operation.cancelled) throw new Error('Export cancelled.')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(resolvePythonPath(engine, settings.pythonPath), [join(dirname(getBridgeRunnerPath()), 'editor_runner.py')],
          { cwd: engine, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
        operation.child = child
        let stdout = '', settled = false, protocolFailed = false
        let result: { ok: boolean; error?: unknown } | undefined
        const consume = (line: string): void => {
          if (!line.trim()) return
          if (line.length > 16384) { protocolFailed = true; stop(child); return }
          try {
            const value = JSON.parse(line)
            if (value?.type === 'progress') {
              if (action === 'scan-cameras' && (value.phase === 'scan' || value.phase === 'preview') &&
                  typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) {
                const previous = operation.progress
                if (!previous || (previous.phase === 'scan' && value.phase === 'preview') ||
                    (previous.phase === value.phase && value.percent >= previous.percent)) {
                  operation.progress = { phase: value.phase, percent: Math.floor(value.percent) }
                }
              }
            } else if (typeof value?.ok === 'boolean' && !result) result = value
            else protocolFailed = true
          } catch { protocolFailed = true }
        }
        const timer = setTimeout(() => stop(child, true), 30 * 60 * 1000)
        const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve() }
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
          let end: number
          while ((end = stdout.indexOf('\n')) >= 0) { consume(stdout.slice(0, end)); stdout = stdout.slice(end + 1) }
          if (stdout.length > 16384) { protocolFailed = true; stdout = ''; stop(child) }
        })
        child.stderr.resume() // Provider output may contain private data. Never forward it.
        child.on('error', () => finish(new Error('Could not start the editor engine. Check your Python setup.')))
        child.on('close', (code) => {
          let ok = false, reason: string | undefined
          consume(stdout)
          ok = !protocolFailed && result?.ok === true
          if (typeof result?.error === 'string' && Object.hasOwn(sourceReplacementErrors, result.error)) reason = sourceReplacementErrors[result.error]
          finish(code === 0 && ok ? undefined : new Error(action === 'scan-cameras' ? 'Camera scan stopped or failed. Your edits and previous markers are saved. Try scanning a shorter clip.' : action === 'replace-source' ? (reason ?? 'Source replacement stopped or failed. Reopen the editor to check its current source, then try again.') : action !== 'review' ? 'Export stopped or failed. Your edits are saved; check System check and try again.' : 'Review stopped or failed. Your previous review is preserved. Try again.'))
        })
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify({ run, library: realpathSync(settings.outputDirectory), revision, candidate_id: candidate.id, action: action === 'export-all' ? 'export' : action, source_id: sourceId, preview_id: previewId }))
      })
      operation.child = undefined
      if (operation.batch) operation.batch.completed++
      revision = readProject(run).revision
    }
  } catch (error) {
    if (operation.batch) throw new Error(`Baked ${operation.batch.completed} of ${operation.batch.total} ready clips. ${operation.cancelled ? 'Batch cancelled.' : 'Batch stopped: ' + (error instanceof Error ? error.message : 'Export failed.')} Remaining clips are still ready.`)
    throw error
  } finally {
    if (previewId) {
      let active: string | undefined, readable = false
      try { active = readProject(run).preview_id; readable = true } catch { /* Preserve media if state is unreadable. */ }
      const stale = !readable ? [] : active === previewId ? (previousPreview ? [previousPreview] : [])
        : [join(run, `editor-preview-${previewId}.mp4`), join(run, `editor-preview-${previewId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* A playing preview can remain open on Windows. */ } }
    }
    if (sourceId) {
      // The JSON pointer switches both media files together. Never delete the active pair,
      // including when cancellation/worker exit races with the commit.
      let active: string | undefined, readable = false
      try { active = readProject(run).source_id; readable = true } catch { /* Preserve files if the project cannot be read. */ }
      const stale = !readable ? [] : active === sourceId ? previousMedia : [join(run, `editor-source-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* Open previews may remain until a later cleanup on Windows. */ } }
    }
    operations.delete(run)
  }
  return openEditor(run)
}
// Keep IPC's editable surface narrow; no media paths, reviews or export records come from React.
export type { CandidateEdit }
