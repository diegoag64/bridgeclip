import { useEffect, useId, useRef, useState } from 'react'
import type { Automation, AutomationContent, AutomationSourceContext } from '../../shared/automations'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { platformName } from './PlatformIcon'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Field, TextArea, TextInput } from './ui/Field'
import { Switch } from './ui/Switch'

const EMPTY_SOURCE: AutomationSourceContext = { title: '', description: '', channel: '', url: null }

export function AutomationMetadataDialog({ automationId, item, youtubeOnly, onUpdated, onClose, onBusy }: {
  automationId: string; item: AutomationContent; youtubeOnly: boolean; onUpdated: (items: Automation[]) => void; onClose: () => void; onBusy: (busy: boolean) => void
}): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState(item.metadataDraft?.source ?? item.sourceContext ?? EMPTY_SOURCE)
  const [research, setResearch] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [loading, setLoading] = useState(!item.metadataDraft)
  const [error, setError] = useState<string | null>(null)
  const draft = item.metadataDraft
  const sourceRequest = useRef<Promise<AutomationSourceContext | null> | null>(null)
  useEffect(() => {
    if (item.metadataDraft) return
    let active = true
    onBusy(true)
    sourceRequest.current ??= getApi().automations.source(automationId, item.id)
    void sourceRequest.current.then((value) => { if (active) setSource(value ?? EMPTY_SOURCE) })
      .catch((cause) => { if (active) setError(errorMessage(cause, 'Could not recover the source context.')) })
      .finally(() => { if (active) { setLoading(false); onBusy(false) } })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => { previous?.focus() }
  }, [])
  const run = async (action: string, request: () => Promise<Automation[]>, close = false): Promise<void> => {
    setWorking(action); onBusy(true); setError(null)
    try { onUpdated(await request()); if (close) onClose() }
    catch (cause) { setError(errorMessage(cause, 'Could not enhance metadata.')) }
    finally { setWorking(null); onBusy(false) }
  }
  const busy = loading || Boolean(working)
  return <Dialog ref={panel} aria-labelledby={titleId} panelClassName="max-w-3xl" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
    if (event.key === 'Tab') {
      const buttons = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')
      if (!buttons?.length) { event.preventDefault(); return }
      const first = buttons[0]; const last = buttons[buttons.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus() }
    }
  }}>
    <div className="min-h-0 overflow-y-auto p-5 space-y-4">
      <h2 id={titleId} className="text-lg font-semibold text-ink">{draft ? 'Review enhanced metadata' : 'Enhance title & caption'}</h2>
      <p className="text-sm text-ink-muted">{item.title}</p>
      {error && <Callout tone="danger">{error}</Callout>}
      {draft ? <>
        <Callout tone="info">This clip is held from posting until you apply or discard this draft. Applying resumes its normal queue position.</Callout>
        <details className="glass-well rounded-xl p-3 text-xs text-ink-muted"><summary>Current title & caption</summary>
          <p className="mt-2 font-medium text-ink">{item.title}</p><p className="mt-1 whitespace-pre-wrap">{item.caption}</p>
        </details>
        {draft.posts.map((post) => <section key={post.platform} className="glass-well rounded-xl p-4">
          <h3 className="text-sm font-semibold text-ink">{platformName(post.platform)}</h3>
          {post.title && <p className="mt-2 font-medium text-ink" data-selectable>{post.title}</p>}
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-muted" data-selectable>{post.caption}</p>
          {post.tags.length > 0 && <p className="mt-2 text-xs text-ink-subtle">Keywords: {post.tags.join(', ')}</p>}
        </section>)}
        <details className="glass-well rounded-xl p-3 text-xs text-ink-muted" open={draft.research.status === 'unavailable'}>
          <summary className="cursor-pointer font-medium text-ink">Context & research · {draft.research.status}{draft.research.scope === 'source' ? (draft.research.reused ? ' · reused video research' : ' · shared video research') : ''}</summary>
          <p className="mt-2 whitespace-pre-wrap" data-selectable>{draft.source?.title || 'No original video identified'}{draft.source?.channel ? ` · ${draft.source.channel}` : ''}</p>
          <p className="mt-2 whitespace-pre-wrap" data-selectable>{draft.source?.description || 'Original description unavailable; no description was assumed.'}</p>
          <p className="mt-3 whitespace-pre-wrap" data-selectable>{draft.research.summary}</p>
          {draft.research.sources.map((citation) => <p key={citation.url} className="mt-2 break-all" data-selectable>{citation.title}<br />{citation.url}</p>)}
        </details>
      </> : <>
        <p className="text-sm text-ink-muted">Uses this clip’s speech and original video context. Optional web research finds relevant topic terms. Uses your OpenRouter credits; nothing is published by this action.</p>
        {youtubeOnly && <p className="text-xs text-ink-subtle">Drafting for YouTube. Select destination accounts in the automation settings to include other platforms.</p>}
        {loading ? <p className="text-sm text-ink-muted" role="status">Finding the original video and its description…</p> : <>
          {!source.description && <Callout tone="warning">No original description is available yet. Paste it below, or enter the original YouTube URL to retrieve it when generating.</Callout>}
          <Field label="Original video title" htmlFor={`${titleId}-source-title`}><TextInput id={`${titleId}-source-title`} value={source.title} maxLength={1024} disabled={busy} onChange={(event) => setSource({ ...source, title: event.target.value })} /></Field>
          <Field label="Original YouTube URL (optional)" htmlFor={`${titleId}-source-url`}><TextInput id={`${titleId}-source-url`} value={source.url ?? ''} maxLength={2048} disabled={busy} onChange={(event) => setSource({ ...source, url: event.target.value || null })} /></Field>
          <Field label="Original description" htmlFor={`${titleId}-source-description`}><TextArea id={`${titleId}-source-description`} className="min-h-[150px]" value={source.description} maxLength={20000} disabled={busy} onChange={(event) => setSource({ ...source, description: event.target.value })} /></Field>
          <label className="flex items-center justify-between gap-3 text-sm text-ink"><span>Quick web research <span className="text-ink-subtle">· up to 3 sources</span></span><Switch checked={research} onChange={setResearch} disabled={busy} label="Quick web research" /></label>
        </>}
      </>}
      {working && <p role="status" className="text-sm text-ink-muted">{working === 'generate' ? 'Preparing transcript, researching the topic and writing a draft…' : 'Saving your choice…'}</p>}
    </div>
    <DialogFooter>
      <Button disabled={busy} onClick={onClose}>{draft ? 'Review later' : 'Cancel'}</Button>
      {draft ? <>
        <Button disabled={busy} onClick={() => void run('discard', () => getApi().automations.resolveDraft(automationId, item.id, draft.id, false), true)}>Discard draft</Button>
        <Button variant="primary" loading={working === 'apply'} disabled={busy} onClick={() => void run('apply', () => getApi().automations.resolveDraft(automationId, item.id, draft.id, true), true)}>Apply metadata</Button>
      </> : <Button variant="primary" loading={working === 'generate'} disabled={busy} onClick={() => void run('generate', () => getApi().automations.enhance(automationId, item.id, { source, research }))}>Generate draft</Button>}
    </DialogFooter>
  </Dialog>
}
