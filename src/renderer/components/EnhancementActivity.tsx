import { useEffect, useState } from 'react'
import { Check, Loader2, Sparkles } from 'lucide-react'
import { useEnhancementStore } from '../store/use-enhancement-store'
import { Button } from './ui/Button'

const PHASES = { preparing: 'Preparing clips', transcribing: 'Transcribing audio', researching: 'Checking source research', writing: 'Writing titles & descriptions', saving: 'Saving drafts' }

/** Mounted above page content so both progress and stop controls survive navigation. */
export function EnhancementActivity(): React.JSX.Element | null {
  const { jobs, connectionError, refresh, control } = useEnhancementStore()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      await refresh()
      if (active) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [refresh])
  if (!jobs.length) return null
  const act = async (id: string, action: 'stop' | 'dismiss'): Promise<void> => {
    setError(null)
    try { await control(id, action) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this enhancement.') }
  }
  return <section aria-label="Video enhancement progress" className="no-drag max-h-64 shrink-0 overflow-y-auto border-b border-white/[0.08] bg-surface/95 px-5 py-3">
    {jobs.map(job => {
      const running = job.status === 'running'
      const seconds = Math.max(0, Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000))
      const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      return <div key={job.id} className="mx-auto max-w-5xl space-y-2 py-1">
        <div className="flex items-center gap-2 text-sm">
          {running ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-accent motion-reduce:animate-none" /> : job.failed || job.status === 'failed' ? <Sparkles aria-hidden className="h-4 w-4 text-warning" /> : <Check aria-hidden className="h-4 w-4 text-success" />}
          <strong className="shrink-0">{running ? 'Enhancing video metadata' : job.status === 'stopped' ? 'Enhancement stopped' : job.failed || job.status === 'failed' ? 'Enhancement finished with errors' : 'Enhancement complete'}</strong>
          <span className="min-w-0 truncate text-ink-muted" title={`${job.automationName} · ${job.sourceTitle}`}>{job.automationName} · {job.sourceTitle}</span>
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-ink-muted">{elapsed}</span>
          {running ? <Button size="sm" disabled={job.stopRequested} onClick={() => void act(job.id, 'stop')}>{job.stopRequested ? 'Stopping…' : 'Stop after batch'}</Button>
            : <Button size="sm" variant="ghost" onClick={() => void act(job.id, 'dismiss')}>Dismiss</Button>}
        </div>
        <div role="status" className="text-xs text-ink-muted">
          {running ? <>{job.stopRequested ? 'Finishing the current batch; remaining clips will stay queued.' : `${PHASES[job.stage.phase]}${job.stage.clipIndex ? ` · clip ${job.stage.clipIndex} of ${job.total}` : ` · batch ${Math.ceil(job.batchStart / 5)} of ${Math.ceil(job.total / 5)}`}`}{job.stage.clipTitle && <span className="ml-1">· {job.stage.clipTitle}</span>}</>
            : <>{job.completed} drafts ready to review · {job.failed} failed · {job.skipped} already handled · {job.total - job.processed} not attempted. {job.status === 'stopped' ? 'Stopped after the current batch.' : 'Saved drafts are ready in the content bank.'}</>}
        </div>
        <div className="flex items-center gap-3">
          <progress aria-label={`Enhancement progress for ${job.sourceTitle}`} max={job.total} value={job.processed} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-white/10 [&::-webkit-progress-value]:bg-accent" />
          <span className="shrink-0 text-xs tabular-nums text-ink-muted">{job.processed} / {job.total} clips processed{running ? ` · ${job.completed} drafts ready${job.failed ? ` · ${job.failed} failed` : ''}` : ''}</span>
        </div>
        {!!job.errors.length && <p className="text-xs text-warning">{job.errors.slice(0, 3).join(' · ')} Failed clips remain available to retry.</p>}
      </div>
    })}
    {(connectionError || error) && <p role="alert" className="mx-auto mt-2 max-w-5xl text-xs text-warning">{error || connectionError}</p>}
  </section>
}
