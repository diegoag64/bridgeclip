import { randomUUID } from 'crypto'
import { MAX_ENHANCEMENT_GUIDANCE, type EnhancementJob, type EnhancementStage } from '../shared/automations'
import { automationEnhancementGroups, enhanceAutomationBatch, listAutomations } from './automations'
import { loadSettings } from './settings-store'
import { workspaceId } from './zernio/workspace-cache'

// Runs belong to main, not to the page that started them. Reloading a window
// reconnects to the same work; quitting the app still stops processing.
const jobs = new Map<string, { workspace: string; job: EnhancementJob }>()
const starting = new Set<string>()
const workspace = (): string => workspaceId(loadSettings().zernioApiKey)

export function listEnhancementJobs(): EnhancementJob[] {
  return [...jobs.values()].filter(entry => entry.workspace === workspace()).map(entry => structuredClone(entry.job))
}

export async function startEnhancementJob(id: unknown, key: unknown, guidance: unknown = ''): Promise<EnhancementJob> {
  if (typeof id !== 'string' || typeof key !== 'string') throw new Error('Choose an automation and source video.')
  if (typeof guidance !== 'string' || guidance.length > MAX_ENHANCEMENT_GUIDANCE) throw new Error('Use a prompt of up to 2000 characters.')
  const owner = workspace(), lock = `${owner}:${id}`
  if (starting.has(lock) || listEnhancementJobs().some(job => job.automationId === id && job.status === 'running')) throw new Error('This automation already has an enhancement in progress.')
  starting.add(lock)
  try {
    const automation = listAutomations().find(item => item.id === id)
    if (!automation) throw new Error('Automation not found.')
    const group = (await automationEnhancementGroups(id)).find(group => group.key === key)
    if (workspace() !== owner) throw new Error('The workspace changed. Please try again.')
    if (!group?.contentIds.length) throw new Error('No queued clips need a new draft. Refresh the source videos.')
    const ids = group.contentIds.slice(0, 30)
    const job: EnhancementJob = { id: randomUUID(), automationId: id, automationName: automation.name,
      sourceTitle: group.title, total: ids.length, processed: 0, completed: 0, failed: 0, skipped: 0,
      batchStart: 1, batchEnd: Math.min(5, ids.length), stage: { phase: 'preparing' },
      status: 'running', stopRequested: false, startedAt: Date.now(), finishedAt: null, errors: [] }
    // Keep only the latest result for this automation; bound other finished runs.
    for (const [jobId, entry] of jobs) if (entry.job.status !== 'running' && (entry.job.automationId === id || jobs.size >= 20)) jobs.delete(jobId)
    jobs.set(job.id, { workspace: owner, job })
    void run(job, owner, ids, key, guidance.trim())
    return structuredClone(job)
  } finally { starting.delete(lock) }
}

async function run(job: EnhancementJob, owner: string, ids: string[], key: string, guidance: string): Promise<void> {
  try {
    for (let offset = 0; offset < ids.length && !job.stopRequested; offset += 5) {
      if (workspace() !== owner) throw new Error('The workspace changed. Remaining clips were not attempted.')
      const batch = ids.slice(offset, offset + 5)
      job.batchStart = offset + 1; job.batchEnd = offset + batch.length
      job.stage = { phase: 'preparing' }
      try {
        const result = await enhanceAutomationBatch(job.automationId, batch, key, guidance, (stage: EnhancementStage) => {
          job.stage = { ...stage, ...(stage.clipIndex === undefined ? {} : { clipIndex: offset + stage.clipIndex }) }
        })
        job.completed += result.completed; job.skipped += result.skipped
        job.failed += result.errors.length; job.errors.push(...result.errors.map(error => error.message))
      } catch (error) {
        job.failed += batch.length
        job.errors.push(error instanceof Error ? error.message : 'Could not enhance this batch.')
      }
      job.processed += batch.length
    }
    job.status = job.stopRequested && job.processed < job.total ? 'stopped' : 'completed'
  } catch (error) {
    job.status = 'failed'
    job.errors.push(error instanceof Error ? error.message : 'Enhancement stopped unexpectedly.')
  } finally { job.finishedAt = Date.now() }
}

export function controlEnhancementJob(id: unknown, action: unknown): EnhancementJob[] {
  const entry = typeof id === 'string' ? jobs.get(id) : undefined
  if (!entry || entry.workspace !== workspace()) throw new Error('Enhancement run not found.')
  if (action === 'stop') entry.job.stopRequested = true
  else if (action === 'dismiss' && entry.job.status !== 'running') jobs.delete(entry.job.id)
  else throw new Error('Wait for this enhancement to finish before dismissing it.')
  return listEnhancementJobs()
}
