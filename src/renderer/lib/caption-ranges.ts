import type { EditorRange } from '../../shared/clip-editor'

/** Find an editable caption-free section in retained footage, preferring the playhead. */
export function nextCaptionRange(ranges: EditorRange[], cuts: EditorRange[], time: number): EditorRange | null {
  if (ranges.length >= 200 || !Number.isFinite(time)) return null
  const gaps: EditorRange[] = []
  for (const [start, end] of cuts) {
    let at = start
    for (const [a, b] of ranges) {
      if (b <= at) continue
      if (a >= end) break
      if (a - at >= 100) gaps.push([at, Math.min(a, end)])
      at = Math.max(at, b)
      if (at >= end) break
    }
    if (end - at >= 100) gaps.push([at, end])
  }
  const playhead = Math.round(time)
  const gap = gaps.find(([a, b]) => b - Math.max(a, playhead) >= 100)
  const available = gap ?? gaps[0]
  if (!available) return null
  const start = gap ? Math.max(gap[0], playhead) : available[0]
  return [start, Math.min(available[1], start + 2000)]
}
