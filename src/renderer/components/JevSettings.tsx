import { useEffect, useState, type CSSProperties } from 'react'
import { JEV_DEFAULTS, JEV_DOCS_URL, JEV_CONFIDENCE_URL, type JevThresholdKey } from '../../shared/jev-settings'
import { useSettingsStore } from '../store/use-settings-store'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import './jev-settings.css'

const controls: { key: JevThresholdKey; label: string; description: string }[] = [
  { key: 'jevThreshold', label: 'Core clip quality', description: 'Opening context, a complete ending, and logical flow. Each check must pass.' },
  { key: 'jevSelfContainedThreshold', label: 'Self-contained context', description: 'The clip supplies enough context to understand its main point.' },
  { key: 'jevFaithfulToSourceThreshold', label: 'Faithful to source', description: 'The edit preserves the meaning of the original statements.' },
  { key: 'jevTitleSupportedThreshold', label: 'Title accuracy', description: 'The dialogue supports the title without invented or exaggerated claims.' },
  { key: 'jevSponsorThreshold', label: 'Free of sponsorship', description: 'The clip is free of sponsor reads, paid promotions, and affiliate pitches.' },
  { key: 'jevEvidenceThreshold', label: 'Sufficient evidence', description: 'Enough evidence is available to judge a clip or proposed cut.' },
  { key: 'jevCutThreshold', label: 'Safe cuts', description: 'Removing material preserves meaning and creates a logical join. Both checks must pass.' }
]
type Draft = Record<JevThresholdKey, string>
const toPercent = (value: string): string => String(Math.round(Number(value) * 10000) / 100)
const defaults = Object.fromEntries(controls.map(({ key }) => [key, toPercent(JEV_DEFAULTS[key])])) as Draft
const valid = (value: string): boolean => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100

export function JevSettings(): React.JSX.Element {
  const settings = useSettingsStore()
  const signature = JSON.stringify(controls.map(({ key }) => settings[key]))
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(controls.map(({ key }) => [key, toPercent(settings[key])])) as Draft)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const values = JSON.parse(signature) as string[]
    setDraft(Object.fromEntries(controls.map(({ key }, index) => [key, toPercent(values[index])])) as Draft)
  }, [signature])
  const enabled = settings.jevEnabled === 'on'
  const busy = settings.saving || !settings.loaded
  const dirty = controls.some(({ key }) => Number(draft[key]) !== Number(toPercent(settings[key])) || draft[key] === '')
  const invalid = controls.some(({ key }) => !valid(draft[key]))
  const customized = controls.filter(({ key }) => Number(draft[key]) !== Number(defaults[key])).length
  const change = (key: JevThresholdKey, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }
  const save = async (patch: Parameters<typeof settings.save>[0]): Promise<void> => {
    setError(null)
    setSaved(false)
    try { await settings.save(patch); setSaved(true) }
    catch (err) { setError(errorMessage(err, 'Could not save Jev settings. Your changes are still here.')) }
  }
  const apply = (): void => {
    if (invalid || busy) return
    void save(Object.fromEntries(controls.map(({ key }) => [key, String(Math.round(Number(draft[key]) * 100) / 10000)])))
  }
  return <section id="settings-jev" className="jev-settings scroll-mt-14" aria-labelledby="jev-heading">
    <header className="jev-hero">
      <div className="jev-topline"><span className="jev-wordmark">TypeSafe AI</span><span className="jev-chip">Advanced automation</span></div>
      <div className="jev-intro">
        <div><h2 id="jev-heading">Jev<span aria-hidden="true">.</span></h2><p className="jev-tagline">Editorial checks for automatic clipping.</p></div>
      </div>
      <p className="jev-description">Jev checks whether clips make sense on their own and preserve the source’s meaning. It also checks titles, sponsorship, and proposed cuts. These advanced settings control the probability thresholds BridgeClip uses to accept edits, request repairs, restore removed material, or skip clips.</p>
      <button className="jev-docs" onClick={() => { void getApi().shell.openPath(JEV_DOCS_URL).catch(err => setError(errorMessage(err, 'Could not open the documentation'))) }}>Explore the TypeSafe docs</button>
    </header>
    <div className="jev-body">
      <div className="jev-enable-row">
        <div><h3 id="jev-enable-label">Jev for automatic clips</h3><p id="jev-enable-description">Review &amp; edit always uses Jev. Both workflows use your OpenRouter key.</p></div>
        <button className="jev-switch" role="switch" aria-labelledby="jev-enable-label" aria-describedby="jev-enable-description" aria-checked={enabled} aria-controls="jev-fields" disabled={busy} onClick={() => { void save({ jevEnabled: enabled ? 'off' : 'on' }) }}><span /></button>
      </div>
      {!enabled && <p className="jev-off" role="status">Jev is off for automatic clipping, which uses the planner’s proposed clips and cuts without Jev checks or repairs. Review &amp; edit still uses Jev with your saved thresholds.</p>}
      <div id="jev-fields" className="jev-accordion" data-open={enabled} aria-hidden={!enabled} inert={!enabled}>
        <div className="jev-accordion-content">
      <div className="jev-controls-heading"><div><span className="jev-kicker">Approval thresholds</span><h3>Set the bar for every decision.</h3></div><span className="jev-customized">{customized ? `${customized} customized` : 'BridgeClip defaults'}</span></div>
      <p className="jev-explainer">Higher values demand stronger evidence and may approve fewer clips or cuts. Lower values allow more uncertainty. Every applicable check must pass.</p>
      <fieldset disabled={!enabled || busy} className="jev-controls"><legend className="sr-only">Jev approval thresholds</legend>
        {controls.map(({ key, label, description }, i) => <div className={`jev-control ${key === 'jevCutThreshold' ? 'jev-control-cut' : ''}`} key={key}>
          <div className="jev-control-top"><label htmlFor={`${key}-number`}><span className="jev-index" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>{label}</label><div className="jev-number"><input id={`${key}-number`} type="number" min="0" max="100" step="0.01" inputMode="decimal" value={draft[key]} aria-invalid={!valid(draft[key])} aria-describedby={`${key}-help`} onChange={e => change(key, e.target.value)} /><span>%</span></div></div>
          <p id={`${key}-help`}>{description}</p>
          <input className="jev-range" type="range" min="0" max="100" step="1" aria-label={`${label} threshold`} aria-describedby={`${key}-help`} aria-valuetext={`${draft[key]} percent`} value={valid(draft[key]) ? draft[key] : 0} style={{ '--jev-value': `${valid(draft[key]) ? draft[key] : 0}%` } as CSSProperties} onChange={e => change(key, e.target.value)} />
          <div className="jev-scale"><span>More permissive</span><span>Default {defaults[key]}%</span><span>More selective</span></div>
        </div>)}
      </fieldset>
      <div className="jev-actions"><button className="jev-reset" disabled={busy || !enabled || !customized} onClick={() => { setDraft({ ...defaults }); setSaved(false); setError(null) }}>Restore defaults</button><div><span role="status" className="jev-save-state">{busy ? 'Saving…' : invalid ? 'Enter a value from 0 to 100.' : dirty ? 'Unapplied changes' : saved ? 'Saved' : 'Changes apply to new reviews'}</span><button className="jev-apply" disabled={busy || !enabled || !dirty || invalid} onClick={apply}>Apply thresholds</button></div></div>
      <div className="jev-footnote"><p>These are minimum answer probabilities, not a guarantee of correctness or the confidence metric returned by Choice and Score. Existing review results keep the thresholds they used. Test changes on representative clips before relying on automation. Reaction protection and advisory checks retain their own safeguards. <button className="jev-learn" onClick={() => { void getApi().shell.openPath(JEV_CONFIDENCE_URL).catch(err => setError(errorMessage(err, 'Could not open the documentation'))) }}>Understanding probability &amp; confidence ↗</button></p></div>
      <details className="jev-evidence"><summary>Visual evidence &amp; data use</summary><label><input type="checkbox" checked={settings.jevVisualContext === 'on'} disabled={!enabled || busy} onChange={e => { void save({ jevVisualContext: e.target.checked ? 'on' : 'off' }) }} /><span>Use additional visual evidence for reaction context</span></label><p>When text is insufficient, timestamped frames go to your OpenRouter vision model: up to 8 requests per run and 12 frames per interval, with additional charges.</p><p>Jev receives transcript excerpts, titles, and diagnostic text through OpenRouter, with no video or audio. Review charges use your existing OpenRouter account. Unapproved cuts are restored.</p></details>
        </div>
      </div>
      {error && <p className="jev-error" role="alert">{error}</p>}
    </div>
  </section>
}
