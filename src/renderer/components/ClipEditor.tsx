import { registerNavigationCommit } from '../lib/navigation'
import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, Check, ChevronDown, Download, Film, Loader2, Pause, Pencil, Play, Redo2, RotateCcw, Scissors, SkipBack, Undo2, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatTimecode, localFileUrl, parseTimecode } from '../lib/utils'
import { candidateEdit, canAnimateScene, defaultCrop, editDuration, editSignature, editorProgress, framingAt, normalizeSceneTransitions, refineEdit, resizeCrop, retimeScene, sceneAt, trimRange, type CandidateEdit, type Crop, type CropCorner, type EditorCandidate, type EditorQuestion, type EditorScene, type EditorSession } from '../../shared/clip-editor'
import { Button } from './ui/Button'
import { CaptionPresetPicker } from './CaptionPresetPicker'
import { Switch } from './ui/Switch'
import { EditInspector } from './EditInspector'

const labels: Record<string, string> = { not_sponsored: 'Not sponsored', opening_context: 'Opening context', self_contained: 'Self contained', complete_ending: 'Complete ending', logical_flow: 'Logical flow', faithful_to_source: 'Faithful to source', title_supported: 'Title supported', evidence: 'Enough evidence', removal_safe: 'Safe to remove', join_logical: 'Natural join' }
const clock = (n: number): string => `${formatTimecode(n)}.${String(Math.floor(n % 1000 / 100)).padStart(1, '0')}`
const cropCorners: CropCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const statusLabels = { refining: 'Refining', ready: 'Ready', baked: 'Baked', discarded: 'Discarded' }
const reviewCurrent = (c: EditorCandidate): boolean => {
  try { return JSON.stringify(JSON.parse(c.review?.signature ?? 'null')) === editSignature(c) } catch { return false }
}
function Question({ q }: { q: EditorQuestion }): React.JSX.Element {
  const passed = q.probability !== null && q.probability >= q.threshold
  const words = (text: string): string => text.replaceAll('`retained_dialogue`', 'this clip').replaceAll('`before`', 'the preceding context').replaceAll('`after`', 'the following context').replaceAll('`title`', 'the title').replaceAll('`visual_observations`', 'visual evidence')
  return <details className="editor-question">
    <summary><span className={cn('editor-dot', passed ? 'bg-success' : 'bg-warning')} /><span>{labels[q.id] ?? q.id}</span><span className={cn('ml-auto font-mono', passed ? 'text-success' : 'text-warning')}>{q.probability === null ? 'Not rated' : `${Math.round(q.probability * 100)}%`}</span><ChevronDown size={12} /></summary>
    <p>{words(q.prompt)}</p><p className="text-ink-subtle">{q.probability === null ? `Review ${q.status.replaceAll('_', ' ')}. ` : ''}Target: {Math.round(q.threshold * 100)}%</p>
    <p><span className="text-success">Pass: </span>{q.yes}</p><p><span className="text-warning">Consider: </span>{q.no}</p>
  </details>
}

export function ClipEditor({ outputDir, leading, onExports }: { outputDir: string; leading?: ReactNode; onExports: () => Promise<void> }): React.JSX.Element {
  const [session, setSession] = useState<EditorSession | null>(null)
  const [edits, setEdits] = useState<EditorCandidate[]>([])
  const editsRef = useRef(edits); editsRef.current = edits
  const sessionRef = useRef(session); sessionRef.current = session
  const savedKey = useRef('')
  const savePromise = useRef<Promise<void> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'review' | 'export' | 'save' | null>(null)
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<'review' | 'framing' | 'captions' | 'transcript'>('review')
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [previewCut, setPreviewCut] = useState(true)
  const [fullTimeline, setFullTimeline] = useState(false)
  const [cropDragging, setCropDragging] = useState(false)
  const [dragWindow, setDragWindow] = useState<[number, number] | null>(null)
  const previewCutRef = useRef(previewCut); previewCutRef.current = previewCut
  const [panel, setPanel] = useState(0)
  const [showAudit, setShowAudit] = useState(false)
  const [undo, setUndo] = useState<EditorCandidate[][]>([])
  const [redo, setRedo] = useState<EditorCandidate[][]>([])
  const [editingCaption, setEditingCaption] = useState<number | null>(null)
  const firstCaptionChange = useRef(true)
  const captionInput = useRef<HTMLTextAreaElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const transcriptPanel = useRef<HTMLDivElement>(null)
  const activeCaption = useRef<HTMLDivElement>(null)
  const activeTranscript = session?.project.transcript.find((r) => time >= r.start_ms && time < r.end_ms)
  const candidate = edits[selected]
  const candidateRef = useRef(candidate); candidateRef.current = candidate
  const currentScene = candidate ? sceneAt(candidate, time) : null
  const key = JSON.stringify(edits.map(candidateEdit))
  const keyRef = useRef(key); keyRef.current = key
  const load = useCallback(async () => {
    try {
      const s = await getApi().editor.open(outputDir)
      if (!sessionRef.current) setSelected(editorProgress(s.project.candidates).initialCandidate)
      setSession(s); sessionRef.current = s; setEdits(s.project.candidates); editsRef.current = s.project.candidates
      savedKey.current = JSON.stringify(s.project.candidates.map(candidateEdit))
      setBusy(s.operation ?? null); setError(null)
    } catch (e) { setError(errorMessage(e)) }
  }, [outputDir])
  useEffect(() => { void load() }, [load])
  // A reopened window can reconnect to an export/review still owned by main.
  useEffect(() => {
    if (!session?.operation) return
    const timer = window.setInterval(() => { void load() }, 1500)
    return () => window.clearInterval(timer)
  }, [session?.operation, load])

  const save = useCallback(async (): Promise<void> => {
    if (savePromise.current) await savePromise.current
    if (!sessionRef.current || keyRef.current === savedKey.current) return
    const task = async (): Promise<void> => {
      setSaving(true)
      try {
        while (keyRef.current !== savedKey.current) {
          const sentKey = keyRef.current
          const s = await getApi().editor.save(outputDir, sessionRef.current!.project.revision, editsRef.current)
          savedKey.current = sentKey; sessionRef.current = s; setSession(s)
        }
      } finally { setSaving(false); savePromise.current = null }
    }
    savePromise.current = task()
    await savePromise.current
  }, [outputDir])
  useEffect(() => {
    if (!session || busy || dragWindow || cropDragging || key === savedKey.current) return
    const timer = window.setTimeout(() => { void save().catch((e) => setError(errorMessage(e))) }, 700)
    return () => window.clearTimeout(timer)
  }, [key, session, busy, dragWindow, cropDragging, save])
  useEffect(() => registerNavigationCommit(async () => {
    try { await save() } catch (e) { setError(errorMessage(e)); throw e }
  }), [save])
  // Flush in-memory edits on page navigation; main owns the durable write.
  useEffect(() => () => { void save().catch(() => {}) }, [save])
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => { if (keyRef.current !== savedKey.current) { event.preventDefault(); void save() } }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [save])

  const change = (patch: Partial<CandidateEdit>, remember = true): void => {
    if (busy || !candidate || (candidate.status === 'discarded' && patch.status === undefined)) return
    if (patch.scenes) patch = { ...patch, scenes: normalizeSceneTransitions(patch.scenes) }
    if (remember) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]) }
    setEdits((items) => items.map((c, i) => i === selected ? refineEdit(c, patch) : c))
  }
  const history = (direction: 'undo' | 'redo'): void => {
    const from = direction === 'undo' ? undo : redo
    if (busy || !from.length) return
    // Undo can restore an old edit, but only a completed render creates Baked.
    const next = from[from.length - 1].map((c, i) => c.status === 'baked' && edits[i].status !== 'baked'
      ? { ...c, status: 'refining' as const } : c)
    setEditingCaption(null)
    if (direction === 'undo') { setUndo(from.slice(0, -1)); setRedo((r) => [...r, edits]) }
    else { setRedo(from.slice(0, -1)); setUndo((u) => [...u, edits]) }
    setEdits(next)
  }
  const seek = (t: number): void => {
    if (!video.current || !session) return
    const value = Math.max(0, Math.min(session.project.duration_ms - 1, t))
    video.current.currentTime = value / 1000; setTime(value)
  }
  const toggle = (): void => {
    const v = video.current
    if (!v || !candidate) return
    if (!v.paused) {
      v.pause(); setPlaying(false)
      const panel = transcriptPanel.current
      if (panel) panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' })
      return
    }
    if (previewCut && !candidate.ranges.some(([a, b]) => a <= v.currentTime * 1000 && b > v.currentTime * 1000)) seek(candidate.ranges[0][0])
    void v.play().catch(() => setError('The source preview could not play. Try seeking or reopening the editor.'))
  }
  const trim = (edge: 'in' | 'out', t: number): void => {
    if (!candidate) return
    change({ ranges: trimRange(candidate.ranges, edge === 'in' ? 0 : candidate.ranges.length - 1, edge === 'in' ? 0 : 1, t, session!.project.duration_ms) })
  }
  const split = (): void => {
    if (!candidate) return
    const t = Math.round(time)
    const ranges = candidate.ranges.flatMap(([a, b]): [number, number][] => t > a + 100 && t < b - 100 ? [[a, t], [t, b]] : [[a, b]])
    if (ranges.length <= 24) change({ ranges })
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]') || showAudit || cropDragging || dragWindow) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); history(e.shiftKey ? 'redo' : 'undo'); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); return }
      if (e.metaKey || e.ctrlKey || e.altKey || busy) return
      if (e.code === 'Space') { e.preventDefault(); toggle() }
      if (e.key.toLowerCase() === 'i') trim('in', time)
      if (e.key.toLowerCase() === 'o') trim('out', time)
      if (e.key.toLowerCase() === 's') split()
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 1000 / 30)) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })
  useEffect(() => {
    if (candidate && video.current) { video.current.pause(); seek(candidate.ranges[0][0]); setPanel(0); setTab('review'); setEditingCaption(null) }
  // Only candidate selection resets the playhead, never an edit.
  }, [selected, session?.previewPath])
  useEffect(() => { if (video.current && candidate) video.current.playbackRate = candidate.video_speed }, [candidate?.video_speed])
  useEffect(() => {
    if (tab !== 'transcript' || !playing || video.current?.paused || showAudit || editingCaption !== null || !activeTranscript) return
    const panel = transcriptPanel.current, caption = activeCaption.current
    if (!panel || !caption) return
    const bounds = panel.getBoundingClientRect(), row = caption.getBoundingClientRect()
    if (row.top >= bounds.top + 12 && row.bottom <= bounds.bottom - 12) return
    // Scroll only the inspector, leaving the video and timeline in place.
    const inset = Math.max(12, (panel.clientHeight - row.height) / 2)
    panel.scrollTo({ top: panel.scrollTop + row.top - bounds.top - inset,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    return () => { panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' }) }
  }, [activeTranscript, playing, tab, selected, showAudit, editingCaption])
  useEffect(() => {
    if (editingCaption === null || tab !== 'transcript' || !captionInput.current || !transcriptPanel.current) return
    const input = captionInput.current, panel = transcriptPanel.current
    input.focus({ preventScroll: true })
    panel.scrollTo({ top: panel.scrollTop + input.getBoundingClientRect().top - panel.getBoundingClientRect().top - 36, behavior: 'instant' })
  }, [editingCaption, tab])
  useEffect(() => {
    let frame = 0
    const draw = (): void => {
      const v = video.current, out = canvas.current, c = candidateRef.current
      if (v && out && c && v.readyState >= 2) {
        let t = v.currentTime * 1000
        if (!v.paused && previewCutRef.current) {
          const range = c.ranges.find(([, end]) => end > t)
          if (!range) { v.pause(); t = c.ranges.at(-1)![1]; v.currentTime = t / 1000 }
          else if (t < range[0]) { t = range[0]; v.currentTime = t / 1000 }
        }
        const scene = framingAt(c, t), ctx = out.getContext('2d')!
        ctx.clearRect(0, 0, out.width, out.height)
        if (scene.layout === 'fit') {
          ctx.filter = 'blur(16px) brightness(.75)'; ctx.drawImage(v, 0, 0, out.width, out.height); ctx.filter = 'none'
          const scale = Math.min(out.width / v.videoWidth, out.height / v.videoHeight)
          const w = v.videoWidth * scale, h = v.videoHeight * scale
          ctx.drawImage(v, (out.width - w) / 2, (out.height - h) / 2, w, h)
        } else scene.crops.forEach(([x, y, w, h], i) => ctx.drawImage(v, x * v.videoWidth, y * v.videoHeight, w * v.videoWidth, h * v.videoHeight, 0, i * out.height / scene.crops.length, out.width, out.height / scene.crops.length))
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  const run = async (action: 'review' | 'export'): Promise<void> => {
    if (!candidate || busy) return
    video.current?.pause(); setError(null); setBusy(action)
    try {
      await save()
      const s = await getApi().editor.run(outputDir, sessionRef.current!.project.revision, candidate.id, action)
      setSession(s); sessionRef.current = s; setEdits(s.project.candidates); setUndo([]); setRedo([])
      editsRef.current = s.project.candidates
      savedKey.current = JSON.stringify(s.project.candidates.map(candidateEdit))
      keyRef.current = savedKey.current
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(null) }
  }
  if (!session || !candidate || !currentScene) return <div className="p-8 space-y-4">{leading}<p role={error ? 'alert' : 'status'}>{error ?? 'Opening editor…'}</p><Button onClick={() => { void load() }}>Retry</Button></div>
  const safeLeading = isValidElement<{ onClick?: () => void }>(leading) && leading.props.onClick
    ? cloneElement(leading, { onClick: () => { void save().then(() => leading.props.onClick?.()).catch((e) => setError(errorMessage(e))) } }) : leading
  const project = session.project, aspect = project.aspect_ratio === '9:16' ? 9 / 16 : 16 / 9
  const status = candidate.status ?? 'refining'
  const editingDisabled = !!busy || status === 'discarded'
  const captionText = (index: number): string => candidate.caption_edits?.find((e) => e.segment === index)?.text ?? project.transcript[index].text
  const canEditCaption = (index: number): boolean => !editingDisabled && (candidate.caption_edits.length < 2000 || candidate.caption_edits.some((e) => e.segment === index))
  const editCaption = (index: number): void => {
    if (!canEditCaption(index)) return
    video.current?.pause(); firstCaptionChange.current = true; setTab('transcript'); setEditingCaption(index)
  }
  const updateCaption = (index: number, text: string, remember = true): void => {
    const caption_edits = (candidate.caption_edits ?? []).filter((e) => e.segment !== index)
    if (text !== project.transcript[index].text) caption_edits.push({ segment: index, text })
    change({ caption_edits: caption_edits.sort((a, b) => a.segment - b.segment) }, remember)
  }
  const current = reviewCurrent(candidate)
  const start = candidate.ranges[0][0], end = candidate.ranges[candidate.ranges.length - 1][1]
  const [viewStart, viewEnd] = dragWindow ?? (fullTimeline ? [0, project.duration_ms] : [Math.max(0, start - 10000), Math.min(project.duration_ms, end + 10000)])
  const sceneIndex = candidate.scenes.indexOf(currentScene)
  const canAnimate = canAnimateScene(candidate.scenes, sceneIndex)
  const crop = currentScene.crops[Math.min(panel, currentScene.crops.length - 1)]
  const sceneChange = (patch: Partial<EditorScene>, remember = true): void => change({ scenes: candidate.scenes.map((s, i) => i === sceneIndex ? { ...s, ...patch } : s) }, remember)
  const cropChange = (c: Crop, remember = true): void => sceneChange({ crops: currentScene.crops.map((r, i) => i === Math.min(panel, currentScene.crops.length - 1) ? c : r) }, remember)
  const setLayout = (layout: EditorScene['layout']): void => {
    setPanel(0)
    sceneChange({ layout, crops: layout === 'split' ? [defaultCrop(project.width, project.height, aspect * 2, .25), defaultCrop(project.width, project.height, aspect * 2, .75)] : [defaultCrop(project.width, project.height, aspect)] })
  }
  const moveScene = (index: number, at: number): void => {
    if (editingDisabled) return
    const scenes = retimeScene(candidate.scenes, index, at, project.duration_ms)
    if (scenes === candidate.scenes) return
    video.current?.pause(); change({ scenes }); seek(scenes[index].at_ms); setTab('framing')
    if (scenes[index].at_ms < viewStart || scenes[index].at_ms > viewEnd) setFullTimeline(true)
  }
  const startSceneDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number): void => {
    if (editingDisabled || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); video.current?.pause()
    const target = e.currentTarget, bounds = target.parentElement!.getBoundingClientRect(), x = e.clientX
    const original = candidate.scenes[index].at_ms
    let previous = original, changed = false
    seek(original); setTab('framing'); setDragWindow([viewStart, viewEnd])
    target.focus({ preventScroll: true }); target.setPointerCapture(e.pointerId)
    const move = (event: PointerEvent): void => {
      if (!changed && Math.abs(event.clientX - x) < 3) return
      const t = original + (event.clientX - x) / bounds.width * (viewEnd - viewStart)
      const scenes = retimeScene(candidate.scenes, index, Math.max(viewStart, Math.min(viewEnd, t)), project.duration_ms)
      const next = scenes[index].at_ms
      if (next === previous) return
      if (!changed) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]); changed = true }
      previous = next
      setEdits((items) => items.map((c, i) => i === selected ? refineEdit(c, { scenes }) : c))
      seek(next)
    }
    const done = (): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done)
      setDragWindow(null)
    }
    target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
  }
  const startCropDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number, corner?: CropCorner): void => {
    if (editingDisabled || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); setPanel(index); video.current?.pause()
    const target = e.currentTarget, bounds = target.closest('.editor-source-frame')!.getBoundingClientRect()
    const x = e.clientX, y = e.clientY, original = [...currentScene.crops[index]] as Crop
    let previous = original, changed = false
    target.focus({ preventScroll: true }); target.setPointerCapture(e.pointerId); setCropDragging(true)
    const move = (event: PointerEvent): void => {
      const dx = event.clientX - x, dy = event.clientY - y
      const next: Crop = corner ? resizeCrop(original, corner, dx, dy, bounds.width, bounds.height)
        : [Math.max(0, Math.min(1 - original[2], original[0] + dx / bounds.width)), Math.max(0, Math.min(1 - original[3], original[1] + dy / bounds.height)), original[2], original[3]]
      if (next.every((n, i) => Math.abs(n - previous[i]) < 1e-10)) return
      if (!changed) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]); changed = true }
      previous = next
      setEdits((items) => items.map((c, ci) => ci !== selected ? c : refineEdit(c, {
        scenes: c.scenes.map((s, si) => si !== sceneIndex ? s : { ...s, crops: s.crops.map((crop, i) => i === index ? next : crop) })
      })))
    }
    const done = (): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done)
      setCropDragging(false)
    }
    target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
  }
  return <section className="clip-editor" aria-label="Clip editor">
    <header className="editor-header"><div className="min-w-0 flex-1"><div className="flex items-center gap-3">{safeLeading}<span className="truncate text-sm font-medium">{project.title}</span></div><span className="text-2xs text-ink-subtle">{saving ? 'Saving…' : key !== savedKey.current ? 'Unsaved changes' : 'All changes saved'}</span></div>
      <Button variant="ghost" size="sm" onClick={() => setShowAudit(true)}>Transcript & edits</Button>
      <Button size="sm" disabled={!!busy} onClick={() => { void save().then(onExports).catch((e) => setError(errorMessage(e))) }}>Exports</Button>
      <Button variant="primary" size="sm" disabled={!!busy || status !== 'ready'} title={status !== 'ready' ? 'Mark this clip ready after refining it' : 'Render the final clip with your changes'} icon={<Download size={14} />} onClick={() => { void run('export') }}>{candidate.captions ? 'Bake captions' : 'Render clip'}</Button>
    </header>
    <div className="editor-stagebar">
      <span className={cn('editor-status', status)}>{status === 'baked' || status === 'ready' ? <Check size={12} /> : status === 'discarded' ? <Archive size={12} /> : <Pencil size={12} />}{statusLabels[status]}</span>
      <span className="editor-stage-hint">{status === 'refining' ? 'Review the cut, framing and captions.' : status === 'ready' ? 'Ready for the final render.' : status === 'baked' ? 'Your finished clip is in Exports.' : 'Set aside. Restore it whenever you need.'}</span>
      <div className="ml-auto flex gap-2">
        {status !== 'discarded' && <Button variant="ghost" size="sm" disabled={!!busy} icon={<Archive size={13} />} onClick={() => { video.current?.pause(); setEditingCaption(null); change({ status: 'discarded' }) }}>Discard</Button>}
        {status === 'refining' ? <Button size="sm" variant="primary" disabled={!!busy} icon={<Check size={13} />} onClick={() => { setEditingCaption(null); change({ status: 'ready' }) }}>Mark ready</Button>
          : <Button size="sm" disabled={!!busy} icon={<RotateCcw size={13} />} onClick={() => change({ status: 'refining' })}>{status === 'discarded' ? 'Restore clip' : status === 'baked' ? 'Refine again' : 'Keep refining'}</Button>}
      </div>
    </div>
    {error && <div role="alert" className="editor-notice text-danger">{error}<Button size="sm" variant="ghost" onClick={() => { setError(null); void save().catch((e) => setError(errorMessage(e))) }}>Retry save</Button></div>}
    {busy && <div role="status" className="editor-notice"><Loader2 size={14} className="animate-spin" />{busy === 'review' ? 'Jev is reviewing your edit…' : busy === 'export' ? 'Baking your final clip…' : 'Saving…'}<Button size="sm" variant="ghost" onClick={() => { void getApi().editor.cancel(outputDir) }}>Cancel</Button></div>}
    <div className="editor-workspace">
      <aside className="editor-candidates"><div className="editor-pane-heading">Refine clips <span>{edits.length}</span></div>
        {(['refining', 'ready', 'baked', 'discarded'] as const).map((group) => {
          const items = edits.map((c, i) => ({ c, i })).filter(({ c }) => (c.status ?? 'refining') === group)
          if (!items.length) return null
          const cards = items.map(({ c, i }) => <button key={c.id} className={cn('editor-candidate', group, i === selected && 'selected')} onClick={() => setSelected(i)}>
            <span className="flex items-center justify-between text-2xs text-ink-subtle"><span>{String(i + 1).padStart(2, '0')}</span>{c.exports.length > 0 && <span title={`${c.exports.length} saved exports`} className="flex items-center gap-1"><Download size={11} />{c.exports.length}</span>}</span>
            <span className="block text-xs leading-relaxed mt-1">{c.title}</span><span className="flex items-center justify-between mt-2 text-2xs text-ink-subtle"><span>{formatTimecode(c.ranges[0][0])} · {(editDuration(c) / 1000).toFixed(1)}s</span><span title={!reviewCurrent(c) ? 'Jev review out of date' : c.review?.decision === 'passes' ? 'Jev checks passed' : 'Jev: consider before baking'} className={cn('editor-dot', !reviewCurrent(c) ? 'bg-ink-subtle' : c.review?.decision === 'passes' ? 'bg-success' : 'bg-warning')} /></span>
          </button>)
          return group === 'discarded'
            ? <details key={group} className="editor-discarded" open={status === 'discarded' ? true : undefined}><summary>Discarded <span>{items.length}</span><ChevronDown size={12} /></summary>{cards}</details>
            : <div key={group} className="editor-candidate-group"><div className={cn('editor-group-heading', group)}>{statusLabels[group]} <span>{items.length}</span></div>{cards}</div>
        })}
      </aside>
      <div className="editor-center">
        <div className="editor-monitors">
          <div className="editor-source-monitor"><div className="editor-pane-heading">Source <span>{clock(time)}</span></div>
            <div className="editor-source-frame" style={{ aspectRatio: project.width / project.height }}>
              <video ref={video} src={localFileUrl(session.previewPath)} preload="auto" playsInline
                onLoadedMetadata={() => { seek(start); if (video.current) video.current.playbackRate = candidate.video_speed }}
                onPlay={() => setPlaying(true)} onPause={() => {
                  setPlaying(false)
                  const panel = transcriptPanel.current
                  if (panel) panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' })
                }} onEnded={() => setPlaying(false)}
                onError={() => setError('Source preview is unavailable. Reopen the project or check that its files still exist.')}
                onTimeUpdate={() => {
                  const v = video.current!; let t = v.currentTime * 1000
                  if (previewCut && !v.paused) {
                    const range = candidateRef.current!.ranges.find(([, b]) => t < b)
                    if (!range) { v.pause(); t = candidateRef.current!.ranges.at(-1)![1]; v.currentTime = t / 1000 }
                    else if (t < range[0]) { t = range[0]; v.currentTime = t / 1000 }
                  }
                  setTime(t)
                }} />
              {tab === 'framing' && currentScene.layout !== 'fit' && currentScene.crops.map((r, i) => {
                const name = currentScene.layout === 'split' ? (i === 0 ? 'top' : 'bottom') : 'output'
                return <div key={i} className={cn('editor-crop', i === panel && 'active')} style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}>
                  <button className="editor-crop-move" aria-label={`Move ${name} crop`} disabled={editingDisabled} onPointerDown={(e) => startCropDrag(e, i)}>
                    <span>{currentScene.layout === 'split' ? i === 0 ? '1' : '2' : ''}</span>
                  </button>
                  {cropCorners.map((corner) => <button key={corner} className={cn('editor-crop-corner', corner)} aria-label={`Resize ${name} crop from ${corner}`} title="Drag to resize · Arrow keys adjust · Shift for larger steps" disabled={editingDisabled}
                    onPointerDown={(e) => startCropDrag(e, i, corner)} onKeyDown={(e) => {
                      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                      e.preventDefault(); e.stopPropagation(); setPanel(i); video.current?.pause()
                      const bounds = e.currentTarget.closest('.editor-source-frame')!.getBoundingClientRect(), step = e.shiftKey ? 10 : 1
                      const next = resizeCrop(r, corner, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0, bounds.width, bounds.height)
                      if (next.some((n, index) => Math.abs(n - r[index]) > 1e-10)) sceneChange({ crops: currentScene.crops.map((c, ci) => ci === i ? next : c) })
                    }} />)}
                </div>
              })}
            </div>
            <p className="editor-monitor-hint">{tab === 'framing' ? 'Drag inside to move · Drag a corner to resize' : 'Space to play · I / O to trim · S to split'}</p>
          </div>
          <div className="editor-output-monitor">
            <div className="editor-pane-heading">Output <span>{project.aspect_ratio}</span></div>
            <canvas ref={canvas} width={aspect < 1 ? 360 : 640} height={aspect < 1 ? 640 : 360} style={{ aspectRatio: aspect }} />
          </div>
        </div>
        <div className="editor-transport"><Button title="Back to start" aria-label="Back to start" iconOnly variant="ghost" icon={<SkipBack size={15} />} onClick={() => seek(start)} /><Button title="Play / pause (Space)" aria-label="Play / pause" iconOnly icon={playing ? <Pause size={16} /> : <Play size={16} />} onClick={toggle} /><span className="font-mono text-xs">{clock(time)}</span><span className="text-ink-subtle text-2xs">/ {(editDuration(candidate) / 1000).toFixed(1)}s selected</span><label className="ml-auto flex gap-2 items-center text-2xs text-ink-muted"><input type="checkbox" checked={previewCut} onChange={(e) => setPreviewCut(e.target.checked)} />Play cuts only</label></div>
        <div className="editor-timeline">
          <div className="editor-timeline-tools"><Button variant="ghost" size="sm" title="Undo (⌘Z)" aria-label="Undo" iconOnly icon={<Undo2 size={14} />} disabled={!undo.length || !!busy} onClick={() => history('undo')} /><Button variant="ghost" size="sm" title="Redo (⌘⇧Z)" aria-label="Redo" iconOnly icon={<Redo2 size={14} />} disabled={!redo.length || !!busy} onClick={() => history('redo')} /><Button variant="ghost" size="sm" icon={<Scissors size={14} />} onClick={split} disabled={editingDisabled || candidate.ranges.length >= 24}>Split</Button><Button variant="ghost" size="sm" disabled={editingDisabled || (time >= start && time <= end)} title="Extend the first or last cut to the playhead. Turn off Play cuts only to watch beyond the current cut." onClick={() => { const t = (video.current?.currentTime ?? time / 1000) * 1000; if (t < start) trim('in', t); else if (t > end) trim('out', t) }}>Extend to playhead</Button><Button variant="ghost" size="sm" aria-pressed={fullTimeline} title={fullTimeline ? 'Zoom to the selected clip' : 'Show the full source to extend a cut farther'} onClick={() => setFullTimeline((v) => !v)}>{fullTimeline ? 'Zoom to clip' : 'Full source'}</Button><span className="ml-auto text-2xs text-ink-subtle">{clock(viewStart)} — {clock(viewEnd)}</span></div>
          <input aria-label="Source timeline" className="editor-source-scrub" type="range" min={0} max={project.duration_ms} step={33} value={time} onChange={(e) => seek(Number(e.target.value))} />
          <div className="editor-overview" aria-label="All candidate moments">{edits.map((c, i) => <button key={c.id} title={c.title} aria-label={`Jump to candidate ${i + 1}: ${c.title}`} className={cn(i === selected && 'selected')} style={{ left: `${c.ranges[0][0] / project.duration_ms * 100}%`, width: `${(c.ranges.at(-1)![1] - c.ranges[0][0]) / project.duration_ms * 100}%`, top: (i % 3) * 4 }} onClick={() => { setSelected(i); seek(c.ranges[0][0]) }} />)}</div>
          <div className="editor-track" onPointerDown={(e) => { if (e.target === e.currentTarget) seek(viewStart + (e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth * (viewEnd - viewStart)) }}>
            {candidate.ranges.map(([a, b], i) => <div key={i} className="editor-timeline-piece" style={{ left: `${(a - viewStart) / (viewEnd - viewStart) * 100}%`, width: `${(b - a) / (viewEnd - viewStart) * 100}%` }}><button className="editor-trim-handle" aria-label={`Trim start of cut ${i + 1}`} disabled={editingDisabled} title="Drag to trim or extend; arrow keys adjust by 0.1s (Shift: 1s)" onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); change({ ranges: trimRange(candidate.ranges, i, 0, a + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100), project.duration_ms) }) } }} onPointerDown={(e) => { video.current?.pause(); setDragWindow([viewStart, viewEnd]); trimDrag(e, i, 0, viewStart, viewEnd, project.duration_ms, candidate, edits, selected, setEdits, setUndo, setRedo, () => setDragWindow(null)) }} /><button className="editor-piece-body" onClick={() => seek(a)}><Film size={12} /><span>{i + 1}</span></button><button className="editor-trim-handle" aria-label={`Trim end of cut ${i + 1}`} disabled={editingDisabled} title="Drag to trim or extend; arrow keys adjust by 0.1s (Shift: 1s)" onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); change({ ranges: trimRange(candidate.ranges, i, 1, b + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100), project.duration_ms) }) } }} onPointerDown={(e) => { video.current?.pause(); setDragWindow([viewStart, viewEnd]); trimDrag(e, i, 1, viewStart, viewEnd, project.duration_ms, candidate, edits, selected, setEdits, setUndo, setRedo, () => setDragWindow(null)) }} /></div>)}
            {candidate.scenes.map((s, i) => i > 0 && s.at_ms >= viewStart && s.at_ms <= viewEnd && <button key={i}
              title={`Layout change at ${clock(s.at_ms)}${editingDisabled ? '' : ' · Drag to move · Arrow keys: 0.1s · Shift: 1s'}`}
              aria-label={`Layout change at ${clock(s.at_ms)}`} className={cn('editor-scene-marker', i === sceneIndex && 'selected', editingDisabled && 'read-only')}
              style={{ left: `${(s.at_ms - viewStart) / (viewEnd - viewStart) * 100}%` }}
              onPointerDown={(e) => startSceneDrag(e, i)} onClick={() => { video.current?.pause(); seek(s.at_ms); setTab('framing') }}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault(); e.stopPropagation()
                moveScene(i, s.at_ms + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100))
              }} />)}
            {time >= viewStart && time <= viewEnd && <div className="editor-playhead" style={{ left: `${(time - viewStart) / (viewEnd - viewStart) * 100}%` }} />}
          </div>
          <input aria-label="Fine timeline position" type="range" min={viewStart} max={viewEnd} step={33} value={Math.max(viewStart, Math.min(viewEnd, time))} onChange={(e) => seek(Number(e.target.value))} className="editor-fine-scrub" />
          <div className="editor-cut-list">{candidate.ranges.map(([a, b], i) => <div key={i} className="flex items-center gap-2"><span className="text-2xs text-ink-subtle">{i + 1}</span><TimeInput label={`Cut ${i + 1} start`} value={a} disabled={editingDisabled} onChange={(t) => { const ranges = candidate.ranges.map((r) => [...r] as [number, number]); ranges[i][0] = Math.max(i ? ranges[i - 1][1] : 0, Math.min(b - 100, t)); change({ ranges }) }} /><span className="text-ink-subtle">–</span><TimeInput label={`Cut ${i + 1} end`} value={b} disabled={editingDisabled} onChange={(t) => { const ranges = candidate.ranges.map((r) => [...r] as [number, number]); ranges[i][1] = Math.min(i + 1 < ranges.length ? ranges[i + 1][0] : project.duration_ms, Math.max(a + 100, t)); change({ ranges }) }} /><Button variant="ghost" size="sm" aria-label={`Remove cut ${i + 1}`} title="Remove this section" iconOnly icon={<X size={12} />} disabled={candidate.ranges.length === 1 || editingDisabled} onClick={() => change({ ranges: candidate.ranges.filter((_, j) => j !== i) })} /></div>)}</div>
        </div>
      </div>
      <aside className="editor-inspector"><div className="editor-tabs">{(['review', 'framing', 'captions', 'transcript'] as const).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={cn(tab === t && 'selected')}>{t === 'review' ? 'Jev' : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
        <div ref={transcriptPanel} className="editor-inspector-body"><label className="editor-label" htmlFor="editor-title">Title</label><textarea id="editor-title" value={candidate.title} maxLength={200} disabled={editingDisabled} rows={2} onChange={(e) => { if (e.target.value.trim()) change({ title: e.target.value }) }} />
          {tab === 'review' && <div className="space-y-3 mt-4"><div className="flex items-center justify-between"><span className={cn('text-xs', current ? candidate.review?.decision === 'passes' ? 'text-success' : 'text-warning' : 'text-ink-muted')}>{!current ? 'Review out of date' : candidate.review?.decision === 'passes' ? 'Checks passed' : 'Consider before baking'}</span><Button size="sm" disabled={editingDisabled} onClick={() => { void run('review') }}>Review again</Button></div><p className="text-2xs text-ink-subtle">{current ? 'Review the questions, then adjust the cut and framing. You decide when the clip is ready.' : 'These results describe an earlier edit. Run Jev again to check your changes.'}</p>{candidate.review?.questions.map((q) => <Question key={q.id} q={q} />)}{!candidate.review && <p>No review is available yet. Run Jev to evaluate this candidate.</p>}{candidate.review?.cuts.map((cut, i) => <div key={i}><p className="editor-label">Removed {clock(cut.interval[0])} – {clock(cut.interval[1])}</p>{cut.questions.map((q) => <Question key={q.id} q={q} />)}</div>)}</div>}
          {tab === 'framing' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4"><div className="editor-layouts">{(['fill', 'split', 'fit'] as const).map((l) => <button key={l} className={cn(currentScene.layout === l && 'selected')} onClick={() => setLayout(l)}>{l === 'fill' ? 'Full frame' : l === 'split' ? 'Split' : 'Fit'}</button>)}</div>{currentScene.layout === 'split' && <div className="flex gap-2">{['Top', 'Bottom'].map((name, i) => <Button key={i} size="sm" variant={panel === i ? 'primary' : 'secondary'} onClick={() => setPanel(i)}>{name}</Button>)}</div>}{currentScene.layout !== 'fit' && <><label className="editor-label">Zoom<input aria-label="Crop zoom" type="range" min={1} max={4} step={.02} value={Math.min(4, defaultCrop(project.width, project.height, aspect * currentScene.crops.length)[2] / crop[2])} onChange={(e) => cropChange(defaultCrop(project.width, project.height, aspect * currentScene.crops.length, crop[0] + crop[2] / 2, crop[1] + crop[3] / 2, Number(e.target.value)))} /></label>{([0, 1] as const).map((axis) => <label key={axis} className="editor-label">{axis === 0 ? 'Horizontal' : 'Vertical'}<input type="range" aria-label={axis === 0 ? 'Horizontal crop position' : 'Vertical crop position'} min={0} max={Math.max(0, 1 - crop[axis + 2])} step={.001} value={crop[axis]} onChange={(e) => { const c = [...crop] as Crop; c[axis] = Number(e.target.value); cropChange(c) }} /></label>)}</>}{sceneIndex > 0 && <div className="editor-motion"><label className="flex items-center justify-between gap-2 text-xs"><span>Smooth movement</span><input type="checkbox" aria-label="Smooth movement" checked={!!currentScene.transition_ms} disabled={!canAnimate || editingDisabled} onChange={(e) => sceneChange({ transition_ms: e.target.checked ? 600 : undefined })} /></label>{canAnimate && currentScene.transition_ms ? <label className="editor-label mt-3">Duration <span className="float-right">{(currentScene.transition_ms / 1000).toFixed(1)}s</span><input aria-label="Movement duration" type="range" min={100} max={5000} step={100} value={currentScene.transition_ms} onChange={(e) => sceneChange({ transition_ms: Number(e.target.value) })} /></label> : !canAnimate ? <p className="text-2xs text-ink-subtle mt-2">Use the same layout as the previous section to animate its crops.</p> : null}{!!currentScene.transition_ms && <Button size="sm" variant="ghost" onClick={() => { seek(Math.max(start, currentScene.at_ms)); void video.current?.play() }}>Preview movement</Button>}</div>}<div className="space-y-2 border-t border-white/10 pt-3"><div className="editor-layout-time">
            {sceneIndex > 0 ? <label className="flex items-center justify-between gap-3 text-xs"><span>Layout starts</span><TimeInput key={sceneIndex} label="Layout start" value={currentScene.at_ms} disabled={editingDisabled} onChange={(t) => moveScene(sceneIndex, t)} /></label>
              : <p className="text-2xs text-ink-muted">Initial layout</p>}
            {sceneIndex + 1 < candidate.scenes.length && <p className="text-2xs text-ink-subtle mt-2">Until {clock(candidate.scenes[sceneIndex + 1].at_ms)}</p>}
          </div><Button size="sm" icon={<Scissors size={13} />} disabled={candidate.scenes.length >= 60 || time <= start || time >= end || candidate.scenes.some((s) => Math.abs(s.at_ms - time) < 100)} onClick={() => sceneChangeAtPlayhead(candidate, time, change)}>New layout here</Button>{sceneIndex > 0 && <Button size="sm" variant="ghost" onClick={() => change({ scenes: candidate.scenes.filter((_, i) => i !== sceneIndex) })}>Remove layout change</Button>}<Button size="sm" variant="ghost" onClick={() => change({ scenes: [{ ...currentScene, at_ms: 0 }] })}>Use layout for whole clip</Button></div></fieldset>}
          {tab === 'captions' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4"><div className="flex items-center justify-between text-xs"><span>Burn in captions</span><Switch label="Burn in captions" checked={candidate.captions} onChange={(captions) => change({ captions })} /></div><p className="text-2xs text-ink-subtle">Captions follow your final cuts. They are rendered only when you bake the clip. Edit their text in Transcript.</p>{candidate.captions && <CaptionPresetPicker value={candidate.caption_preset} onChange={(caption_preset) => change({ caption_preset })} />}<label className="editor-label">Playback speed<select value={candidate.video_speed} onChange={(e) => change({ video_speed: Number(e.target.value) })}>{[1, 1.1, 1.25, 1.5, 1.75, 2].map((n) => <option key={n} value={n}>{n}×</option>)}</select></label></fieldset>}
          {tab === 'transcript' && <div className="editor-transcript"><p className="text-2xs text-ink-subtle">Caption edits apply to this clip.</p>{project.transcript.map((r, i) => {
            const nearClip = r.end_ms >= start - 15000 && r.start_ms <= end + 15000
            const nearPlayhead = r.end_ms >= time - 15000 && r.start_ms <= time + 15000
            if (!nearClip && !nearPlayhead && editingCaption !== i) return null
            const edited = candidate.caption_edits?.some((e) => e.segment === i)
            return <div key={i} ref={r === activeTranscript ? activeCaption : undefined} aria-current={r === activeTranscript ? 'true' : undefined}
              className={cn('editor-transcript-row', r === activeTranscript && 'selected')}>
              <div className="editor-transcript-time"><button onClick={() => seek(r.start_ms)} title="Playhead to this line">{formatTimecode(r.start_ms)}</button>{edited && <span>Edited</span>}
                <Button variant="ghost" size="sm" iconOnly icon={<Pencil size={12} />} aria-label={`Edit caption at ${clock(r.start_ms)}`} title="Edit caption" disabled={!canEditCaption(i)} onClick={() => editCaption(i)} />
              </div>
              {editingCaption === i ? <><textarea ref={captionInput} aria-label={`Caption at ${clock(r.start_ms)}`} maxLength={2000} rows={3} value={captionText(i)} disabled={editingDisabled}
                onChange={(e) => { updateCaption(i, e.target.value, firstCaptionChange.current); firstCaptionChange.current = false }}
                onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); setEditingCaption(null) } }} />
                <div className="flex items-center justify-between mt-2"><Button size="sm" variant="ghost" disabled={editingDisabled || !edited} onClick={() => updateCaption(i, r.text)}>Reset text</Button><Button size="sm" onClick={() => setEditingCaption(null)}>Done</Button></div></>
                : <button className="editor-transcript-text" onClick={() => seek(r.start_ms)}>{captionText(i).trim() || <em>Caption hidden</em>}</button>}
            </div>
          })}{!project.transcript.length && <p>No spoken transcript is available for this source.</p>}</div>}

        </div>
      </aside>
    </div>
    {showAudit && <EditInspector outputDir={outputDir} onClose={() => setShowAudit(false)} />}
  </section>
}
function sceneChangeAtPlayhead(c: CandidateEdit, time: number, change: (p: Partial<CandidateEdit>) => void): void {
  change({ scenes: [...c.scenes, { ...structuredClone(framingAt(c, time)), at_ms: Math.round(time), transition_ms: undefined }].sort((a, b) => a.at_ms - b.at_ms) })
}
function TimeInput({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(clock(value))
  useEffect(() => setText(clock(value)), [value])
  const commit = (): void => {
    if (text === clock(value)) return
    const n = parseTimecode(text)
    setText(clock(value))
    if (n !== null && Number.isFinite(n)) onChange(Math.round(n * 1000))
  }
  return <input className="editor-time-input" aria-label={label} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
}
function trimDrag(e: React.PointerEvent<HTMLButtonElement>, index: number, edge: 0 | 1, viewStart: number, viewEnd: number, duration: number, c: EditorCandidate, edits: EditorCandidate[], selected: number, setEdits: React.Dispatch<React.SetStateAction<EditorCandidate[]>>, setUndo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, setRedo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, onDone: () => void): void {
  e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId)
  const target = e.currentTarget, bounds = target.parentElement!.parentElement!.getBoundingClientRect(), pointerStart = e.clientX
  setUndo((u) => [...u.slice(-49), edits]); setRedo([])
  const move = (event: PointerEvent): void => {
    const t = c.ranges[index][edge] + (event.clientX - pointerStart) / bounds.width * (viewEnd - viewStart)
    const ranges = trimRange(c.ranges, index, edge, t, duration)
    setEdits((items) => items.map((item, i) => i === selected ? refineEdit(item, { ranges }) : item))
  }
  const done = (): void => { target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done); onDone() }
  target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
}
