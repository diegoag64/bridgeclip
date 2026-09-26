import type { ZernioPlatform } from './zernio'
import type { ClipMediaInfo, TikTokCreatorInfo, TikTokPostOptions, YouTubeVisibility } from './zernio-posts'

/** TikTok clips require review before the scheduler can publish them. */
export const AUTOMATION_PLATFORMS = ['instagram', 'youtube', 'twitter', 'facebook', 'linkedin', 'threads', 'tiktok'] as const satisfies readonly ZernioPlatform[]

export interface AutomationTikTokApproval {
  caption: string
  options: TikTokPostOptions
  reviewedAt: string
  fileStamp: { size: number; mtimeMs: number; ino: number }
}

export interface AutomationTikTokReview {
  reviewId: string
  clipPath: string
  caption: string
  media: ClipMediaInfo
  creators: { info: TikTokCreatorInfo; businessConnection: boolean; handle: string }[]
}

export interface AutomationTikTokReviewUpdate {
  reviewId: string
  caption: string
  options: TikTokPostOptions
  previewConfirmed: boolean
}

export interface AutomationAccount {
  accountId: string
  platform: (typeof AUTOMATION_PLATFORMS)[number]
}

export type AutomationContentStatus = 'queued' | 'posting' | 'posted' | 'needs_review'

export interface GeneratedPlatformMetadata {
  platform: AutomationAccount['platform']
  caption: string
  /** YouTube, or Facebook when the clip is posted as a Reel. */
  title: string | null
  tags: string[]
  categoryId: string | null
  /** Threads only. Optional so older saved metadata remains readable. */
  topicTag?: string | null
}

export interface AutomationSourceContext {
  /** Opaque library identity for non-YouTube sources. */
  videoId?: string
  title: string
  description: string
  channel: string
  /** Canonical YouTube URL only; local paths and signed source URLs are never sent. */
  url: string | null
}

export interface MetadataResearch {
  scope?: 'source'
  reused?: boolean
  researchedAt?: string
  status: 'complete' | 'unavailable' | 'skipped'
  summary: string
  sources: { title: string; url: string }[]
}

export interface MetadataEnhancement {
  id: string
  createdAt: string
  platforms: AutomationAccount['platform'][]
  posts: GeneratedPlatformMetadata[]
  source: AutomationSourceContext | null
  research: MetadataResearch
}

export interface AutomationContent {
  id: string
  /** Original authorized file, retained when a library clip is copied to the bank. */
  sourceClipPath?: string
  /** Changes only after a person reviews an uncertain post and returns the clip to the queue. */
  postingAttemptId?: string
  fileName: string
  title: string
  caption: string
  /** Speech recognized from this exact bank clip; never inferred from its filename. */
  transcript: string | null
  generatedMetadata: GeneratedPlatformMetadata[] | null
  metadataError?: string | null
  sourceContext?: AutomationSourceContext | null
  /** A pending draft holds this clip from posting until applied or discarded. */
  metadataDraft?: MetadataEnhancement | null
  metadataEnhancement?: MetadataEnhancement | null
  /** The exact TikTok caption and choices approved for this clip; absent in older banks. */
  tiktokApproval?: AutomationTikTokApproval | null
  /** Keeps the last reviewed copy when approval is revoked to reopen the editor. */
  tiktokDraftCaption?: string | null
  status: AutomationContentStatus
  addedAt: string
  postedAt: string | null
  postId: string | null
  error: string | null
}

export interface AutomationSourceGroup {
  key: string
  title: string
  contentIds: string[]
}

export interface AutomationBatchResult {
  automations: Automation[]
  completed: number
  skipped: number
  errors: { contentId: string; message: string }[]
}

export interface Automation {
  sourceResearch?: { key: string; createdAt: string; source: AutomationSourceContext; research: MetadataResearch }[]
  id: string
  name: string
  enabled: boolean
  /** Exactly one Zernio profile owns this automation's selected accounts. */
  profileId: string | null
  /** Automations start with manual captions; AI metadata is opt-in. */
  metadataMode: 'ai' | 'manual'
  accounts: AutomationAccount[]
  /** Daily times in the configured IANA time zone, as HH:mm. */
  times: string[]
  timezone: string
  youtubeVisibility: YouTubeVisibility
  youtubeMadeForKids: boolean
  /** Time -> most recent local YYYY-MM-DD that was attempted. */
  lastSlots: Record<string, string>
  content: AutomationContent[]
  createdAt: string
  lastRunAt: string | null
  lastError: string | null
}

export interface AutomationUpdate {
  name: string
  enabled: boolean
  profileId: string | null
  metadataMode: 'ai' | 'manual'
  accounts: AutomationAccount[]
  times: string[]
  timezone: string
  youtubeVisibility: YouTubeVisibility
  youtubeMadeForKids: boolean
}

export function needsTikTokReview(automation: Pick<Automation, 'accounts'>, item: AutomationContent): boolean {
  const targets = automation.accounts.filter((account) => account.platform === 'tiktok')
  return targets.length > 0 && (!item.tiktokApproval?.options.consent ||
    targets.some((target) => !item.tiktokApproval?.options.accounts[target.accountId]?.privacyLevel))
}

export function nextAutomationContent(automation: Pick<Automation, 'accounts' | 'content'>): AutomationContent | undefined {
  return automation.content.find((item) => item.status === 'queued' && !needsTikTokReview(automation, item))
}

export function canReorderContent(item: AutomationContent): boolean {
  return item.status === 'queued' && !item.postId
}

export function hasEnhancedMetadata(item: AutomationContent, platforms: readonly AutomationAccount['platform'][]): boolean {
  return Boolean(item.metadataEnhancement && platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform)))
}

/** Reorder only queued slots. Submitted and uncertain items retain their positions. */
export function reorderQueuedContent(content: AutomationContent[], id: string, beforeId: string | null): AutomationContent[] {
  const queue = content.filter(canReorderContent)
  const from = queue.findIndex((item) => item.id === id)
  if (from < 0 || (beforeId !== null && !queue.some((item) => item.id === beforeId))) throw new Error('Only unposted queued clips can be reordered. Refresh the queue and try again.')
  if (id === beforeId) return content
  const [item] = queue.splice(from, 1)
  queue.splice(beforeId === null ? queue.length : queue.findIndex((entry) => entry.id === beforeId), 0, item)
  let index = 0
  return content.map((entry) => canReorderContent(entry) ? queue[index++] : entry)
}

/** Return due local slots, including a short grace period after wake/reopen. */
export function dueSlots(times: readonly string[], timezone: string, now: number, graceMinutes = 5): { time: string; date: string }[] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  })
  const wanted = new Set(times)
  const found = new Set<string>()
  const slots: { time: string; date: string }[] = []
  for (let minutesAgo = graceMinutes - 1; minutesAgo >= 0; minutesAgo--) {
    const parts = Object.fromEntries(formatter.formatToParts(now - minutesAgo * 60_000).map((part) => [part.type, part.value]))
    const time = `${parts.hour}:${parts.minute}`
    const date = `${parts.year}-${parts.month}-${parts.day}`
    const key = `${date}/${time}`
    if (wanted.has(time) && !found.has(key)) { found.add(key); slots.push({ time, date }) }
  }
  return slots
}
