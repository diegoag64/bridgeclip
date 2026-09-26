/** Persisted source-time edits. Media paths and review results are main-process owned. */
export type Crop = [number, number, number, number]
export type CropCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type EditorRange = [number, number]
export interface EditorScene {
  at_ms: number; layout: 'fill' | 'split' | 'fit'; crops: Crop[]
  /** Incoming eased movement, in source milliseconds. Absent/zero is a cut. */
  transition_ms?: number
}
export interface EditorQuestion {
  id: string; prompt: string; yes: string; no: string; probability: number | null; threshold: number; status: string
}
export interface EditorReview {
  signature: string; reviewed_at: string; decision: string; questions: EditorQuestion[]
  cuts: { interval: EditorRange; questions: EditorQuestion[] }[]
}
export interface CandidateEdit {
  id: string; title: string; ranges: EditorRange[]; scenes: EditorScene[]
  captions: boolean; caption_preset: string; video_speed: number
  status: 'refining' | 'ready' | 'baked' | 'discarded'
  caption_edits: { segment: number; text: string }[]
}
export interface EditorCandidate extends CandidateEdit {
  requires_visual_context?: boolean; score: number; reason: string; review: EditorReview | null; exports: number[]
}
export interface EditorProject {
  version: 1; revision: number; title: string; duration_ms: number; width: number; height: number
  aspect_ratio: '9:16' | '16:9'; candidates: EditorCandidate[]
  transcript: { start_ms: number; end_ms: number; text: string }[]
}
export interface EditorSession { project: EditorProject; sourcePath: string; previewPath: string; operation?: 'save' | 'review' | 'export' | null }

export function editorProgress(candidates: Pick<CandidateEdit, 'status'>[]): { remaining: number; initialCandidate: number } {
  const unfinished = (c: Pick<CandidateEdit, 'status'>): boolean => c.status !== 'baked' && c.status !== 'discarded'
  const first = candidates.findIndex(unfinished)
  return { remaining: candidates.filter(unfinished).length,
    initialCandidate: Math.max(0, first >= 0 ? first : candidates.findIndex((c) => c.status === 'baked')) }
}

const fail = (): never => { throw new Error('Invalid editor project') }
const record = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail()
const num = (x: unknown, lo: number, hi: number): number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : fail()
const str = (x: unknown, max: number): string => typeof x === 'string' && x.length <= max ? x : fail()
const arr = (x: unknown, max: number): unknown[] => Array.isArray(x) && x.length <= max ? x : fail()
export function parseCandidateEdit(value: unknown, duration: number, transcriptCount = 100000): CandidateEdit {
  const v = record(value)
  const ranges = arr(v.ranges, 24).map((r) => {
    const a = arr(r, 2); if (a.length !== 2) fail()
    return [Math.round(num(a[0], 0, duration)), Math.round(num(a[1], 0, duration))] as EditorRange
  })
  if (!ranges.length || ranges.some(([a, b], i) => b - a < 100 || (i > 0 && a < ranges[i - 1][1]))) fail()
  const scenes = arr(v.scenes, 60).map((s): EditorScene => {
    const x = record(s)
    if (!['fill', 'split', 'fit'].includes(x.layout as string)) fail()
    const crops = arr(x.crops, 2).map((r): Crop => {
      const c = arr(r, 4).map((n) => num(n, 0, 1))
      if (c.length !== 4 || c[2] < .01 || c[3] < .01 || c[0] + c[2] > 1.000001 || c[1] + c[3] > 1.000001) fail()
      return c as Crop
    })
    if (crops.length !== (x.layout === 'split' ? 2 : 1)) fail()
    const transition = x.transition_ms === undefined ? 0 : num(x.transition_ms, 0, 5000)
    if (transition > 0 && (transition < 100 || !Number.isInteger(transition))) fail()
    return { at_ms: Math.round(num(x.at_ms, 0, duration)), layout: x.layout as EditorScene['layout'], crops,
      ...(transition ? { transition_ms: transition } : {}) }
  })
  if (!scenes.length || scenes[0].at_ms !== 0 || scenes.some((s, i) => i > 0 && s.at_ms <= scenes[i - 1].at_ms)) fail()
  if (scenes.some((s, i) => s.transition_ms && !canAnimateScene(scenes, i))) fail()
  const id = str(v.id, 64); if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail()
  const title = str(v.title, 200); if (!title.trim()) fail()
  const caption_preset = str(v.caption_preset, 64); if (!/^[a-z0-9_-]+$/i.test(caption_preset)) fail()
  if (typeof v.captions !== 'boolean') fail()
  const status = v.status === undefined ? 'refining' : v.status
  if (!['refining', 'ready', 'baked', 'discarded'].includes(status as string)) fail()
  const seen = new Set<number>()
  const caption_edits = arr(v.caption_edits === undefined ? [] : v.caption_edits, 2000).map((item) => {
    const edit = record(item), segment = num(edit.segment, 0, transcriptCount - 1), text = str(edit.text, 2000)
    if (!Number.isInteger(segment) || seen.has(segment) || [...text].some((char) => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char))) fail()
    seen.add(segment)
    return { segment, text }
  }).sort((a, b) => a.segment - b.segment)
  return { id, title, ranges, scenes, captions: v.captions as boolean, caption_preset, video_speed: num(v.video_speed, 1, 2),
    status: status as CandidateEdit['status'], caption_edits }
}
function question(value: unknown): EditorQuestion {
  const v = record(value)
  return { id: str(v.id, 64), prompt: str(v.prompt, 4000), yes: str(v.yes, 4000), no: str(v.no, 4000),
    probability: v.probability === null ? null : num(v.probability, 0, 1), threshold: num(v.threshold, 0, 1), status: str(v.status, 64) }
}
export function parseEditorProject(value: unknown): EditorProject {
  const v = record(value)
  if (v.version !== 1 || !['9:16', '16:9'].includes(v.aspect_ratio as string)) fail()
  const duration = num(v.duration_ms, 100, 24 * 3600000)
  const transcript = arr(v.transcript, 100000).map((row) => { const t = record(row); return { start_ms: num(t.start_ms, 0, duration), end_ms: num(t.end_ms, 0, duration), text: str(t.text, 20000) } })
  const ids = new Set<string>()
  const candidates = arr(v.candidates, 100).map((item): EditorCandidate => {
    const c = record(item), edit = parseCandidateEdit(c, duration, transcript.length)
    if (ids.has(edit.id)) fail(); ids.add(edit.id)
    let review: EditorReview | null = null
    if (c.review) {
      const r = record(c.review)
      review = { signature: str(r.signature, 200000), reviewed_at: str(r.reviewed_at, 64), decision: str(r.decision, 64),
        questions: arr(r.questions, 32).map(question), cuts: arr(r.cuts, 24).map((cut) => {
          const x = record(cut), t = arr(x.interval, 2)
          if (t.length !== 2) fail()
          return { interval: [num(t[0], 0, duration), num(t[1], 0, duration)], questions: arr(x.questions, 16).map(question) }
        }) }
    }
    return { ...edit, requires_visual_context: c.requires_visual_context === true, score: num(c.score, 0, 100), reason: str(c.reason, 4000), review,
      exports: arr(c.exports, 1000).map((n) => num(n, 0, 999)) }
  })
  if (!candidates.length) fail()
  return { version: 1, revision: num(v.revision, 0, Number.MAX_SAFE_INTEGER), title: str(v.title, 1024), duration_ms: duration,
    width: num(v.width, 2, 16384), height: num(v.height, 2, 16384), aspect_ratio: v.aspect_ratio as EditorProject['aspect_ratio'], candidates,
    transcript }
}
export function candidateEdit(c: CandidateEdit): CandidateEdit {
  const { id, title, ranges, scenes, captions, caption_preset, video_speed, status, caption_edits } = c
  return { id, title, ranges, scenes, captions, caption_preset, video_speed, status, caption_edits }
}
export function renderEditKey(c: CandidateEdit): string {
  return JSON.stringify({ ...candidateEdit(c), status: undefined })
}
export function refineEdit<T extends CandidateEdit>(c: T, patch: Partial<CandidateEdit>): T {
  const next = { ...c, ...patch }
  if (patch.status === undefined && renderEditKey(c) !== renderEditKey(next)) next.status = 'refining'
  return next
}
export function editSignature(c: CandidateEdit): string {
  // Preserve existing review signatures for projects without motion.
  return JSON.stringify([c.title, c.ranges, c.scenes.map((s) => [s.at_ms, s.layout, s.crops, ...(s.transition_ms ? [s.transition_ms] : [])])])
}
export function sceneAt(c: CandidateEdit, t: number): EditorScene {
  return [...c.scenes].reverse().find((s) => s.at_ms <= t) ?? c.scenes[0]
}
/** Move a layout boundary without reordering scenes or changing their framing. */
export function retimeScene(scenes: EditorScene[], index: number, time: number, duration: number): EditorScene[] {
  if (index <= 0 || index >= scenes.length || !Number.isFinite(time)) return scenes
  const lo = scenes[index - 1].at_ms + 1
  const hi = Math.min(scenes[index + 1]?.at_ms ?? duration, duration) - 1
  if (hi < lo) return scenes
  const at_ms = Math.max(lo, Math.min(hi, Math.round(time)))
  return at_ms === scenes[index].at_ms ? scenes : scenes.map((s, i) => i === index ? { ...s, at_ms } : s)
}
export function canAnimateScene(scenes: EditorScene[], index: number): boolean {
  return index > 0 && scenes[index].layout !== 'fit' && scenes[index - 1].layout === scenes[index].layout
}
export function normalizeSceneTransitions(scenes: EditorScene[]): EditorScene[] {
  return scenes.map((s, i) => canAnimateScene(scenes, i) ? s : { ...s, transition_ms: undefined })
}
/** The same source-time smoothstep and interrupted-motion behavior as export. */
export function framingAt(c: CandidateEdit, t: number): EditorScene {
  let scene = c.scenes[0], from = scene.crops
  const cropsAt = (at: number): Crop[] => {
    const p = scene.transition_ms ? Math.max(0, Math.min(1, (at - scene.at_ms) / scene.transition_ms)) : 1
    const ease = p * p * (3 - 2 * p)
    return scene.crops.map((crop, j) => crop.map((n, k) => from[j][k] + (n - from[j][k]) * ease) as Crop)
  }
  for (let i = 1; i < c.scenes.length && c.scenes[i].at_ms <= t; i++) {
    const next = c.scenes[i]
    from = next.transition_ms && canAnimateScene(c.scenes, i) ? cropsAt(next.at_ms) : next.crops
    scene = next
  }
  return { ...scene, crops: cropsAt(t) }
}
export function trimRange(ranges: EditorRange[], index: number, edge: 0 | 1, time: number, duration: number): EditorRange[] {
  const next = ranges.map((r) => [...r] as EditorRange)
  const lo = edge === 0 ? (index ? ranges[index - 1][1] : 0) : ranges[index][0] + 100
  const hi = edge === 0 ? ranges[index][1] - 100 : (index + 1 < ranges.length ? ranges[index + 1][0] : duration)
  next[index][edge] = Math.max(lo, Math.min(hi, Math.round(time)))
  return next
}
export function defaultCrop(width: number, height: number, aspect: number, cx = .5, cy = .5, zoom = 1): Crop {
  const w = Math.min(1, height * aspect / width) / zoom, h = Math.min(1, width / aspect / height) / zoom
  return [Math.max(0, Math.min(1 - w, cx - w / 2)), Math.max(0, Math.min(1 - h, cy - h / 2)), w, h]
}
/** Resize in screen pixels, preserving proportions and the opposite corner. */
export function resizeCrop(crop: Crop, corner: CropCorner, dx: number, dy: number, frameWidth: number, frameHeight: number): Crop {
  const [x, y, w, h] = crop
  if (![dx, dy, frameWidth, frameHeight].every(Number.isFinite) || frameWidth <= 0 || frameHeight <= 0) return crop
  const sx = corner.endsWith('right') ? 1 : -1, sy = corner.startsWith('bottom') ? 1 : -1
  const ax = x + (sx < 0 ? w : 0), ay = y + (sy < 0 ? h : 0)
  const pixelW = w * frameWidth, pixelH = h * frameHeight
  // Project the pointer onto the corner's diagonal, so either axis can resize.
  const proposed = 1 + (sx * dx * pixelW + sy * dy * pixelH) / (pixelW * pixelW + pixelH * pixelH)
  const maximum = Math.min((sx > 0 ? 1 - ax : ax) / w, (sy > 0 ? 1 - ay : ay) / h)
  // Match the zoom slider's 4× limit, while retaining smaller legacy crops.
  const minimum = Math.max(.01 / w, .01 / h, Math.min(1, Math.min(1 / w, 1 / h) / 4))
  const scale = Math.max(minimum, Math.min(maximum, proposed))
  const nw = Math.max(.01, Math.min(1, w * scale)), nh = Math.max(.01, Math.min(1, h * scale))
  return [Math.max(0, Math.min(1 - nw, sx > 0 ? ax : ax - nw)), Math.max(0, Math.min(1 - nh, sy > 0 ? ay : ay - nh)), nw, nh]
}
export function editDuration(c: CandidateEdit): number { return c.ranges.reduce((n, [a, b]) => n + b - a, 0) / c.video_speed }
