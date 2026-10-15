import type { AutomationAccount, AutomationSourceContext } from './automations'
import type { FacebookFormat, PostRecord } from './zernio-posts'

export interface LibraryClipTarget { outputDir: string; clipIndex: number }

export type LibraryPostingState = 'not_posted' | 'posted' | 'partial' | 'scheduled' | 'publishing' | 'draft' | 'failed'
export interface LibraryClipPostingStatus {
  queuedIn?: { id: string; name: string }[]
  manuallyPosted?: boolean
  clipIndex: number
  state: LibraryPostingState
  platforms: string[]
}
/** Posted and not-posted clip counts for one run; null when the run could not be checked. */
export interface LibraryRunPostingCounts { outputDir: string; counts: { posted: number; notPosted: number; queued: number } | null }
export const MAX_POSTING_SUMMARY_RUNS = 5000
export interface LibraryEnhancementOptions {
  platforms: AutomationAccount['platform'][]
  research: boolean
  source?: AutomationSourceContext | null
  notes?: string
  facebookFormat?: FacebookFormat
}

/** Only fully published, non-inbox posts leave the Not posted group. */
export function clipPostingStatus(clipIndex: number, posts: PostRecord[]): LibraryClipPostingStatus {
  const published = posts.filter((post) => post.status === 'published' && post.targets.length > 0 && post.targets.every((target) => target.status === 'published' && !target.inbox))
  const platforms = [...new Set(posts.flatMap((post) => post.targets.filter((target) => target.status === 'published' && !target.inbox).map((target) => target.platform)))]
  const state: LibraryPostingState = published.length ? 'posted'
    : platforms.length || posts.some((post) => post.status === 'partial') ? 'partial'
    : posts.some((post) => post.status === 'scheduled') ? 'scheduled'
    : posts.some((post) => post.status === 'publishing') ? 'publishing'
    : posts.some((post) => post.status === 'draft' || post.targets.some((target) => target.inbox && target.status === 'published')) ? 'draft'
    : posts.some((post) => post.status === 'failed') ? 'failed' : 'not_posted'
  return { clipIndex, state, platforms }
}

export const LIBRARY_POSTING_LABELS: Record<LibraryPostingState, string> = {
  not_posted: 'Not posted', posted: 'Posted', partial: 'Partially posted', scheduled: 'Scheduled',
  publishing: 'Publishing', draft: 'Draft / inbox', failed: 'Post failed'
}
