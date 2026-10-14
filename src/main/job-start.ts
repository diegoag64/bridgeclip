import { createHash, randomUUID } from 'crypto'
import { getSettingsForBridge, loadSettings, type AppSettings } from './settings-store'
import { ensureOutputDir } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, preflightCheck, resolvePythonPath, validatePython, type ClipJobConfig } from './pipeline-runner'
import { createRunRecord, finishRunRecord, readRunRecord, readRunRequest, writeRunRequest } from './run-history'
import { enqueueJob, getJob, isJobStillActive } from './job-manager'
import { logger } from './logger'
import { assertMediaPath, authorizeMedia, isWebUrl } from './security'
import { assertPublicWebUrl } from './network-policy'
import { validateJobConfig } from './validation'
import { resolveAdvancedModels } from './openrouter-models'
import { supportsCaptionFilter } from './tools'
import type { JobSnapshot } from '../shared/jobs'

/** A passing engine check is reused briefly, so queuing several videos stays quick. */
const ENGINE_CHECK_TTL_MS = 5 * 60 * 1000
let lastEngineCheck: { key: string; at: number } | null = null

export type StartJobResult = { jobId: string; queued: boolean; job: JobSnapshot } | { error: string }

const resuming = new Set<string>()
function settingsFingerprint(settings: AppSettings = loadSettings()): string {
  const options = { ...getSettingsForBridge(settings) }
  delete options.OPENROUTER_API_KEY
  delete options.LOCAL_OUTPUT_DIR
  return createHash('sha256').update(JSON.stringify([options, settings.customVocabulary])).digest('hex')
}

export async function resumeClipJobRequest(id: unknown): Promise<StartJobResult> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return { error: 'Choose a saved job to resume.' }
  if (resuming.has(id) || isJobStillActive(id)) return { error: 'This job is already running or still stopping.' }
  const output = loadSettings().outputDirectory
  const record = readRunRecord(output, id)
  if (!record || record.status === 'completed') return { error: 'Only unfinished jobs can be resumed.' }
  const saved = readRunRequest(output, id)
  const request = saved?.request ?? getJob(id)?.request
  if (!request) return { error: 'This older run has no saved settings. Start it from Create; new jobs save recovery checkpoints.' }
  if (saved && saved.settingsFingerprint !== settingsFingerprint()) return { error: 'AI review or vocabulary settings changed. Restore the original settings to resume without repeating paid work, or start a new job from Create.' }
  try {
    const config = validateJobConfig(request)
    // Choosing a persisted local run authorizes its original media again after
    // app restart. The engine also checks the saved source size and timestamp.
    if (saved && !isWebUrl(config.videoUrl)) authorizeMedia(config.videoUrl)
  } catch { return { error: 'The original source or saved job settings are unavailable. Restore the source file and try again.' } }
  resuming.add(id)
  try { return await startClipJobRequest(request, id) }
  finally { resuming.delete(id) }
}

/**
 * Validate a clipping request, check the engine and keys, create its run
 * folder and queue it. Used by the Create page and the assistant alike; it
 * needs no window, so jobs can start while every window is closed.
 */
export async function startClipJobRequest(request: unknown, resumeId?: string): Promise<StartJobResult> {
  const originalDirectory = loadSettings().outputDirectory
  const originalFingerprint = settingsFingerprint()
  let config: ClipJobConfig
  try {
    config = validateJobConfig(request)
    if (config.clippingMode === 'advanced') {
      config.plannerCapabilities = await resolveAdvancedModels(config.plannerModel!, config.transcriptionModel!)
    }
    if (isWebUrl(config.videoUrl)) await assertPublicWebUrl(config.videoUrl)
    else assertMediaPath(config.videoUrl, loadSettings().outputDirectory)
    if (config.bannerChannelUrl) await assertPublicWebUrl(config.bannerChannelUrl)
  } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid job options' } }
  const settings = { ...loadSettings() }

  if (!settings.openrouterApiKey) {
    logger.warn('job.start.missingKey', { key: 'OPENROUTER_API_KEY' })
    return { error: 'OpenRouter API key is required for AI clip planning. Go to Settings to add it.' }
  }

  const enginePath = getEnginePath()
  const bridgePath = getBridgeRunnerPath()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

  const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
  if (!preflight.ok) {
    const message = preflight.hint
      ? `${preflight.error}\n\n${preflight.hint}`
      : preflight.error!
    logger.error('job.start.preflight.failed', {
      error: preflight.error,
      hint: preflight.hint,
      pythonPath,
      bridgePath,
      enginePath
    })
    return { error: message }
  }
  const engineKey = `${pythonPath}\0${enginePath}`
  if (!lastEngineCheck || lastEngineCheck.key !== engineKey || Date.now() - lastEngineCheck.at > ENGINE_CHECK_TTL_MS) {
    const pythonValidation = await validatePython(pythonPath, enginePath)
    if (!pythonValidation.ok) {
      lastEngineCheck = null
      return { error: 'The clipping engine is incomplete or incompatible. Open Settings → System check, then repair the BridgeClip installation before starting.' }
    }
    lastEngineCheck = { key: engineKey, at: Date.now() }
  }
  if (config.includeCaptions && !(await supportsCaptionFilter())) {
    return { error: 'FFmpeg cannot render captions because its ass filter is missing. Install an FFmpeg build with libass, or turn captions off.' }
  }

  ensureOutputDir(settings.outputDirectory)

  if (resumeId && (isJobStillActive(resumeId) || settings.outputDirectory !== originalDirectory ||
      loadSettings().outputDirectory !== originalDirectory || settingsFingerprint() !== originalFingerprint || settingsFingerprint(settings) !== originalFingerprint ||
      !readRunRecord(settings.outputDirectory, resumeId))) {
    return { error: 'The job or output folder changed. Refresh Jobs and try again.' }
  }
  const jobId = resumeId ?? randomUUID()
  logger.info('job.start.request', { jobId, sourceType: isWebUrl(config.videoUrl) ? 'remote' : 'local', aspectRatio: config.aspectRatio })
  try {
    createRunRecord(settings.outputDirectory, jobId, config.videoUrl)
    writeRunRequest(settings.outputDirectory, jobId, config, settingsFingerprint(settings))
  } catch {
    try { finishRunRecord(settings.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch { /* Output folder may be unavailable. */ }
    return { error: 'Could not create the clipping run. Check the output folder and retry.' }
  }
  // Starts now when a slot is free; otherwise waits its turn in the queue.
  const job = enqueueJob(jobId, config, settings.outputDirectory, settings)
  return { jobId, queued: job.status === 'queued', job }
}
