import { Camera, ChevronLeft, ChevronRight, ScanLine, X } from 'lucide-react'
import { Button } from './ui/Button'
import { cn } from '../lib/utils'
import { cameraMarkers, type EditorCandidate } from '../../shared/clip-editor'

export function CameraChanges({ candidate, threshold, setThreshold, selected, select, scan, insert, align, dismiss, restore, disabled, viewStart, viewEnd, clock }: {
  candidate: EditorCandidate; threshold: number; setThreshold: (n: number) => void
  selected: number | null; select: (t: number) => void; scan: () => void; insert: (t: number) => void
  align: (index: number, t: number) => void; dismiss: (t: number) => void; restore: () => void
  disabled: boolean; viewStart: number; viewEnd: number; clock: (t: number) => string
}): React.JSX.Element {
  const markers = cameraMarkers(candidate, threshold)
  const current = markers.findIndex((m) => m.at_ms === selected)
  const at = current >= 0 ? markers[current].at_ms : null
  const existing = at !== null && candidate.scenes.some((s) => Math.abs(s.at_ms - at) < .01)
  const nearest = at === null ? -1 : candidate.scenes.reduce((best, s, i) => i && (best < 0 || Math.abs(s.at_ms - at) < Math.abs(candidate.scenes[best].at_ms - at)) ? i : best, -1)
  const stale = candidate.camera_scan && (candidate.ranges[0][0] < candidate.camera_scan.start_ms || candidate.ranges.at(-1)![1] > candidate.camera_scan.end_ms)
  return <section className="editor-camera-changes" aria-label="Camera changes">
    <div className="editor-camera-tools">
      <Button size="sm" icon={<ScanLine size={13} />} disabled={disabled} onClick={scan}>{candidate.camera_scan ? 'Rescan camera changes' : 'Find camera changes'}</Button>
      {candidate.camera_scan && <><label>Sensitivity <select aria-label="Camera detection sensitivity" value={threshold} disabled={disabled} onChange={(e) => setThreshold(Number(e.target.value))}><option value={.2}>Strong cuts</option><option value={.08}>Balanced</option><option value={.025}>More sensitive</option></select></label><span>{markers.length} potential {markers.length === 1 ? 'change' : 'changes'}</span>
        <Button size="sm" variant="ghost" iconOnly icon={<ChevronLeft size={13} />} aria-label="Previous camera change" disabled={disabled || !markers.length} onClick={() => select(markers[current < 0 ? markers.length - 1 : (current - 1 + markers.length) % markers.length].at_ms)} />
        <Button size="sm" variant="ghost" iconOnly icon={<ChevronRight size={13} />} aria-label="Next camera change" disabled={disabled || !markers.length} onClick={() => select(markers[(current + 1) % markers.length].at_ms)} />
        {!!candidate.dismissed_camera_markers?.length && <Button size="sm" variant="ghost" disabled={disabled} onClick={restore}>Restore dismissed</Button>}
      </>}
    </div>
    {!candidate.camera_scan && <p>Scan this clip for missed cuts. Review suggestions, then add layouts at the exact frame.</p>}
    {stale && <p>Clip extended beyond the scanned footage. Rescan to include it.</p>}
    {candidate.camera_scan && !markers.length && <p>No visible suggestions at this sensitivity. Try “More sensitive”, or step through frames to place a layout yourself.</p>}
    {!!markers.length && <div className="editor-camera-track" aria-label="Potential camera changes">{markers.filter((m) => m.at_ms >= viewStart && m.at_ms <= viewEnd).map((m) => <button key={m.at_ms} aria-label={`Camera change at ${clock(m.at_ms)}`} aria-pressed={selected === m.at_ms} disabled={disabled} className={cn(selected === m.at_ms && 'selected')} style={{ left: `${(m.at_ms - viewStart) / (viewEnd - viewStart) * 100}%` }} onClick={() => select(m.at_ms)}><Camera size={12} /></button>)}</div>}
    {at !== null && <div className="editor-camera-selection"><span>Potential cut · {clock(at)}</span>
      <Button size="sm" disabled={disabled || existing || candidate.scenes.length >= 60} onClick={() => insert(at)}>{existing ? 'Layout already here' : 'Insert layout at cut'}</Button>
      {!existing && nearest > 0 && <Button size="sm" variant="ghost" disabled={disabled} title={`Move layout from ${clock(candidate.scenes[nearest].at_ms)}`} onClick={() => align(nearest, at)}>Align nearest layout</Button>}
      <Button size="sm" variant="ghost" icon={<X size={12} />} disabled={disabled} onClick={() => dismiss(at)}>Dismiss</Button>
    </div>}
  </section>
}
