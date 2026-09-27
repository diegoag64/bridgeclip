import { useEffect, useId, useRef, useState } from 'react'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Select } from './ui/Select'
import { Camera, RotateCcw, ScanLine, Trash2 } from 'lucide-react'
import { Button } from './ui/Button'
import { cn } from '../lib/utils'
import { cameraMarkers, type EditorCandidate } from '../../shared/clip-editor'

export function CameraScanButton({ candidate, threshold, setThreshold, scan, restore, disabled, onOpen }: {
  candidate: EditorCandidate; threshold: number; setThreshold: (n: number) => void
  scan: () => void; restore: () => void; disabled: boolean; onOpen: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [sensitivity, setSensitivity] = useState(threshold)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const label = candidate.camera_scan ? 'Rescan camera changes' : 'Find camera changes'
  const stale = candidate.camera_scan && (candidate.ranges[0][0] < candidate.camera_scan.start_ms || candidate.ranges.at(-1)![1] > candidate.camera_scan.end_ms)
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus()
    return () => { previousFocus?.focus() }
  }, [open])
  return <>
    <Button size="sm" variant="ghost" iconOnly icon={<ScanLine size={14} />} disabled={disabled}
      aria-label={label} tooltip={`${label}: choose sensitivity and scan for suggested camera cuts. Your edits are kept.`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setSensitivity(threshold); onOpen(); setOpen(true) }} />
    {open && <Dialog ref={panel} aria-labelledby={titleId} aria-describedby={descriptionId} panelClassName="max-w-[420px]"
      onBackdropMouseDown={() => setOpen(false)} onKeyDown={(event) => {
        event.stopPropagation()
        if (event.defaultPrevented) return
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
        if (event.key !== 'Tab') return
        const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')
        if (!controls?.length) return
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault(); (event.shiftKey ? last : first).focus()
        }
      }}>
      <div className="overflow-y-auto p-5 space-y-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-ink">{label}</h2>
          <p id={descriptionId} className="mt-1.5 text-sm text-ink-muted">Scan this clip for camera cuts and show suggestions on the timeline. Review each marker to add or align a layout. Scanning runs locally and keeps your existing edits.</p>
        </div>
        {stale && <p className="text-xs text-warning">This clip extends beyond the last scan. Rescan to include the added footage.</p>}
        {candidate.camera_scan && !cameraMarkers(candidate, threshold).length && <p className="text-xs text-ink-muted">No visible suggestions from the last scan. Try a higher sensitivity to reveal weaker cuts.</p>}
        <div className="space-y-2">
          <label htmlFor={`${titleId}-sensitivity`} className="block text-xs font-medium text-ink">Sensitivity</label>
          <Select id={`${titleId}-sensitivity`} aria-label="Camera detection sensitivity" value={String(sensitivity)} onChange={(value) => setSensitivity(Number(value))}
            options={[{ value: '0.2', label: 'Strong cuts' }, { value: '0.08', label: 'Balanced' }, { value: '0.025', label: 'More sensitive' }]} />
          <p className="text-xs text-ink-subtle">{sensitivity === .2 ? 'Show only the clearest cuts between shots.' : sensitivity === .08 ? 'Show likely cuts with fewer false alarms.' : 'Include subtle changes. Motion and flashes may also appear as suggestions.'}</p>
        </div>
        {!!candidate.dismissed_camera_markers?.length && <Button size="sm" variant="ghost" disabled={disabled} icon={<RotateCcw size={13} />}
          onClick={() => { restore(); setOpen(false) }}>Restore removed markers</Button>}
      </div>
      <DialogFooter>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={disabled} icon={<ScanLine size={14} />} onClick={() => { setThreshold(sensitivity); setOpen(false); scan() }}>Scan clip</Button>
      </DialogFooter>
    </Dialog>}
  </>
}

export function CameraChanges({ candidate, threshold, selected, select, deselect, insert, align, remove, disabled, viewStart, viewEnd, clock }: {
  candidate: EditorCandidate; threshold: number
  selected: number | null; select: (t: number) => void; deselect: () => void; insert: (t: number) => void
  align: (index: number, t: number) => void; remove: (t: number) => void
  disabled: boolean; viewStart: number; viewEnd: number; clock: (t: number) => string
}): React.JSX.Element {
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (selected === null) return
    const clickAway = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Element && root.current?.contains(target) &&
          target.closest('.editor-camera-track button, .editor-camera-selection')) return
      deselect()
    }
    // Wait for the click so hiding the action row doesn't shift timeline targets
    // between pointer-down and their own click/seek handlers.
    document.addEventListener('click', clickAway)
    return () => document.removeEventListener('click', clickAway)
  }, [selected, deselect])
  const markers = cameraMarkers(candidate, threshold)
  const current = markers.findIndex((m) => m.at_ms === selected)
  const at = current >= 0 ? markers[current].at_ms : null
  const existing = at !== null && candidate.scenes.some((s) => Math.abs(s.at_ms - at) < .01)
  const nearest = at === null ? -1 : candidate.scenes.reduce((best, s, i) => i && (best < 0 || Math.abs(s.at_ms - at) < Math.abs(candidate.scenes[best].at_ms - at)) ? i : best, -1)
  if (!markers.length) return <></>
  return <section ref={root} className="editor-camera-changes" aria-label="Camera changes" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); deselect() }
  }}>
    {!!markers.length && <div className="editor-camera-track" aria-label="Potential camera changes">{markers.filter((m) => m.at_ms >= viewStart && m.at_ms <= viewEnd).map((m) => <button key={m.at_ms} aria-label={`Camera change at ${clock(m.at_ms)}`} aria-pressed={selected === m.at_ms} disabled={disabled} className={cn(selected === m.at_ms && 'selected')} style={{ left: `${(m.at_ms - viewStart) / (viewEnd - viewStart) * 100}%` }} onClick={() => select(m.at_ms)}><Camera size={12} /></button>)}</div>}
    {at !== null && <div className="editor-camera-selection"><span>Potential cut · {clock(at)}</span>
      <Button size="sm" disabled={disabled || existing || candidate.scenes.length >= 60} onClick={() => insert(at)}>{existing ? 'Layout already here' : 'Insert layout at cut'}</Button>
      {!existing && nearest > 0 && <Button size="sm" variant="ghost" disabled={disabled} title={`Move layout from ${clock(candidate.scenes[nearest].at_ms)}`} onClick={() => align(nearest, at)}>Align nearest layout</Button>}
      <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={disabled} title="Remove this camera-change suggestion. Your layouts and cuts are kept." onClick={() => remove(at)}>Remove camera marker</Button>
    </div>}
  </section>
}
