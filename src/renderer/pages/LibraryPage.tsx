import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Clapperboard, FolderOpen, ListVideo, RefreshCw, Search, Sparkles, Star, Trash2 } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatRelativeDate, formatUsd, localFileUrl } from '../lib/utils'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import { useSettingsStore } from '../store/use-settings-store'
import { usePostsStore } from '../store/use-posts-store'
import type { JobOutput } from '../store/use-job-store'
import { parseJobOutput } from '../../shared/job-output'
import type { HistoryEntry } from '../../preload/index'
import { BackLink, ClipList } from '../components/ClipList'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { TextInput } from '../components/ui/Field'
import { EmptyState } from '../components/ui/EmptyState'
import { Callout } from '../components/ui/Callout'
import { Skeleton } from '../components/ui/Skeleton'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { HoverCard } from '../components/ui/HoverCard'
import type { Page as AppPage } from '../components/Sidebar'

export function LibraryPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const outputDirectory = useSettingsStore((s) => s.outputDirectory)
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ entry: HistoryEntry; output: JobOutput } | null>(null)
  const requestId = useRef(0)
  const openRequestId = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const closeConfirm = useCallback(() => setConfirm(null), [])
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const busyRef = useRef(new Set<string>())
  const [counts, setCounts] = useState<Record<string, { posted: number; notPosted: number } | null>>({})
  const posts = usePostsStore((state) => state.posts)
  const postError = usePostsStore((state) => state.error)
  const configured = useSettingsStore((state) => state.zernioConfigured)
  const directoryRef = useRef(outputDirectory)
  directoryRef.current = outputDirectory

  const load = useCallback(async () => {
    const request = ++requestId.current
    setRefreshing(true)
    setError(null)
    try {
      const result = await getApi().history.list()
      if (request === requestId.current) setEntries(result.filter((entry) => entry.status === 'completed'))
    } catch (err) {
      if (request === requestId.current) {
        setEntries((previous) => previous ?? [])
        setError(errorMessage(err, 'Could not load the library. Please refresh to retry.'))
      }
    } finally {
      if (request === requestId.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    setOpen(null)
    setConfirm(null)
    setCounts({})
    setEntries(null)
    openRequestId.current++
    void load()
    return () => { requestId.current++; openRequestId.current++ }
  }, [load, outputDirectory])

  useEffect(() => {
    if (!configured || open) return
    void usePostsStore.getState().refresh()
    const timer = window.setInterval(() => { void usePostsStore.getState().refresh() }, 30000)
    return () => window.clearInterval(timer)
  }, [configured, open])

  const entryPaths = JSON.stringify(entries?.map((entry) => entry.outputDir).sort() ?? [])
  useEffect(() => {
    if (open) return
    let active = true
    // Resolve counts progressively, with one run at a time to bound disk I/O
    // while recovering older automation copies by byte identity.
    void (async () => {
      for (const path of JSON.parse(entryPaths) as string[]) {
        if (!active) return
        try {
          const statuses = await getApi().history.postingStatus(path)
          const posted = statuses.filter((status) => status.state === 'posted').length
          if (active) setCounts((current) => ({ ...current, [path]: { posted, notPosted: statuses.length - posted } }))
        } catch {
          if (active) setCounts((current) => ({ ...current, [path]: null }))
        }
      }
    })()
    return () => { active = false }
  }, [entryPaths, posts, open, configured])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = query.trim().toLowerCase()
    return entries.filter((entry) => !q || entry.videoTitle.toLowerCase().includes(q))
      .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)))
  }, [entries, query])

  const totalClips = entries?.reduce((sum, e) => sum + e.clipCount, 0) ?? 0

  const openRun = async (entry: HistoryEntry): Promise<void> => {
    if (busyRef.current.has(entry.outputDir)) return
    const request = ++openRequestId.current
    setError(null)
    try {
      const output = await getApi().history.getJob(entry.outputDir)
      if (request !== openRequestId.current) return
      if (!output) {
        setError('This run is no longer available. Its files may have moved or been removed.')
        return
      }
      const parsed = parseJobOutput(output)
      if (!parsed) {
        setError('This run has an unsupported or damaged result file.')
        return
      }
      setOpen({ entry, output: parsed })
      document.getElementById('page-scroll')?.scrollTo({ top: 0 })
    } catch (err) {
      if (request === openRequestId.current) setError(errorMessage(err, 'Could not open this run.'))
    }
  }

  const changeRun = async (entry: HistoryEntry, action: 'favorite' | 'delete'): Promise<void> => {
    if (busyRef.current.has(entry.outputDir)) return
    busyRef.current.add(entry.outputDir)
    setBusy(new Set(busyRef.current))
    const directory = directoryRef.current
    ++requestId.current
    ++openRequestId.current
    setRefreshing(false)
    setError(null)
    try {
      if (action === 'delete') await getApi().history.delete(entry.outputDir)
      else await getApi().history.setFavorite(entry.outputDir, !entry.favorite)
      if (directoryRef.current !== directory) return
      setEntries((current) => current?.flatMap((item) => item.outputDir !== entry.outputDir ? [item]
        : action === 'delete' ? [] : [{ ...item, favorite: !entry.favorite }]) ?? null)
      await load()
    } catch (cause) {
      if (directoryRef.current === directory) setError(errorMessage(cause, action === 'delete' ? 'Could not delete this run. Refresh the Library to check its files.' : 'Could not update this favorite.'))
    } finally {
      busyRef.current.delete(entry.outputDir)
      setBusy(new Set(busyRef.current))
    }
  }

  const confirmDelete = (entry: HistoryEntry): void => setConfirm({
    title: 'Delete this Library item?',
    body: <>Permanently delete “{entry.videoTitle}” and all {entry.clipCount} clips, plus every other file in its run folder? This includes saved transcripts, previews and logs. This cannot be undone. Published posts and copies saved outside this folder remain.<span className="mt-3 block break-all text-xs text-ink-subtle">{entry.outputDir}</span></>,
    confirmLabel: 'Delete local files',
    onConfirm: () => { void changeRun(entry, 'delete') }
  })

  if (open) {
    return (
      <ClipList
        output={open.output}
        outputDir={open.entry.outputDir}
        onNavigate={onNavigate}
        leading={<BackLink label="Library" onClick={() => setOpen(null)} />}
      />
    )
  }

  return (
    <Page width="wide">
      <PageHeader
        eyebrow="Studio"
        title="Library"
        description={
          entries && entries.length > 0
            ? `${entries.length} run${entries.length === 1 ? '' : 's'} · ${totalClips} clips`
            : 'Every run you finish lands here.'
        }
        actions={
          <>
            <Button variant="ghost" icon={<ListVideo className="h-4 w-4" />} onClick={() => onNavigate('jobs')}>
              Jobs
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              title="Refresh"
              onClick={() => { void load(); if (configured) void usePostsStore.getState().refresh(true) }}
              disabled={refreshing}
              icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
            />
            {outputDirectory && (
              <Button icon={<FolderOpen className="h-4 w-4" />} onClick={() => getApi().shell.openPath(outputDirectory)}>
                Open folder
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Callout tone="danger" className="mt-4" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}
      {configured && postError && <Callout tone="warning" className="mt-4">{postError} Showing saved posting status.</Callout>}

      {entries && entries.length > 0 && (
        <TextInput
          className="mt-5 max-w-sm rounded-full"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by video title"
          leading={<Search className="h-3.5 w-3.5" />}
          aria-label="Search runs"
        />
      )}

      <div className="mt-4">
        {entries === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4" aria-busy="true" aria-label="Loading library">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass rounded-2xl p-1.5">
                <Skeleton className="aspect-video rounded-xl" />
                <div className="space-y-2.5 px-2 pb-2 pt-3.5">
                  <Skeleton className="h-3.5 w-3/4 rounded-full" />
                  <Skeleton className="h-3 w-1/3 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Clapperboard />}
            title="No clips yet"
            description="Generate clips from a long video and every run will show up here, newest first."
            action={
              <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={() => onNavigate('clip')}>
                Create your first clips
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <div className="glass flex flex-col items-center rounded-3xl px-5 py-10 text-center">
            <Search className="h-5 w-5 text-ink-subtle" />
            <p className="mt-3 text-sm text-ink-muted">No runs match “{query}”.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {filtered.map((entry) => (
              <RunCard
                key={entry.outputDir}
                entry={entry}
                counts={counts[entry.outputDir]}
                busy={busy.has(entry.outputDir)}
                onFavorite={() => { void changeRun(entry, 'favorite') }}
                onDelete={() => confirmDelete(entry)}
                onOpen={() => openRun(entry)}
                onOpenFolder={async () => {
                  try {
                    if (!await getApi().shell.openPath(entry.outputDir)) setError('This run folder is no longer available.')
                  } catch (err) {
                    setError(errorMessage(err, 'Could not open this run folder.'))
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

function RunCard({ entry, counts, busy, onFavorite, onDelete, onOpen, onOpenFolder }: {
  entry: HistoryEntry
  counts: { posted: number; notPosted: number } | null | undefined
  busy: boolean
  onFavorite: () => void
  onDelete: () => void
  onOpen: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const failed = entry.status !== 'completed'
  const thumb = useRunThumbnail(failed ? null : entry.outputDir)
  const [previewFailed, setPreviewFailed] = useState(false)

  return (
    <article
      className={cn(
        'glass group relative rounded-2xl p-1.5 text-left transition-[transform,box-shadow] duration-300 ease-out',
        'hover:-translate-y-1 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(255_255_255/0.08),0_28px_56px_-24px_rgb(0_0_0/0.8)]'
      )}
    >
      <button type="button" className="block w-full text-left" disabled={busy} onClick={failed ? onOpenFolder : onOpen} aria-label={`Open ${entry.videoTitle}`}>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        {thumb && !previewFailed ? (
          <>
            {/* Vertical clips sit on a blurred copy of themselves to fill the 16:9 frame. */}
            <img src={localFileUrl(thumb)} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-2xl saturate-150" />
            <img
              src={localFileUrl(thumb)}
              alt=""
              draggable={false}
              className="relative h-full w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.04]"
              onError={() => setPreviewFailed(true)}
            />
          </>
        ) : failed ? (
          <div className="flex h-full items-center justify-center text-danger/70">
            <AlertTriangle className="h-6 w-6" />
          </div>
        ) : (
          <Skeleton className="h-full rounded-none" />
        )}
        {!failed && (
          <span className="glass-chip absolute left-2 top-2 inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-2xs font-medium text-white">
            <Clapperboard className="h-3 w-3" />
            {entry.clipCount} clip{entry.clipCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="px-2 pb-2 pt-3.5">
        <p className="truncate text-sm font-medium text-ink" title={entry.videoTitle}>
          {failed ? `${entry.status === 'incomplete' ? 'Unfinished' : 'Unreadable'} run · Open folder` : entry.videoTitle}
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-subtle">
          <span>{formatRelativeDate(entry.date)}</span>
          {entry.totalCostUsd != null && (
            <>
              <span className="text-ink-faint">·</span>
              <span className="font-mono tabular">{formatUsd(entry.totalCostUsd)}</span>
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-ink-muted" title="Only fully published clips count as posted. Scheduled, partial and inbox deliveries remain Not Posted.">
          {counts ? <><span className="text-success">{counts.posted} Posted</span><span className="mx-2 text-ink-faint">·</span><span>{counts.notPosted} Not Posted</span></>
            : counts === null ? 'Posting status unavailable' : 'Checking posting status…'}
        </p>
      </div>
      </button>
      <div className="absolute right-3.5 top-3.5 flex items-center gap-1.5">
        <HoverCard cardClassName="px-3 py-2 text-xs" content={entry.favorite ? 'Remove from favorites' : 'Favorite this Library item'}>
          <Button size="sm" iconOnly className={cn('glass-chip', entry.favorite && 'text-brand-gold')} disabled={busy} aria-label={`${entry.favorite ? 'Unfavorite' : 'Favorite'} ${entry.videoTitle}`} aria-pressed={Boolean(entry.favorite)} onClick={onFavorite} icon={<Star className="h-3.5 w-3.5" fill={entry.favorite ? 'currentColor' : 'none'} />} />
        </HoverCard>
        <HoverCard cardClassName="px-3 py-2 text-xs" content="Delete this Library item and its local files">
          <Button size="sm" iconOnly className="glass-chip hover:text-danger" disabled={busy} aria-label={`Delete ${entry.videoTitle}`} onClick={onDelete} icon={<Trash2 className="h-3.5 w-3.5" />} />
        </HoverCard>
      </div>
    </article>
  )
}

/** Thumbnail of a run's best clip, loaded through the shared thumbnail queue. */
function useRunThumbnail(outputDir: string | null): string | null {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    setThumb(null)
    if (!outputDir) return
    let cancelled = false
    getApi()
      .history.getJob(outputDir)
      .then((raw) => {
        const output = parseJobOutput(raw)
        const best = output?.clips.reduce<JobOutput['clips'][number] | null>(
          (top, c) => (!top || c.virality_score > top.virality_score ? c : top),
          null
        )
        if (!best || cancelled) return null
        return loadThumbnail(clipFilePath(best.s3_url), best.duration_ms > 0 ? best.duration_ms / 2000 : undefined)
      })
      .then((path) => {
        if (!cancelled && path) setThumb(path)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [outputDir])
  return thumb
}
