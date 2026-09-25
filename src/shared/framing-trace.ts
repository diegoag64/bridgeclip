/** Version 1 is an immutable record of decisions, never a recipe to rerun AI. */
import { parseEditorialTrace, type EditorialTrace } from './editorial'
export type Rect = [number, number, number, number]
export type Point = [number, number, number]
export interface TraceShot {
  start_ms: number; end_ms: number; layout: string; source: string
  detected_layout: string | null; cam_box: Rect | null; cam_face: Rect | null
  screen_box: Rect | null; screen_focus: Rect | null; content_box: Rect | null; people: Rect[]
  cam_box_refined: boolean
  focus_path: Point[]; crop_path: Point[]
  views: { source: Rect; destination: Rect }[]
}
export interface TraceSample {
  t_ms: number; faces: { box: Rect; score: number | null }[]
  evidence: string | null; histogram_distance: number | null
  content_box: Rect | null
}
export interface TraceDecision {
  start_ms: number; end_ms: number; heuristic: TraceShot
  tracks: { id: number; selected: boolean; samples: [number, number][] }[]
  vision: { status: string; t_ms: number | null; source_ms: number | null; model: string | null
    cache_hit: boolean | null; cache_id: string | null; cache_source_ms: number | null; validated: TraceShot | null }
}
export interface VideoPiece {
  shot: number; source_start_ms: number; source_end_ms: number; output_start_ms: number; output_end_ms: number
}
export interface FramingTrace {
  editorial?: EditorialTrace | null
  version: 1; clip_index: number
  source: { width: number; height: number; duration_ms: number; preview_status: string }
  window: { start_ms: number; duration_ms: number; requested_start_ms: number; requested_end_ms: number }
  output: { width: number; height: number; duration_ms: number; fps: number; video_speed?: number }
  sample_fps: number; thresholds: Record<string, number>
  config: { style: string; pacing: string; vision_enabled: boolean; vision_model: string; detector: string; analysis_width: number }
  analysis_status: string; samples: TraceSample[]
  boundaries: { t_ms: number; kind: string; accepted: boolean; from_layout: string | null; to_layout: string | null
    distance: number | null; hold_ms: number | null; samples: number | null }[]
  decisions: TraceDecision[]; attempted_plan: TraceShot[]; rendered_plan: TraceShot[]
  attempts: { fallback: string | null; status: string; failure: string | null }[]
  keeps: [number, number][]; planner_skips: [number, number][]; video_pieces: VideoPiece[]
}
export interface FramingInspection {
  status: 'available' | 'limited' | 'unavailable'; message: string | null
  trace: FramingTrace | null; sourcePath: string | null; clipPath: string | null
}

const layouts = ['talking_head', 'two_shot', 'screen_cam', 'screen']
const maxTime = 24 * 60 * 60 * 1000
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid framing record')
  return v as Record<string, unknown>
}
function number(v: unknown, max = maxTime): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error('Invalid framing number')
  return v
}
function integer(v: unknown, max = 20000): number {
  const n = number(v, max); if (!Number.isSafeInteger(n)) throw new Error('Invalid framing integer'); return n
}
function text(v: unknown, max = 160): string {
  if (typeof v !== 'string' || v.length > max || [...v].some((c) => c.charCodeAt(0) < 32)) throw new Error('Invalid framing label')
  return v
}
function oneOf(v: unknown, options: string[]): string {
  const s = text(v); if (!options.includes(s)) throw new Error('Invalid framing choice'); return s
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Invalid framing flag'); return v
}
function array<T>(v: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw new Error('Invalid framing list')
  return v.map(parse)
}
function rect(v: unknown, normalized = false): Rect {
  const r = array(v, 4, (n) => number(n, normalized ? 1 : 32768))
  if (r.length !== 4 || (normalized && (r[0] + r[2] > 1.001 || r[1] + r[3] > 1.001))) throw new Error('Invalid framing box')
  return r as Rect
}
function optional<T>(v: unknown, parse: (v: unknown) => T): T | null { return v == null ? null : parse(v) }
function interval(v: unknown): [number, number] {
  const a = array(v, 2, (n) => number(n))
  if (a.length !== 2 || a[0] >= a[1]) throw new Error('Invalid framing interval')
  return a as [number, number]
}
function points(v: unknown, normalized: boolean): Point[] {
  return array(v ?? [], 100, (p) => {
    const row = array(p, 3, (n) => number(n)); if (row.length !== 3 || row[1] > (normalized ? 1 : 32768) || row[2] > (normalized ? 1 : 32768)) throw new Error('Invalid crop path')
    return row as Point
  })
}
function shot(v: unknown): TraceShot {
  const s = object(v); const start = number(s.start_ms); const end = number(s.end_ms)
  if (end < start) throw new Error('Invalid framing segment')
  return { start_ms: start, end_ms: end, layout: oneOf(s.layout, layouts), source: oneOf(s.source, ['heuristic', 'vision', 'style', 'fallback']),
    cam_box_refined: s.cam_box_refined == null ? false : bool(s.cam_box_refined),
    detected_layout: optional(s.detected_layout, (x) => oneOf(x, layouts)),
    ...Object.fromEntries(['cam_box', 'cam_face', 'screen_box', 'screen_focus', 'content_box'].map((k) => [k, optional(s[k], (x) => rect(x, true))])) as Pick<TraceShot, 'cam_box' | 'cam_face' | 'screen_box' | 'screen_focus' | 'content_box'>,
    people: array(s.people ?? [], 32, (b) => rect(b, true)), focus_path: points(s.focus_path, true), crop_path: points(s.crop_path, false),
    views: array(s.views ?? [], 8, (v) => { const view = object(v); return { source: rect(view.source), destination: rect(view.destination) } }) }
}

/** Strict bounds and allowlisted output: extra persisted fields never cross IPC. */
export function parseFramingTrace(value: unknown): FramingTrace {
  const v = object(value)
  if (v.version !== 1) throw new Error('Unsupported framing trace version')
  const source = object(v.source), win = object(v.window), output = object(v.output), config = object(v.config)
  const result: FramingTrace = {
    editorial: parseEditorialTrace(v.editorial),
    version: 1, clip_index: integer(v.clip_index, 999),
    source: { width: number(source.width, 32768), height: number(source.height, 32768), duration_ms: number(source.duration_ms), preview_status: oneOf(source.preview_status, ['available', 'failed']) },
    window: { start_ms: number(win.start_ms), duration_ms: number(win.duration_ms, 3600000), requested_start_ms: number(win.requested_start_ms), requested_end_ms: number(win.requested_end_ms) },
    output: { width: number(output.width, 32768), height: number(output.height, 32768), duration_ms: number(output.duration_ms), fps: number(output.fps, 240), video_speed: output.video_speed == null ? 1 : number(output.video_speed, 2) },
    sample_fps: number(v.sample_fps, 60), thresholds: {},
    config: { style: oneOf(config.style, ['auto', 'fit', 'fill']), pacing: oneOf(config.pacing, ['natural', 'tight']), vision_enabled: bool(config.vision_enabled),
      vision_model: text(config.vision_model), detector: text(config.detector), analysis_width: number(config.analysis_width, 32768) },
    analysis_status: oneOf(v.analysis_status, ['recorded', 'unavailable']),
    samples: array(v.samples, 14401, (x) => { const s = object(x); return { t_ms: number(s.t_ms), evidence: optional(s.evidence, (e) => oneOf(e, layouts)), histogram_distance: optional(s.histogram_distance, (n) => number(n, 1.001)),
      content_box: optional(s.content_box, (b) => rect(b, true)),
      faces: array(s.faces, 32, (f) => { const face = object(f); return { box: rect(face.box, true), score: optional(face.score, (n) => number(n, 1)) } }) } }),
    boundaries: array(v.boundaries, 30000, (x) => { const b = object(x); return { t_ms: number(b.t_ms), kind: oneOf(b.kind, ['scene', 'layout', 'content']), accepted: bool(b.accepted),
      from_layout: optional(b.from_layout, (s) => oneOf(s, layouts)), to_layout: optional(b.to_layout, (s) => oneOf(s, layouts)),
      distance: optional(b.distance, (n) => number(n, 1.001)), hold_ms: optional(b.hold_ms, (n) => number(n)), samples: optional(b.samples, (n) => integer(n)) } }),
    decisions: array(v.decisions, 14401, (x) => {
      const d = object(x), ai = object(d.vision)
      return { start_ms: number(d.start_ms), end_ms: number(d.end_ms), heuristic: shot(d.heuristic),
        tracks: array(d.tracks, 32768, (t) => { const track = object(t); return { id: integer(track.id, 32768), selected: bool(track.selected), samples: array(track.samples, 14401, (p) => {
          const point = array(p, 2, (n) => number(n)); if (point.length !== 2 || point[1] > 31 || !Number.isInteger(point[1])) throw new Error('Invalid face association'); return point as [number, number]
        }) } }),
        vision: { status: oneOf(ai.status, ['disabled', 'unavailable', 'no_image', 'success', 'failed', 'content_region']), t_ms: optional(ai.t_ms, (n) => number(n)), source_ms: optional(ai.source_ms, (n) => number(n)),
          model: optional(ai.model, text), cache_hit: optional(ai.cache_hit, bool), cache_id: optional(ai.cache_id, (s) => { const id = text(s, 16); if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid cache id'); return id }),
          cache_source_ms: optional(ai.cache_source_ms, (n) => number(n)), validated: optional(ai.validated, shot) } }
    }),
    attempted_plan: array(v.attempted_plan, 14401, shot), rendered_plan: array(v.rendered_plan, 14401, shot),
    attempts: array(v.attempts, 3, (x) => { const a = object(x); return { fallback: optional(a.fallback, (s) => oneOf(s, ['letterbox', 'letterbox_natural'])), status: oneOf(a.status, ['failed', 'rendered']), failure: optional(a.failure, (s) => oneOf(s, ['render_failed'])) } }),
    keeps: array(v.keeps, 20000, interval), planner_skips: array(v.planner_skips, 20000, interval),
    video_pieces: array(v.video_pieces, 40000, (x) => { const p = object(x); return { shot: integer(p.shot), source_start_ms: number(p.source_start_ms), source_end_ms: number(p.source_end_ms), output_start_ms: number(p.output_start_ms), output_end_ms: number(p.output_end_ms) } })
  }
  for (const key of ['FACE_SCORE_THRESHOLD', 'SHOT_CUT_THRESHOLD', 'MIN_SHOT_MS', 'LAYOUT_CHANGE_MS', 'LAYOUT_CHANGE_SAMPLES', 'MIN_TRACK_PRESENCE', 'OVERLAY_MAX_FACE_HEIGHT', 'MIN_FACE_HEIGHT']) {
    result.thresholds[key] = number(object(v.thresholds)[key])
  }
  for (const key of ['STRONG_FACE_SCORE', 'COMPETING_FACE_SCORE']) {
    const value = object(v.thresholds)[key]
    if (value != null) result.thresholds[key] = number(value, 1)
  }
  if (!result.source.width || !result.source.height || !result.window.duration_ms || !result.output.fps || !result.sample_fps || !result.output.width || !result.output.height) throw new Error('Empty framing geometry')
  if ((result.output.video_speed ?? 1) < 1) throw new Error('Invalid framing speed')
  let last = -1
  for (const sample of result.samples) {
    if (sample.t_ms <= last || sample.t_ms >= result.window.duration_ms + 250) throw new Error('Unordered framing samples')
    last = sample.t_ms
  }
  for (const plan of [result.attempted_plan, result.rendered_plan]) {
    last = 0
    for (const s of plan) {
      if (s.start_ms !== last || s.end_ms <= s.start_ms) throw new Error('Discontinuous framing plan')
      last = s.end_ms
      for (const path of [s.focus_path, s.crop_path]) {
        let previous = -1
        for (const [t] of path) {
          if (t <= previous || t > result.window.duration_ms) throw new Error('Invalid crop keyframe time')
          previous = t
        }
      }
      for (const view of s.views) {
        for (const [box, w, h] of [[view.source, result.source.width, result.source.height], [view.destination, result.output.width, result.output.height]] as [Rect, number, number][]) {
          if (!box[2] || !box[3] || box[0] + box[2] > w + 2 || box[1] + box[3] > h + 2) throw new Error('Crop outside frame')
        }
      }
    }
    if (last !== result.window.duration_ms) throw new Error('Incomplete framing plan')
  }
  const samples = new Map(result.samples.map((s) => [s.t_ms, s]))
  for (const d of result.decisions) {
    if (d.start_ms >= d.end_ms || d.end_ms > result.window.duration_ms) throw new Error('Invalid decision interval')
    if (d.vision.t_ms != null && (d.vision.t_ms < d.start_ms || d.vision.t_ms >= d.end_ms || d.vision.source_ms !== result.window.start_ms + d.vision.t_ms)) throw new Error('AI image outside decision')
    for (const track of d.tracks) {
      let previous = -1
      for (const [t, index] of track.samples) {
        if (t <= previous || t < d.start_ms || t >= d.end_ms || !samples.get(t)?.faces[index]) throw new Error('Invalid face association')
        previous = t
      }
    }
  }
  if (result.boundaries.some((b) => b.t_ms >= result.window.duration_ms) || result.planner_skips.some(([, end]) => end > result.window.duration_ms)) throw new Error('Event outside window')
  last = 0
  for (const [start, end] of result.keeps) { if (start < last || end > result.window.duration_ms) throw new Error('Invalid keep mapping'); last = end }
  last = 0
  let sourceEnd = 0
  for (const p of result.video_pieces) {
    if (p.shot >= result.rendered_plan.length || Math.abs(p.output_start_ms - last) > .01 || p.source_start_ms < sourceEnd - .01 || p.source_end_ms <= p.source_start_ms || p.output_end_ms <= p.output_start_ms || Math.abs((p.source_end_ms - p.source_start_ms) / (result.output.video_speed ?? 1) - (p.output_end_ms - p.output_start_ms)) > .01 || p.source_end_ms > result.window.duration_ms + 1000 / result.output.fps) throw new Error('Invalid video mapping')
    last = p.output_end_ms; sourceEnd = p.source_end_ms
  }
  if (Math.abs(last - result.output.duration_ms) > 1000 / result.output.fps + .01) throw new Error('Incomplete video mapping')
  return result
}

/** All UI positions are absolute source time. Cut instants explicitly map to null. */
export function sourceToOutput(trace: FramingTrace, sourceMs: number): number | null {
  const t = sourceMs - trace.window.start_ms
  const p = trace.video_pieces.find((p) => p.source_start_ms <= t && t < p.source_end_ms)
  return p ? p.output_start_ms + (t - p.source_start_ms) / (trace.output.video_speed ?? 1) : null
}
export function outputToSource(trace: FramingTrace, outputMs: number): number | null {
  const p = trace.video_pieces.find((p) => p.output_start_ms <= outputMs && outputMs < p.output_end_ms)
  return p ? trace.window.start_ms + p.source_start_ms + (outputMs - p.output_start_ms) * (trace.output.video_speed ?? 1) : null
}
export function cropViews(shot: TraceShot, windowMs: number): Rect[] {
  const views = shot.views.map((v) => [...v.source] as Rect)
  const path = shot.crop_path
  if (path.length && views.length) {
    let left = path[0], right = path[0]
    for (const p of path) { right = p; if (p[0] >= windowMs) break; left = p }
    const f = right[0] > left[0] ? Math.max(0, Math.min(1, (windowMs - left[0]) / (right[0] - left[0]))) : 0
    views[0][0] = left[1] + (right[1] - left[1]) * f
    views[0][1] = left[2] + (right[2] - left[2]) * f
  }
  return views
}
