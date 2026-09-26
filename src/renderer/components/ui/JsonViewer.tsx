import { useMemo, useRef, useState } from 'react'
import { ChevronRight, Code2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { inspectJsonText, inspectJsonValue } from '../../lib/inspect-json'
import { Button } from './Button'
import { Segmented } from './Segmented'

function JsonNode({ value: original, name, depth = 0 }: { value: unknown; name?: string; depth?: number }): React.JSX.Element {
  const { value, encoded } = useMemo(() => inspectJsonValue(original), [original])
  const [open, setOpen] = useState(depth < 2)
  const [limit, setLimit] = useState(50)
  const [textLimit, setTextLimit] = useState(600)
  const entries = useMemo(() => value && typeof value === 'object' ? Object.entries(value).filter(([, v]) => v !== undefined) : null, [value])
  const parts = useMemo(() => typeof value === 'string' ? inspectJsonText(value) : [], [value])
  const key = name != null && <span className="break-all text-cyan-200">{name}<span className="text-ink-subtle">: </span></span>
  if (entries) {
    const array = Array.isArray(value)
    return <div className="min-w-0">
      <button type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${name ?? 'JSON'}`} aria-expanded={open}
        className="flex w-full items-start gap-1.5 rounded px-1 py-1 text-left hover:bg-white/5"
        onClick={() => setOpen(!open)}>
        <ChevronRight aria-hidden="true" className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform', open && 'rotate-90')} />
        <span className="min-w-0">{key}<span className="text-ink-muted">{array ? '[' : '{'}{!open && ' … '}{array ? ']' : '}'}</span>
          <span className="ml-2 font-sans text-ink-subtle">{entries.length} {array ? 'item' : 'field'}{entries.length !== 1 && 's'}</span>
          {encoded && <span className="ml-2 rounded bg-white/5 px-1.5 font-sans text-ink-muted" title="JSON saved inside text. Original preserves any code fences and string encoding.">JSON string</span>}
        </span>
      </button>
      {open && <div className="ml-2.5 border-l border-white/10 pl-3">
        {entries.slice(0, limit).map(([k, v]) => <JsonNode key={k} name={k} value={v} depth={depth + 1} />)}
        {entries.length === 0 && <p className="px-1 py-1 text-ink-subtle">Empty {array ? 'array' : 'object'}</p>}
        {entries.length > limit && <button type="button" className="my-1 rounded px-2 py-1 font-sans text-ink-muted hover:bg-white/5 hover:text-ink" onClick={() => setLimit(limit + 50)}>Show next {Math.min(50, entries.length - limit)} of {entries.length - limit} remaining</button>}
      </div>}
    </div>
  }
  if (parts.some(part => part.kind === 'json')) return <div className="min-w-0 py-1 pl-6">
    {key}<div className="mt-1 space-y-2 border-l border-white/10 pl-3">
      {parts.map((part, i) => part.kind === 'json' ? <JsonNode key={i} value={part.value} name="JSON" depth={depth + 1} />
        : <div key={i} className="whitespace-pre-wrap text-emerald-200 [overflow-wrap:anywhere]">{part.text.slice(0, textLimit)}{part.text.length > textLimit && '…'}</div>)}
      {parts.some(part => part.kind === 'text' && part.text.length > textLimit) && <button type="button" className="font-sans text-ink-muted underline hover:text-ink" onClick={() => setTextLimit(textLimit + 12000)}>Show more text</button>}
    </div>
  </div>
  const text = typeof value === 'string' ? value : String(value)
  return <div className="min-w-0 rounded px-1 py-1 pl-6 hover:bg-white/[0.025]">
    {key}<span className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', typeof value === 'string' ? 'text-emerald-200' : typeof value === 'number' ? 'text-amber-200' : value == null ? 'text-ink-subtle' : 'text-purple-200')}>
      {typeof value === 'string' && '"'}{text.slice(0, textLimit)}{text.length > textLimit ? '…' : ''}{typeof value === 'string' && '"'}
    </span>
    {text.length > textLimit && <button type="button" className="ml-2 rounded px-1 font-sans text-ink-muted underline hover:text-ink" onClick={() => setTextLimit(textLimit + 12000)}>Show more text</button>}
  </div>
}

/** Lazy branches keep large model requests usable without changing the saved data. */
export function JsonViewer({ value, label = 'Saved JSON', className }: { value: unknown; label?: string; className?: string }): React.JSX.Element {
  const [view, setView] = useState<'formatted' | 'original'>('formatted')
  const original = useRef<HTMLTextAreaElement>(null)
  const serialized = useMemo(() => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null', [value])
  return <section aria-label={label} className={cn('min-w-0 overflow-hidden rounded-xl border border-white/[0.08] bg-black/20', className)}>
    <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
      <span className="flex items-center gap-1.5 text-2xs text-ink-subtle"><Code2 className="h-3.5 w-3.5" aria-hidden="true" />JSON</span>
      <div className="flex items-center gap-2">
        {view === 'original' && <Button size="sm" variant="ghost" onClick={() => { original.current?.focus(); original.current?.select() }}>Select all</Button>}
        <Segmented size="sm" label="JSON view" value={view} onChange={setView} options={[{ value: 'formatted', label: 'Formatted' }, { value: 'original', label: 'Original' }]} />
      </div>
    </div>
    {view === 'formatted' ? <div className="max-h-80 overflow-auto overscroll-contain p-3 font-mono text-xs leading-relaxed" tabIndex={0} aria-label="Formatted JSON">
      <JsonNode value={value} />
    </div> : <textarea ref={original} readOnly spellCheck={false} aria-label="Original JSON" value={serialized}
      className="block h-80 w-full resize-y border-0 bg-transparent p-4 font-mono text-xs leading-relaxed text-ink-muted outline-none" />}
  </section>
}
