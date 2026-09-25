import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, X } from 'lucide-react'
import type { ClipArtifact } from '../../shared/job-output'
import { cropViews, sourceToOutput, type FramingInspection, type FramingTrace, type Rect, type TraceSample } from '../../shared/framing-trace'
import { getApi } from '../lib/ipc'
import { errorMessage, localFileUrl } from '../lib/utils'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { RecordedEditorialReview } from './EditorialReview'

const colors = { faces: '#67e8f9', subject: '#fde047', webcam: '#4ade80', screen: '#60a5fa', crops: '#f0abfc' }
const names = { faces: 'Detected faces', subject: 'Subject / anchor', webcam: 'Webcam region', screen: 'Screen region', crops: 'Final crops' }
const layoutNames: Record<string, string> = { screen_cam: 'Screen + webcam', talking_head: 'Full-screen speaker', two_shot: 'Two people', screen: 'Whole frame' }
const time = (ms: number): string => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, '0')}`

export function heldSample(trace: FramingTrace, t: number): TraceSample | null {
  let low = 0, high = trace.samples.length - 1, found = -1
  while (low <= high) { const mid = (low + high) >>> 1; if (trace.samples[mid].t_ms <= t) { found = mid; low = mid + 1 } else high = mid - 1 }
  const sample = trace.samples[found]
  return sample && t - sample.t_ms < 1000 / trace.sample_fps + .01 ? sample : null
}

export function FramingInspector({ outputDir, clip, onClose }: { outputDir: string; clip: ClipArtifact; onClose: () => void }): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const [inspection, setInspection] = useState<FramingInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    getApi().framing.inspect(outputDir, clip.clip_index).then((value) => { if (active) setInspection(value) })
      .catch((err) => { if (active) setError(errorMessage(err, 'Could not open framing diagnostics.')) })
    return () => { active = false }
  }, [outputDir, clip.clip_index])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary, [tabindex="0"]') ?? [])]
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handler)
    return () => { document.removeEventListener('keydown', handler); previous?.focus() }
  }, [onClose])
  return <Dialog ref={panel} aria-label="Inspect framing" panelClassName="max-w-[1500px]" onBackdropMouseDown={onClose}>
    <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-3">
      <div><p className="text-2xs uppercase tracking-widest text-ink-subtle">Recorded run · Read only</p><h2 className="mt-1 text-lg font-semibold">Inspect framing <span className="ml-2 text-sm font-normal text-ink-muted">Clip {clip.clip_index + 1}</span></h2></div>
      <Button iconOnly variant="ghost" aria-label="Close framing inspector" icon={<X className="h-5 w-5" />} onClick={onClose} />
    </div>
    <div className="overflow-y-auto p-5">
      {error && <Callout tone="danger">{error}</Callout>}
      {!error && !inspection && <p className="py-12 text-center text-ink-muted">Loading recorded framing decisions…</p>}
      {inspection && <RecordedFramingView inspection={inspection} />}
    </div>
  </Dialog>
}

/** Pure recorded-run view, also mounted by the deterministic visual fixture. */
export function RecordedFramingView({ inspection, mediaUrl = localFileUrl }: { inspection: FramingInspection; mediaUrl?: (path: string) => string }): React.JSX.Element {
  const trace = inspection.trace
  if (!trace) return <div className="mx-auto max-w-xl py-14 text-center">
    <h3 className="text-lg font-medium">Framing diagnostics unavailable</h3>
    <p className="mt-3 leading-relaxed text-ink-muted">{inspection.message}</p>
    {inspection.clipPath && <video aria-label="Generated clip without diagnostics" className="mx-auto mt-6 max-h-72" controls src={mediaUrl(inspection.clipPath)} />}
  </div>
  return <TraceView key={`${trace.clip_index}:${trace.window.start_ms}`} trace={trace} inspection={inspection} mediaUrl={mediaUrl} />
}

function TraceView({ trace, inspection, mediaUrl }: { trace: FramingTrace; inspection: FramingInspection; mediaUrl: (path: string) => string }): React.JSX.Element {
  const source = useRef<HTMLVideoElement>(null), output = useRef<HTMLVideoElement>(null)
  const sourceReady = useRef(false), pendingSourceMs = useRef(trace.window.start_ms)
  const [sourceMs, setSourceMs] = useState(trace.window.start_ms)
  const [playing, setPlaying] = useState(false)
  const [fullSource, setFullSource] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [visible, setVisible] = useState({ faces: true, subject: true, webcam: true, screen: false, crops: true })
  const t = sourceMs - trace.window.start_ms
  const outputMs = sourceToOutput(trace, sourceMs)
  const piece = trace.video_pieces.find((p) => p.source_start_ms <= t && t < p.source_end_ms)
  const shot = piece ? trace.rendered_plan[piece.shot] : trace.rendered_plan.find((s) => s.start_ms <= t && t < s.end_ms)
  const decision = trace.decisions.find((d) => d.start_ms <= t && t < d.end_ms)
  const sample = heldSample(trace, t)
  const selectedTrack = decision?.tracks.find((track) => track.selected)
  const selectedIndex = sample && selectedTrack?.samples.find(([ms]) => ms === sample.t_ms)?.[1]
  const subject = shot?.content_box ?? (selectedIndex != null ? sample?.faces[selectedIndex]?.box : shot?.cam_face ?? shot?.people[0])
  const windowEnd = trace.window.start_ms + trace.window.duration_ms
  const min = fullSource ? 0 : trace.window.start_ms, max = fullSource ? trace.source.duration_ms : windowEnd
  const isRemoved = t >= 0 && t < trace.window.duration_ms && outputMs === null

  useEffect(() => {
    if (!playing) return
    let id = 0
    const tick = (): void => {
      const video = source.current
      if (video) { setSourceMs(video.currentTime * 1000); if (!fullSource && video.currentTime * 1000 >= windowEnd) { video.pause(); setPlaying(false); return } }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, fullSource, windowEnd])
  useEffect(() => {
    const video = output.current
    if (!video) return
    if (outputMs === null) { video.pause(); return }
    if (Math.abs(video.currentTime * 1000 - outputMs) > 75) video.currentTime = outputMs / 1000
    if (playing && video.paused) void video.play().catch(() => { setMediaError('The generated preview could not start playback.') })
    if (!playing) video.pause()
  }, [outputMs, playing])

  const seek = (ms: number): void => {
    const value = Math.min(trace.source.duration_ms, Math.max(0, ms))
    pendingSourceMs.current = value
    source.current?.pause(); output.current?.pause(); setPlaying(false); setSourceMs(value)
    if (source.current) source.current.currentTime = value / 1000
  }
  const togglePlayback = (): void => {
    if (playing) { source.current?.pause(); setPlaying(false) }
    else if (source.current) void source.current.play().then(() => setPlaying(true)).catch(() => setMediaError('The source preview could not start playback.'))
  }
  const sampleTimes = useMemo(() => trace.samples.map((s) => trace.window.start_ms + s.t_ms), [trace])
  const boundaryTimes = useMemo(() => [...new Set([0, ...trace.boundaries.filter((b) => b.accepted).map((b) => b.t_ms), ...trace.rendered_plan.flatMap((s) => [s.start_ms, s.end_ms])])].sort((a, b) => a - b).map((ms) => trace.window.start_ms + ms), [trace])
  const step = (times: number[], direction: number): void => {
    const value = direction < 0 ? times.findLast((ms) => ms < sourceMs - .1) : times.find((ms) => ms > sourceMs + .1)
    if (value !== undefined) seek(value)
  }
  const pixels = (box: Rect): Rect => [box[0] * trace.source.width, box[1] * trace.source.height, box[2] * trace.source.width, box[3] * trace.source.height]
  const boxes: { rect: Rect; color: string; label: string }[] = []
  if (visible.faces) sample?.faces.forEach((f, i) => boxes.push({ rect: pixels(f.box), color: colors.faces, label: `Face ${i + 1}${f.score == null ? '' : ` · ${(100 * f.score).toFixed(0)}%`}` }))
  if (visible.subject && subject && sample) boxes.push({ rect: pixels(subject), color: colors.subject, label: shot?.content_box ? 'Inset video region' : selectedIndex == null ? 'Framing anchor' : `Selected track ${selectedTrack?.id}` })
  if (visible.webcam && shot?.cam_box) boxes.push({ rect: pixels(shot.cam_box), color: colors.webcam, label: 'Webcam' })
  if (visible.screen && shot?.screen_box) boxes.push({ rect: pixels(shot.screen_box), color: colors.screen, label: 'Screen' })
  if (visible.crops && shot && outputMs !== null) cropViews(shot, t).forEach((r, i) => boxes.push({ rect: r, color: colors.crops, label: `Output crop ${i + 1}` }))

  return <div className="space-y-4">
    {inspection.message && <Callout tone="warning">{inspection.message}</Callout>}
    {mediaError && <Callout tone="warning">{mediaError}</Callout>}
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <p className="text-ink-muted">Source <span className="font-mono text-ink">{time(sourceMs)}</span><span className="mx-3 text-ink-faint">→</span>Output <span className="font-mono text-ink">{outputMs === null ? '—' : time(outputMs)}</span></p>
      <p className="rounded-full bg-white/5 px-3 py-1 text-ink-muted">{shot ? (shot.content_box ? 'Inset video' : layoutNames[shot.layout]) : 'Outside clip window'} · {shot?.source ?? 'No decision'}</p>
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(180px,1fr)]">
      <section className="min-w-0 rounded-2xl border border-white/10 bg-black/30 p-3">
        <div className="mb-2 flex justify-between text-xs"><h3 className="font-medium">Full source · uncropped</h3><span className="text-ink-subtle">{trace.source.width} × {trace.source.height}</span></div>
        <div className="relative mx-auto overflow-hidden rounded-lg bg-black" style={{ width: `min(100%, ${44 * trace.source.width / trace.source.height}vh)`, aspectRatio: `${trace.source.width}/${trace.source.height}` }}>
          {inspection.sourcePath ? <video ref={source} aria-label="Uncropped source preview" className="h-full w-full" preload="auto" src={mediaUrl(inspection.sourcePath)}
            onLoadedMetadata={() => { if (source.current) { source.current.currentTime = pendingSourceMs.current / 1000; sourceReady.current = true } }}
            onTimeUpdate={() => { if (sourceReady.current && source.current) setSourceMs(source.current.currentTime * 1000) }}
            onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} onError={() => setMediaError('The saved source preview could not be decoded. The trace remains available.')} />
            : <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-subtle">Source preview unavailable · overlays use recorded source coordinates</div>}
          <svg aria-label="Recorded framing overlays" className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${trace.source.width} ${trace.source.height}`}>
            {boxes.map(({ rect: [x, y, w, h], color, label }, i) => <g key={`${label}:${i}`}>
              <rect x={x} y={y} width={w} height={h} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <text x={x + 4} y={Math.max(trace.source.width / 65, y + trace.source.width / 65)} fill={color} fontSize={trace.source.width / 75} stroke="#000" strokeWidth={trace.source.width / 500} paintOrder="stroke">{label}</text>
            </g>)}
          </svg>
        </div>
        <p className="mt-2 text-2xs text-ink-subtle">{sample ? `Detection sample ${time(trace.window.start_ms + sample.t_ms)} · held for ${(t - sample.t_ms).toFixed(0)} ms · ${trace.sample_fps} fps sampling` : 'No detection sample at this time'}{sample?.faces.length === 0 ? ' · no face detected' : ''}</p>
      </section>
      <section className="min-w-0 rounded-2xl border border-white/10 bg-black/30 p-3">
        <h3 className="mb-2 text-xs font-medium">Generated clip · synchronized</h3>
        <div className="relative mx-auto flex items-center justify-center overflow-hidden rounded-lg bg-black" style={{ width: `min(100%, ${44 * trace.output.width / trace.output.height}vh)`, aspectRatio: `${trace.output.width}/${trace.output.height}` }}>
          {inspection.clipPath && <video ref={output} aria-label="Synchronized generated clip" muted className="h-full w-full" preload="auto" src={mediaUrl(inspection.clipPath)} onLoadedMetadata={() => { if (output.current && outputMs !== null) output.current.currentTime = outputMs / 1000 }} onError={() => setMediaError('The generated clip could not be decoded.')} />}
          {(outputMs === null || !inspection.clipPath) && <div className="absolute inset-0 flex items-center justify-center bg-black/95 p-5 text-center text-sm text-ink-muted">{!inspection.clipPath ? 'Generated clip unavailable' : isRemoved ? 'Removed from output — source playback continues' : 'Outside this clip’s render window'}</div>}
        </div>
      </section>
    </div>

    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="Overlay legend">
      {(Object.keys(colors) as (keyof typeof colors)[]).map((key) => <label key={key} className="inline-flex cursor-pointer items-center gap-1.5" style={{ color: colors[key] }}><input type="checkbox" checked={visible[key]} onChange={(e) => setVisible({ ...visible, [key]: e.target.checked })} />{names[key]}</label>)}
    </div>
    <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={togglePlayback} disabled={!inspection.sourcePath} icon={playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}>{playing ? 'Pause' : 'Play'}</Button>
        <Button size="sm" onClick={() => step(sampleTimes, -1)}>Previous sample</Button><Button size="sm" onClick={() => step(sampleTimes, 1)}>Next sample</Button>
        <Button size="sm" onClick={() => step(boundaryTimes, -1)}>Previous boundary</Button><Button size="sm" onClick={() => step(boundaryTimes, 1)}>Next boundary</Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted"><input type="checkbox" checked={fullSource} onChange={(e) => { setFullSource(e.target.checked); if (!e.target.checked) seek(Math.max(trace.window.start_ms, Math.min(windowEnd - 1, sourceMs))) }} />Full source range</label>
      </div>
      <input aria-label="Source time" className="mt-3 w-full accent-purple-400" type="range" min={min} max={max} step={1} value={Math.min(max, Math.max(min, sourceMs))} onChange={(e) => seek(Number(e.target.value))} />
      <div className="mb-3 flex justify-between font-mono text-2xs text-ink-subtle"><span>{time(min)}</span><span>{time(max)}</span></div>
      <TraceTimeline trace={trace} t={t} seek={(ms) => seek(trace.window.start_ms + ms)} />
    </div>

    {trace.editorial && <RecordedEditorialReview trace={trace.editorial} seek={seek} />}
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded-2xl border border-white/10 p-4">
        <h3 className="text-sm font-semibold">Decision at {time(sourceMs)}</h3>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-xs">
          <dt className="text-ink-subtle">Heuristic</dt><dd>{decision ? (decision.heuristic.content_box ? 'Inset video' : layoutNames[decision.heuristic.layout]) : 'Not recorded at this time'}</dd>
          <dt className="text-ink-subtle">AI classification</dt><dd>{decision?.vision.validated ? layoutNames[decision.vision.validated.layout] : decision?.vision.status === 'content_region' ? 'Local padding detection' : decision?.vision.status ?? 'Not recorded'}</dd>
          <dt className="text-ink-subtle">AI image</dt><dd>{decision?.vision.t_ms != null ? time(trace.window.start_ms + decision.vision.t_ms) : 'No image inspected'}</dd>
          <dt className="text-ink-subtle">Cache</dt><dd>{decision?.vision.cache_hit === true ? `Reused ${decision.vision.cache_id} · originally inspected at ${decision.vision.cache_source_ms == null ? 'unrecorded time' : time(decision.vision.cache_source_ms)}` : decision?.vision.cache_hit === false ? 'Fresh provider result' : 'Not used / not recorded'}</dd>
          <dt className="text-ink-subtle">Final layout</dt><dd>{shot ? `${shot.content_box ? 'Inset video' : layoutNames[shot.layout]} (${shot.source})` : 'Outside window'}{isRemoved ? ' · this interval was removed' : ''}</dd>
          {shot?.cam_box && <><dt className="text-ink-subtle">Webcam bounds</dt><dd>{shot.cam_box_refined ? 'Refined against source image edges' : 'Estimated region'}</dd></>}
          <dt className="text-ink-subtle">Detected faces</dt><dd>{sample?.faces.map((face, i) => `#${i + 1}: ${face.score == null ? 'score unavailable' : face.score.toFixed(3)}`).join(' · ') || 'None recorded'}</dd>
          <dt className="text-ink-subtle">Face evidence</dt><dd>{sample?.evidence ?? 'Ambiguous / unavailable'}</dd>
          <dt className="text-ink-subtle">Scene distance</dt><dd>{sample?.histogram_distance?.toFixed(3) ?? 'Unavailable'} · cut threshold {trace.thresholds.SHOT_CUT_THRESHOLD}</dd>
          <dt className="text-ink-subtle">Window / padding</dt><dd>{time(trace.window.start_ms)}–{time(windowEnd)} · requested {time(trace.window.requested_start_ms)}–{time(trace.window.requested_end_ms)}</dd>
        </dl>
        <p className="mt-3 text-2xs text-ink-subtle">Track IDs are local to a segment, not person identities. Yellow shows the heuristic’s selected track when available, otherwise the recorded framing anchor. These are recorded facts, not model reasoning.</p>
      </section>
      <section className="rounded-2xl border border-white/10 p-4 text-xs">
        <h3 className="text-sm font-semibold">Transitions & render outcome</h3>
        <div className="mt-3 space-y-2">{trace.boundaries.filter((b) => Math.abs(b.t_ms - t) <= 1500).map((b, i) => <p key={i}>{time(trace.window.start_ms + b.t_ms)} · {b.kind} · {b.accepted ? 'accepted' : 'merged short shot'}{b.hold_ms != null ? ` · ${b.samples} samples over ${b.hold_ms} ms (required ${b.to_layout === 'screen' ? trace.thresholds.MIN_SHOT_MS : trace.thresholds.LAYOUT_CHANGE_MS} ms)` : b.distance != null ? ` · distance ${b.distance.toFixed(3)}` : ''}</p>)}
          {!trace.boundaries.some((b) => Math.abs(b.t_ms - t) <= 1500) && <p className="text-ink-subtle">No recorded transition within 1.5 seconds.</p>}
          {trace.attempts.map((a, i) => <p key={i}>Attempt {i + 1}: {a.fallback ?? 'planned framing'} · <span className={a.status === 'failed' ? 'text-amber-300' : 'text-green-300'}>{a.status}</span>{a.failure ? ` (${a.failure})` : ''}</p>)}
        </div>
        <details className="mt-4"><summary className="cursor-pointer text-ink-muted">Attempted vs rendered plans</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-2xs">{JSON.stringify({ attempted: trace.attempted_plan.map((s) => [s.start_ms, s.end_ms, s.layout]), rendered: trace.rendered_plan.map((s) => [s.start_ms, s.end_ms, s.layout]) }, null, 2)}</pre></details>
        <details className="mt-3"><summary className="cursor-pointer text-ink-muted">Recorded thresholds & configuration</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-2xs">{JSON.stringify({ version: trace.version, ...trace.config, ...trace.thresholds }, null, 2)}</pre></details>
        <p className="mt-3 text-2xs text-ink-subtle">Crop paths come from renderer geometry. Detection boxes are sampled at {trace.sample_fps} fps and held briefly; no per-frame detection is implied. Playback and scrubbing make no AI calls.</p>
      </section>
    </div>
  </div>
}

function TraceTimeline({ trace, t, seek }: { trace: FramingTrace; t: number; seek: (ms: number) => void }): React.JSX.Element {
  const duration = trace.window.duration_ms
  const removed: [number, number][] = []
  let end = 0
  for (const [a, b] of trace.keeps) { if (a > end) removed.push([end, a]); end = b }
  if (end < duration) removed.push([end, duration])
  const tracks = [
    { label: 'Layout', items: trace.rendered_plan.map((s) => ({ a: s.start_ms, b: s.end_ms, text: s.content_box ? 'Inset video' : layoutNames[s.layout], color: s.layout === 'screen_cam' ? '#166534' : s.layout === 'talking_head' ? '#6b21a8' : '#334155' })) },
    { label: 'Transitions', items: trace.boundaries.map((b) => ({ a: b.t_ms, b: b.t_ms, text: `${b.kind} ${b.accepted ? 'accepted' : 'merged'}`, color: b.accepted ? '#fbbf24' : '#64748b' })) },
    { label: 'AI images', items: trace.decisions.filter((d) => d.vision.t_ms != null).map((d) => ({ a: d.vision.t_ms!, b: d.vision.t_ms!, text: d.vision.cache_hit ? 'Cached vision result' : `AI image · ${d.vision.status}`, color: '#38bdf8' })) },
    { label: 'Kept / removed', items: [...trace.keeps.map(([a, b]) => ({ a, b, text: 'Kept', color: '#334155' })), ...removed.map(([a, b]) => ({ a, b, text: 'Removed from output', color: '#9f1239' }))] },
    { label: 'Planner skips', items: trace.planner_skips.map(([a, b]) => ({ a, b, text: 'Planner skip', color: '#c2410c' })) },
    ...(trace.editorial ? [
      { label: 'Protected context', items: trace.editorial.protected_source.map(([a, b]) => ({ a: Math.max(0, a - trace.window.start_ms), b: Math.min(duration, b - trace.window.start_ms), text: 'Protected context', color: '#047857' })).filter((s) => s.b > s.a) },
      { label: 'Prevented cuts', items: trace.editorial.prevented_cuts.map(({ interval: [a, b], kind }) => ({ a: Math.max(0, a - trace.window.start_ms), b: Math.min(duration, b - trace.window.start_ms), text: `Prevented ${kind.replaceAll('_', ' ')}`, color: '#a16207' })).filter((s) => s.b > s.a) }
    ] : [])
  ]
  return <div className="space-y-1.5" aria-label="Framing timeline">
    {tracks.map((track) => <div key={track.label} className="flex items-center gap-3"><span className="w-24 shrink-0 text-2xs text-ink-subtle">{track.label}</span>
      <div className="relative h-6 flex-1 overflow-hidden rounded bg-black/25">
        {track.items.map((item, i) => <button key={i} title={`${time(trace.window.start_ms + item.a)} · ${item.text}`} aria-label={`${track.label}: ${item.text} at ${time(trace.window.start_ms + item.a)}`} onClick={() => seek(item.a)}
          className="absolute inset-y-0 truncate border-r border-black/20 px-1 text-left text-[10px] text-white" style={{ left: `${item.a / duration * 100}%`, width: item.a === item.b ? '3px' : `${(item.b - item.a) / duration * 100}%`, padding: item.a === item.b ? 0 : undefined, backgroundColor: item.color }}>{item.b - item.a > duration / 8 ? item.text : ''}</button>)}
        {t >= 0 && t < duration && <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: `${t / duration * 100}%` }} />}
      </div>
    </div>)}
  </div>
}
