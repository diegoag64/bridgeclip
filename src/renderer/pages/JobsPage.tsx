import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Clapperboard, Clock3, Eye, FolderOpen, ListVideo, Plus, Receipt, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import type { HistoryEntry } from '../../preload/index'
import { parseJobOutput } from '../../shared/job-output'
import { MAX_PARALLEL_JOBS } from '../../shared/jobs'
import { InspectEditsButton } from '../components/EditInspector'
import { BackLink, ClipList } from '../components/ClipList'
import { JobFailure, JobProgress, STAGE_LABELS } from '../components/JobProgress'
import type { Page as AppPage } from '../components/Sidebar'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { EmptyState } from '../components/ui/EmptyState'
import { TextInput } from '../components/ui/Field'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Skeleton } from '../components/ui/Skeleton'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatDate, formatDuration, formatTimecode, formatUsd, sourceLabel } from '../lib/utils'
import { isJobActive, useActiveJobs, useJobStore, type Job, type JobOutput } from '../store/use-job-store'

type Filter = 'all' | HistoryEntry['status']

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'incomplete', label: 'Older unfinished' }
]

const STATUS: Record<HistoryEntry['status'], { label: string; tone: 'success' | 'accent' | 'danger' | 'warning' | 'neutral' }> = {
  completed: { label: 'Completed', tone: 'success' },
  running: { label: 'Running', tone: 'accent' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  incomplete: { label: 'Unfinished', tone: 'warning' }
}

/**
 * Clipping jobs: what is running or queued right now (live, from the main
 * process) and every earlier run in the output folder. Opening a job shows its
 * progress, its clips, or what went wrong.
 */
export function JobsPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const focusedJobId = useJobStore((s) => s.focusedJobId)
  const focused = useJobStore((s) => (s.focusedJobId ? s.jobs[s.focusedJobId] ?? null : null))
  const focusJob = useJobStore((s) => s.focusJob)
  const active = useActiveJobs()
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openRun, setOpenRun] = useState<{ entry: HistoryEntry; output: JobOutput } | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (manual = false) => {
    const request = ++requestId.current
    if (manual) setRefreshing(true)
    try {
      const result = await getApi().history.list()
      if (request === requestId.current) { setEntries(result); setError(null) }
    } catch (err) {
      if (request === requestId.current) {
        setEntries((previous) => previous ?? [])
        setError(errorMessage(err, 'Could not load previous jobs.'))
      }
    } finally {
      if (request === requestId.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 10000)
    return () => { window.clearInterval(timer); requestId.current++ }
  }, [load])

  // A job finishing moves it from Active to Previous; refresh the list then.
  const activeCount = active.length
  useEffect(() => { void load() }, [activeCount, load])

  // A focused job that was dismissed elsewhere falls back to the list.
  useEffect(() => {
    if (focusedJobId && !focused) focusJob(null)
  }, [focusedJobId, focused, focusJob])

  const cancel = async (job: Job): Promise<void> => {
    try {
      if (!await getApi().job.cancel(job.id)) setError('This job already finished.')
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel this job.'))
    }
  }

  const runAgain = async (job: Job): Promise<void> => {
    setError(null)
    try {
      const result = await getApi().job.start(job.request)
      if (result.error) setError(result.error)
      else if (result.jobId) focusJob(result.jobId)
    } catch (err) {
      setError(errorMessage(err, 'Could not start this job again.'))
    }
  }

  const openEntry = async (entry: HistoryEntry): Promise<void> => {
    setError(null)
    try {
      const output = parseJobOutput(await getApi().history.getJob(entry.outputDir))
      if (!output) { setError('This run’s saved clips are unavailable.'); return }
      setOpenRun({ entry, output })
      document.getElementById('page-scroll')?.scrollTo({ top: 0 })
    } catch (err) {
      setError(errorMessage(err, 'Could not open this run.'))
    }
  }

  const openFolder = async (outputDir: string): Promise<void> => {
    try {
      if (!await getApi().shell.openPath(outputDir)) setError('This run folder is unavailable.')
    } catch (err) {
      setError(errorMessage(err, 'Could not open this run folder.'))
    }
  }

  const back = <BackLink label="All jobs" onClick={() => { focusJob(null); setOpenRun(null) }} />
  const errorCallout = error && (
    <Page width="focus" className="pb-0">
      <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>
    </Page>
  )

  if (focused) {
    if (isJobActive(focused)) {
      return <>{errorCallout}<JobProgress job={focused} leading={back} onCancel={() => { void cancel(focused) }} /></>
    }
    if (focused.status === 'completed' && focused.output) {
      return <ClipList output={focused.output} outputDir={focused.outputDir} onNavigate={onNavigate} leading={back} />
    }
    if (focused.status === 'failed') {
      return <>{errorCallout}<div className="px-6 pt-3"><InspectEditsButton outputDir={focused.outputDir} /></div><JobFailure job={focused} leading={back} onRetry={() => { void runAgain(focused) }} /></>
    }
    return <>{errorCallout}<JobCancelled job={focused} leading={back} onRetry={() => { void runAgain(focused) }} /></>
  }

  if (openRun) {
    return <ClipList output={openRun.output} outputDir={openRun.entry.outputDir} onNavigate={onNavigate} leading={back} />
  }

  return (
    <JobsList
      active={active}
      entries={entries}
      filter={filter}
      query={query}
      error={error}
      refreshing={refreshing}
      onFilter={setFilter}
      onQuery={setQuery}
      onDismissError={() => setError(null)}
      onRefresh={() => { void load(true) }}
      onNew={() => onNavigate('clip')}
      onOpenJob={(job) => { focusJob(job.id); document.getElementById('page-scroll')?.scrollTo({ top: 0 }) }}
      onCancel={(job) => { void cancel(job) }}
      onOpenEntry={(entry) => {
        // This session's jobs open their live view; older runs load from disk.
        if (useJobStore.getState().jobs[entry.jobId]) focusJob(entry.jobId)
        else void openEntry(entry)
      }}
      onOpenFolder={(dir) => { void openFolder(dir) }}
    />
  )
}

function JobsList({ active, entries, filter, query, error, refreshing, onFilter, onQuery, onDismissError, onRefresh, onNew, onOpenJob, onCancel, onOpenEntry, onOpenFolder }: {
  active: Job[]
  entries: HistoryEntry[] | null
  filter: Filter
  query: string
  error: string | null
  refreshing: boolean
  onFilter: (filter: Filter) => void
  onQuery: (query: string) => void
  onDismissError: () => void
  onRefresh: () => void
  onNew: () => void
  onOpenJob: (job: Job) => void
  onCancel: (job: Job) => void
  onOpenEntry: (entry: HistoryEntry) => void
  onOpenFolder: (dir: string) => void
}): React.JSX.Element {
  const sessionJobs = useJobStore((s) => s.jobs)
  const liveIds = useMemo(() => new Set(active.map((job) => job.id)), [active])
  // Queued and running jobs show above; their disk records would duplicate them.
  const previous = useMemo(() => (entries ?? []).filter((entry) => !liveIds.has(entry.jobId) && entry.status !== 'running'), [entries, liveIds])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return previous.filter((entry) =>
      (filter === 'all' || entry.status === filter) &&
      (!q || entry.videoTitle.toLowerCase().includes(q) || entry.jobId.toLowerCase().includes(q)))
  }, [previous, filter, query])
  const counts = previous.reduce<Partial<Record<Filter, number>>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1
    return acc
  }, { all: previous.length })
  const running = active.filter((job) => job.status !== 'queued').length
  const queued = active.length - running

  return (
    <Page width="wide">
      <PageHeader
        eyebrow="Studio"
        title="Clipping jobs"
        description={active.length > 0
          ? `${running} running${queued > 0 ? ` · ${queued} queued` : ''} · up to ${MAX_PARALLEL_JOBS} run at once`
          : 'Queue as many videos as you like; up to two run at once.'}
        actions={
          <>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh jobs"
              title="Refresh jobs"
              onClick={onRefresh}
              disabled={refreshing}
              icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
            />
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={onNew}>New job</Button>
          </>
        }
      />

      {error && <Callout tone="danger" className="mt-3" onDismiss={onDismissError}>{error}</Callout>}

      {active.length > 0 && (
        <section className="mt-4" aria-label="Active jobs">
          <SectionTitle label="Active" count={active.length} />
          <div className="space-y-2">
            {active.map((job) => (
              <ActiveJobRow key={job.id} job={job} position={job.status === 'queued' ? active.filter((j) => j.status === 'queued').indexOf(job) + 1 : null} onOpen={() => onOpenJob(job)} onCancel={() => onCancel(job)} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-5" aria-label="Previous jobs">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle label="Previous" count={previous.length} className="mb-0" />
          {previous.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex flex-wrap items-center gap-0.5 rounded-full bg-black/25 p-[3px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.35),inset_0_0_0_1px_rgb(255_255_255/0.07)]"
                role="group"
                aria-label="Filter jobs"
              >
                {FILTERS.filter((option) => option.id === 'all' || (counts[option.id] ?? 0) > 0).map((option) => {
                  const selected = filter === option.id
                  return (
                    <button
                      key={option.id}
                      onClick={() => onFilter(option.id)}
                      aria-pressed={selected}
                      className={cn(
                        'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-200',
                        selected ? 'bg-white/[0.12] text-ink' : 'text-ink-muted hover:text-ink'
                      )}
                    >
                      {option.label}
                      <span className={cn('font-mono text-2xs tabular', selected ? 'text-ink-muted' : 'text-ink-faint')}>{counts[option.id] ?? 0}</span>
                    </button>
                  )
                })}
              </div>
              <TextInput
                className="w-[220px] rounded-full max-sm:w-full"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                placeholder="Search jobs"
                aria-label="Search jobs"
                leading={<Search className="h-3.5 w-3.5" />}
              />
            </div>
          )}
        </div>

        {entries === null ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading jobs">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="glass flex items-center gap-3 rounded-2xl px-3 py-2.5">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/5 rounded-full" />
                  <Skeleton className="h-3 w-1/4 rounded-full" />
                </div>
                <Skeleton className="h-7 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : previous.length === 0 ? (
          active.length === 0 ? (
            <EmptyState
              icon={<ListVideo />}
              title="No clipping jobs yet"
              description="Jobs appear here as soon as you generate clips, and stay here when they finish."
              action={<Button variant="primary" onClick={onNew}>Create clips</Button>}
            />
          ) : (
            <p className="glass rounded-2xl px-4 py-3 text-xs text-ink-subtle">Finished jobs will appear here.</p>
          )
        ) : visible.length === 0 ? (
          <div className="glass flex flex-col items-center rounded-2xl px-5 py-6 text-center">
            <Search className="h-4 w-4 text-ink-subtle" />
            <p className="mt-2 text-sm text-ink-muted">No jobs match this filter.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {visible.map((entry) => (
              <PreviousJobRow key={entry.jobId} entry={entry} hasDetails={Boolean(sessionJobs[entry.jobId])} onOpen={() => onOpenEntry(entry)} onOpenFolder={() => onOpenFolder(entry.outputDir)} />
            ))}
          </div>
        )}
      </section>
    </Page>
  )
}

function SectionTitle({ label, count, className }: { label: string; count: number; className?: string }): React.JSX.Element {
  return (
    <h2 className={cn('mb-2 flex items-center gap-2', className)}>
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-2xs tabular text-ink-faint">{count}</span>
    </h2>
  )
}

function ActiveJobRow({ job, position, onOpen, onCancel }: { job: Job; position: number | null; onOpen: () => void; onCancel: () => void }): React.JSX.Element {
  const queued = job.status === 'queued'
  const since = job.startedAt ?? job.queuedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsed = Math.max(0, now - Date.parse(since))

  return (
    <div className="glass rounded-2xl px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Badge tone={queued ? 'neutral' : 'accent'}>{queued ? `Queued · #${position}` : STAGE_LABELS[job.status] ?? 'Working'}</Badge>
            <button onClick={onOpen} className="min-w-0 truncate text-left text-sm font-medium text-ink hover:underline" title={job.request.videoUrl}>
              {sourceLabel(job.request.videoUrl)}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <ProgressBar value={queued ? 0 : job.percent} className="h-1 flex-1" />
            <span className="w-9 text-right font-mono text-2xs tabular text-accent-hover">{queued ? '–' : `${Math.round(job.percent)}%`}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-subtle">
            <span className="min-w-0 truncate">{queued ? 'Starts when a slot frees up' : job.step}</span>
            {job.clipsTotal > 0 && <span className="inline-flex items-center gap-1"><Clapperboard className="h-3 w-3" />{job.clipsDone}/{job.clipsTotal} clips</span>}
            <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatTimecode(elapsed)} {queued ? 'waiting' : 'elapsed'}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={onOpen}>View</Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={queued ? 'Remove from queue' : 'Cancel job'}
            title={queued ? 'Remove from queue' : 'Cancel job'}
            icon={queued ? <X className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
            onClick={onCancel}
          />
        </div>
      </div>
    </div>
  )
}

function PreviousJobRow({ entry, hasDetails, onOpen, onOpenFolder }: { entry: HistoryEntry; hasDetails: boolean; onOpen: () => void; onOpenFolder: () => void }): React.JSX.Element {
  return (
    <div className="glass flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={STATUS[entry.status].tone}>{STATUS[entry.status].label}</Badge>
          <h3 className="min-w-0 truncate text-sm font-medium text-ink" title={entry.videoTitle}>{entry.videoTitle}</h3>
        </div>
        {entry.errorMessage && <p className="mt-1 truncate text-xs text-danger" title={entry.errorMessage} data-selectable>{entry.errorMessage}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-subtle">
          <span>{entry.date.startsWith('1970-') ? 'Date unavailable' : formatDate(entry.date)}</span>
          <span className="inline-flex items-center gap-1"><Clapperboard className="h-3 w-3" />{entry.clipCount} clip{entry.clipCount === 1 ? '' : 's'}</span>
          {entry.durationMs != null && <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatDuration(entry.durationMs)}</span>}
          {entry.totalCostUsd != null && <span className="inline-flex items-center gap-1"><Receipt className="h-3 w-3" /><span className="font-mono tabular">{formatUsd(entry.totalCostUsd)}</span></span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <InspectEditsButton outputDir={entry.outputDir} />
        <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={onOpenFolder}>Folder</Button>
        {entry.status === 'completed' && <Button size="sm" variant="primary" onClick={onOpen}>View clips</Button>}
        {/* Failed and cancelled jobs from this session keep their options, so they can run again. */}
        {entry.status !== 'completed' && hasDetails && (
          <Button size="sm" variant="secondary" onClick={onOpen}>Details</Button>
        )}
      </div>
    </div>
  )
}

function JobCancelled({ job, leading, onRetry }: { job: Job; leading: React.ReactNode; onRetry: () => void }): React.JSX.Element {
  return (
    <Page width="focus">
      <div className="mb-3">{leading}</div>
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">Job cancelled</h1>
      <p className="mt-1 truncate text-sm text-ink-muted" title={job.request.videoUrl}>{sourceLabel(job.request.videoUrl)}</p>
      <div className="mt-4">
        <Button variant="primary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onRetry}>Run again</Button>
      </div>
    </Page>
  )
}
