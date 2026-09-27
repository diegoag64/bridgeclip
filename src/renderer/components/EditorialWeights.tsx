import { defaultWeights, scoreNames, type ScoreName } from '../../shared/editorial'

export function EditorialWeights({ value, onChange }: { value: Record<ScoreName, number>; onChange: (value: Record<ScoreName, number>) => void }): React.JSX.Element {
  return <details className="rounded-xl border border-white/10 p-3 text-xs">
    <summary className="cursor-pointer text-ink-muted">Editorial ranking weights</summary>
    <p className="my-3 text-ink-subtle">Reweight recorded judgments locally. No new AI calls. Missing context or an unresolved payoff requires review regardless of the hook score. These are editorial preferences, not predictions of views.</p>
    <div className="grid gap-3 sm:grid-cols-5">{scoreNames.map((key) => <label key={key} className="capitalize">{key} · {value[key]}
      <input aria-label={`${key} weight`} type="range" min={0} max={5} step={1} value={value[key]} className="mt-2 block w-full" onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })} />
    </label>)}</div>
    <button type="button" className="mt-3 text-purple-300" onClick={() => onChange({ ...defaultWeights })}>Reset weights</button>
  </details>
}
