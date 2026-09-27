import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, Pause, Play, RotateCcw } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/Button'

/**
 * Mirrors the caption presets in engine/clip_engine/config.py closely
 * enough to preview them: typeface, colours, stroke, shadow, glow, pill,
 * plate and karaoke sweep. BridgeClip engine renders with its bundled fonts; the preview
 * uses the same bundled faces, with a system fallback while they load.
 */
interface CaptionPreset {
  id: string
  name: string
  description: string
  font: string
  weight: number
  italic?: boolean
  size: number
  primary: string
  highlight: string
  stroke: number
  shadow: 'soft' | 'hard' | 'halo' | 'none'
  uppercase: boolean
  /** Rounded pill behind the active word. */
  pill?: string
  /** Blurred bloom around the active word. */
  glow?: string
  /** Translucent plate behind the whole line. */
  plate?: string
  karaoke?: boolean
  /** How unspoken words look. */
  future?: 'show' | 'dim' | 'hide'
  maxWords?: number
  entrancePop?: boolean
  colorTransition?: boolean
  dimOpacity?: number
  words: [string, string, string]
}

const PRESETS: CaptionPreset[] = [
  {
    id: 'pop',
    name: 'Pop',
    description: 'The all-rounder',
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#FFE234',
    stroke: 6,
    shadow: 'soft',
    uppercase: true,
    words: ['this', 'changed', 'everything']
  },
  {
    id: 'spotlight',
    name: 'Spotlight',
    description: 'Word on a pill',
    font: '"Poppins", "Poppins Black", system-ui, sans-serif',
    weight: 900,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    pill: '#7C5CFF',
    words: ['the', 'real', 'secret']
  },
  {
    id: 'impact',
    name: 'Impact',
    description: 'Tall, two words at a time',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 21,
    primary: '#FFFFFF',
    highlight: '#FFD60A',
    stroke: 7,
    shadow: 'hard',
    uppercase: true,
    future: 'hide',
    maxWords: 2,
    words: ['ten', 'million', 'views']
  },
  {
    id: 'glow',
    name: 'Glow',
    description: 'Cyan bloom, tech & gaming',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#7DF9FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#00C8FF',
    words: ['level', 'up', 'now']
  },
  {
    id: 'boxed',
    name: 'Boxed',
    description: 'Readable on any footage',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFD23F',
    stroke: 0,
    shadow: 'none',
    uppercase: true,
    plate: 'rgb(0 0 0 / 0.62)',
    words: ['ship it', 'faster', 'today']
  },
  {
    id: 'sweep',
    name: 'Sweep',
    description: 'Colour follows the voice',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF5FA2',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    karaoke: true,
    maxWords: 4,
    entrancePop: false,
    words: ['sing', 'along', 'now']
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif for podcasts & stories',
    font: '"Instrument Serif", "Georgia", serif',
    weight: 400,
    italic: true,
    size: 20,
    primary: '#FFFFFF',
    highlight: '#FFE6B8',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    maxWords: 4,
    entrancePop: false,
    dimOpacity: 0.6,
    words: ['and that is', 'why', 'it works']
  },
  {
    id: 'hype',
    colorTransition: true,
    name: 'Hype',
    description: 'Heavy stroke, high energy',
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 16,
    primary: '#FFFFFF',
    highlight: '#39FF6A',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['let’s', 'go', 'now']
  },
  {
    id: 'punch',
    maxWords: 1,
    name: 'Punch',
    description: 'One huge word at a time',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 28,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['', 'boom', '']
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Magenta bloom, music & lifestyle',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF9CEB',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#FF2EC4',
    words: ['feel', 'the', 'beat']
  },
  {
    id: 'headline',
    name: 'Headline',
    description: 'Word on a red news tag',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 4,
    shadow: 'soft',
    uppercase: true,
    pill: '#E5202E',
    words: ['this', 'just', 'in']
  },
  {
    id: 'paper',
    maxWords: 4,
    entrancePop: false,
    name: 'Paper',
    description: 'Dark type on a white card',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#111111',
    highlight: '#6D28D9',
    stroke: 0,
    shadow: 'none',
    uppercase: false,
    plate: 'rgb(255 255 255 / 0.94)',
    words: ['here is', 'how', 'it works']
  },
  {
    id: 'subtle',
    maxWords: 4,
    entrancePop: false,
    colorTransition: true,
    dimOpacity: 0.55,
    name: 'Subtle',
    description: 'Light touch for interviews & vlogs',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#C4F1FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    words: ['I think', 'that’s', 'fair']
  }
]

/** Display names by preset id, for summaries outside the picker. */
export const CAPTION_PRESET_NAMES: Record<string, string> = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset.name]))

/**
 * Preset `size` and `stroke` are tuned for an 84px-tall preview. The compact
 * tile is 60px tall, so samples render at this fraction to keep the same fit.
 */
const SAMPLE_SCALE = 60 / 84

/** Stroke + shadow as stacked text-shadows, scaled to the tile. */
function textShadow(p: CaptionPreset, scale = SAMPLE_SCALE): string {
  const layers: string[] = []
  const w = p.stroke * 0.28 * scale
  if (w > 0) {
    for (let a = 0; a < 16; a++) {
      const r = (a / 16) * Math.PI * 2
      layers.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 #000`)
    }
  }
  if (p.shadow === 'soft') layers.push(`0 ${(w + 1.5).toFixed(2)}px 4px rgb(0 0 0 / 0.6)`)
  if (p.shadow === 'hard') layers.push(`0 ${(w + 2.5).toFixed(2)}px 0 rgb(0 0 0 / 0.9)`)
  if (p.shadow === 'halo') layers.push('0 1px 6px rgb(0 0 0 / 0.85)', '0 0 3px rgb(0 0 0 / 0.6)')
  return layers.join(', ') || 'none'
}

function CaptionSample({ preset }: { preset: CaptionPreset }): React.JSX.Element {
  const [before, active, after] = preset.words
  const base: CSSProperties = {
    color: preset.primary,
    fontFamily: preset.font,
    fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal',
    fontSize: preset.size * SAMPLE_SCALE,
    textShadow: textShadow(preset),
    textTransform: preset.uppercase ? 'uppercase' : 'none'
  }

  let activeWord: React.JSX.Element
  if (preset.karaoke) {
    // Show the sweep mid-word; two spans rather than background-clip:text,
    // which the stroke shadow would paint over.
    const at = Math.ceil(active.length * 0.6)
    activeWord = (
      <span>
        <span style={{ color: preset.highlight }}>{active.slice(0, at)}</span>
        {active.slice(at)}
      </span>
    )
  } else if (preset.pill) {
    activeWord = (
      <span
        style={{ background: preset.pill, color: preset.highlight, textShadow: 'none', borderRadius: 4, padding: '1px 3px' }}
      >
        {active}
      </span>
    )
  } else {
    const bloom = preset.glow ? `, 0 0 4px ${preset.glow}, 0 0 10px ${preset.glow}` : ''
    activeWord = <span style={{ color: preset.highlight, textShadow: `${textShadow(preset)}${bloom}` }}>{active}</span>
  }

  const afterStyle: CSSProperties | undefined =
    preset.future === 'dim' ? { opacity: 0.6 } : preset.future === 'hide' ? { visibility: 'hidden' } : undefined
  // Karaoke: words already swept keep the highlight colour.
  const beforeStyle: CSSProperties | undefined = preset.karaoke ? { color: preset.highlight } : undefined

  const line = (
    <>
      {before && <span style={beforeStyle}>{before} </span>}
      {activeWord}
      {after && <span style={afterStyle}> {after}</span>}
    </>
  )

  return (
    <span className="relative block text-center leading-[1.1]" style={base}>
      {preset.plate ? (
        <span className="inline-block rounded px-1 py-px" style={{ background: preset.plate }}>
          {line}
        </span>
      ) : (
        line
      )}
    </span>
  )
}

/** A stand-in "frame" behind each sample: a flat, dim video-like tone. */
const SCENE = '#14161d'

// One shared sentence makes timing and word grouping easy to compare across styles.
const PREVIEW_WORDS = ['This', 'is', 'how', 'your', 'captions', 'come', 'to', 'life.']
const WORD_MS = 600
const SPEECH_MS = PREVIEW_WORDS.length * WORD_MS
const PREVIEW_MS = SPEECH_MS + 700 + 350 // Match the engine's linger, then clear before looping.

function CaptionMotionPreview({ preset, disabled }: { preset: CaptionPreset; disabled?: boolean }): React.JSX.Element {
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [playing, setPlaying] = useState(!reducedMotion)
  const [time, setTime] = useState(0)
  const elapsed = useRef(0)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => {
      setReducedMotion(media.matches)
      if (media.matches) setPlaying(false)
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!playing || disabled) return
    let frame = 0
    let previous = performance.now()
    const tick = (now: number): void => {
      if (!document.hidden) {
        elapsed.current = (elapsed.current + Math.min(now - previous, 100)) % PREVIEW_MS
        setTime(elapsed.current)
      }
      previous = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, disabled])

  const seek = (ms: number): void => { elapsed.current = ms; setTime(ms) }
  const active = Math.min(Math.floor(time / WORD_MS), PREVIEW_WORDS.length - 1)
  const groupSize = preset.maxWords ?? 3
  const groupStart = Math.floor(active / groupSize) * groupSize
  const groupTime = time - groupStart * WORD_MS
  const wordProgress = Math.min(1, (time - active * WORD_MS) / WORD_MS)
  const scale = !reducedMotion && preset.entrancePop !== false && groupTime < 170
    ? groupTime < 90 ? 0.82 + 0.24 * groupTime / 90 : 1.06 - 0.06 * (groupTime - 90) / 80
    : 1
  const shadow = textShadow(preset, 1.2)
  const base: CSSProperties = {
    color: preset.primary, fontFamily: preset.font, fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal', fontSize: preset.size * 1.65,
    textShadow: shadow, textTransform: preset.uppercase ? 'uppercase' : 'none',
    transform: `scale(${scale})`, visibility: time >= SPEECH_MS + 700 ? 'hidden' : undefined
  }

  return (
    <section aria-label="Caption preview" className="mb-3 overflow-hidden rounded-xl border border-white/[0.08]" style={{ background: SCENE }}>
      <div className="flex items-center justify-between gap-2 px-3 pt-3 text-xs">
        <span className="font-semibold text-ink">{preset.name} preview</span>
        <span className="text-2xs text-ink-subtle">Sample timing · No audio</span>
      </div>
      <div aria-hidden="true" className="flex h-32 items-center justify-center overflow-hidden px-4">
        <div className="text-center leading-snug" style={base}>
          <span className="inline-flex flex-wrap justify-center gap-x-[0.3em] rounded-md px-2 py-1" style={{ background: preset.plate }}>
            {PREVIEW_WORDS.slice(groupStart, groupStart + groupSize).map((word, offset) => {
              const index = groupStart + offset
              const state = index === active ? 'active' : index < active ? 'past' : 'future'
              const style: CSSProperties = {
                visibility: state === 'future' && preset.future === 'hide' ? 'hidden' : undefined,
                opacity: state === 'future' && preset.future === 'dim' ? preset.dimOpacity ?? 0.6 : 1,
                // Reserve pill padding on every word so the line stays put as it advances.
                padding: preset.pill ? '1px 5px' : undefined,
                borderRadius: 5
              }
              if (preset.karaoke) {
                if (state === 'past') style.color = preset.highlight
              } else if (state === 'active') {
                style.color = preset.colorTransition
                  ? `color-mix(in srgb, ${preset.highlight} ${Math.min(1, wordProgress / 0.3) * 100}%, ${preset.primary})`
                  : preset.highlight
                if (preset.pill) { style.background = preset.pill; style.textShadow = 'none' }
                if (preset.glow) style.textShadow = `${shadow}, 0 0 8px ${preset.glow}, 0 0 18px ${preset.glow}`
              }
              return (
                <span key={index} data-caption-state={state} className="relative inline-block whitespace-nowrap" style={style}>
                  {word}
                  {preset.karaoke && state === 'active' && (
                    <span className="absolute inset-0" style={{ color: preset.highlight, textShadow: 'none', clipPath: `inset(0 ${(1 - wordProgress) * 100}% 0 0)` }}>{word}</span>
                  )}
                </span>
              )
            })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-2 py-2">
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={playing && !disabled ? 'Pause caption preview' : 'Play caption preview'} icon={playing && !disabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} onClick={() => setPlaying((value) => !value)} />
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label="Replay caption preview" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { seek(0); setPlaying(true) }} />
        <input type="range" aria-label="Caption preview position" aria-valuetext={`${(time / 1000).toFixed(1)} seconds`} min={0} max={PREVIEW_MS} step={100} value={time} disabled={disabled} className="min-w-0 flex-1 accent-accent" onChange={(event) => { setPlaying(false); seek(Number(event.target.value)) }} />
        <span aria-hidden="true" className="w-16 text-right text-2xs tabular-nums text-ink-subtle">{(time / 1000).toFixed(1)} / {(PREVIEW_MS / 1000).toFixed(1)}s</span>
      </div>
    </section>
  )
}

interface CaptionPresetPickerProps {
  value: string
  onChange: (preset: string) => void
  disabled?: boolean
  showPreview?: boolean
}

export function CaptionPresetPicker({ value, onChange, disabled, showPreview = false }: CaptionPresetPickerProps): React.JSX.Element {
  const current = PRESETS.find((preset) => preset.id === value) ?? PRESETS[0]
  return (
    <div>
      {showPreview && <CaptionMotionPreview key={current.id} preset={current} disabled={disabled} />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2" role="radiogroup" aria-label="Caption style">
        {PRESETS.map((preset) => {
          const selected = value === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preset.name}
              aria-description={preset.description}
              title={preset.description}
              disabled={disabled}
              onClick={() => onChange(preset.id)}
              className={cn(
                'glass-tile glass-tile-hover group relative rounded-xl p-1 text-left hover:-translate-y-0.5',
                selected && 'glass-selected',
                disabled && 'opacity-50'
              )}
            >
              <span
                className="relative flex h-[60px] items-end justify-center overflow-hidden rounded-lg px-1.5 pb-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
                style={{ background: SCENE }}
              >
                <CaptionSample preset={preset} />
                {selected && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_0_0_1px_rgb(var(--accent)/0.6)] animate-pop-in">
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                )}
              </span>
              <span className={cn('block truncate px-1.5 pb-0.5 pt-1.5 text-xs font-semibold', selected ? 'text-ink' : 'text-ink/90')}>
                {preset.name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
