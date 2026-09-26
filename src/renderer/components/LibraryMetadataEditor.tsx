import { useEffect, useId, useRef, useState } from 'react'
import type { AutomationSourceContext, MetadataEnhancement } from '../../shared/automations'
import type { LibraryEnhancementOptions } from '../../shared/library-posting'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { MetadataDraftPreview } from './MetadataDraftPreview'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Field, TextArea, TextInput } from './ui/Field'
import { Switch } from './ui/Switch'

export function LibraryMetadataEditor({ library, options, onApply, onClose, onBusy }: {
  library: { outputDir: string; clipIndex: number }
  options: Omit<LibraryEnhancementOptions, 'source' | 'research'>
  onApply: (draft: MetadataEnhancement) => void
  onClose: () => void
  onBusy: (busy: boolean) => void
}): React.JSX.Element {
  const id = useId()
  const [source, setSource] = useState<AutomationSourceContext>({ title: '', description: '', channel: '', url: null })
  const [research, setResearch] = useState(true)
  const [draft, setDraft] = useState<MetadataEnhancement | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const currentScope = [...options.platforms].sort().join(',') + ':' + options.facebookFormat
  const scope = useRef(currentScope)
  scope.current = currentScope
  useEffect(() => { setDraft(null) }, [currentScope])
  useEffect(() => {
    let active = true
    void getApi().history.metadataSource(library.outputDir, library.clipIndex)
      .then((value) => { if (active && value) setSource(value) })
      .catch((cause) => { if (active) setError(errorMessage(cause, 'Could not load the original video context.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [library.outputDir, library.clipIndex])
  const generate = async (): Promise<void> => {
    if (inFlight.current || !options.platforms.length) return
    inFlight.current = true
    const startedScope = scope.current
    setBusy(true); onBusy(true); setError(null)
    try {
      const value = await getApi().history.enhanceMetadata(library.outputDir, library.clipIndex, { ...options, source, research })
      if (startedScope === scope.current) setDraft(value)
      else setError('Destination platforms changed. Generate a draft for the current selection.')
    } catch (cause) { setError(errorMessage(cause, 'Could not enhance this clip. Try again.')) }
    finally { inFlight.current = false; setBusy(false); onBusy(false) }
  }
  return <section className="glass-well space-y-3 rounded-xl p-4" aria-label="Enhance post metadata">
    <h3 className="text-sm font-semibold text-ink">{draft ? 'Review enhanced metadata' : 'Enhance title, caption & tags'}</h3>
    {error && <Callout tone="danger">{error}</Callout>}
    {draft ? <MetadataDraftPreview draft={draft} /> : <>
      <p className="text-xs text-ink-muted">Uses the same transcript, source context and optional web research as automation enhancement. Uses your OpenRouter credits. Review the draft before applying it.</p>
      {loading ? <p role="status" className="text-xs text-ink-muted">Loading original video context…</p> : <fieldset disabled={busy} className="space-y-3">
        <Field label="Original video title" htmlFor={`${id}-title`}><TextInput id={`${id}-title`} value={source.title} maxLength={1024} onChange={(event) => setSource({ ...source, title: event.target.value })} /></Field>
        <Field label="Original YouTube URL (optional)" htmlFor={`${id}-url`}><TextInput id={`${id}-url`} value={source.url ?? ''} maxLength={2048} onChange={(event) => setSource({ ...source, url: event.target.value || null })} /></Field>
        <Field label="Original description" htmlFor={`${id}-description`}><TextArea id={`${id}-description`} rows={4} value={source.description} maxLength={20000} onChange={(event) => setSource({ ...source, description: event.target.value })} /></Field>
        <label className="flex items-center justify-between gap-3 text-xs text-ink">Quick web research · up to 3 sources<Switch label="Quick web research" checked={research} onChange={setResearch} /></label>
      </fieldset>}
    </>}
    {busy && <p role="status" className="text-xs text-ink-muted">Transcribing this clip, researching context and writing metadata…</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" disabled={busy} onClick={onClose}>{draft ? 'Discard draft' : 'Cancel enhancement'}</Button>
      {draft ? <Button size="sm" variant="primary" onClick={() => onApply(draft)}>Apply metadata</Button>
        : <Button size="sm" variant="primary" loading={busy} disabled={busy || loading || !options.platforms.length} onClick={() => void generate()}>Generate draft</Button>}
    </div>
  </section>
}
