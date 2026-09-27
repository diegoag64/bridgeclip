// Posting clips through the user's own Zernio workspace. Shared by the main
// process (authoritative checks, payloads) and the renderer (inline hints).
//
// Limits come from docs.zernio.com and https://zernio.com/openapi.yaml
// (API 1.62, checked September 2026). Each platform page lists them under
// "Quick reference" and "Media requirements".

import type { ZernioPlatform } from './zernio'

/** What ffprobe reports about a clip. Null fields mean "unknown", never "zero". */
export interface ClipMediaInfo {
  durationMs: number | null
  width: number | null
  height: number | null
  sizeBytes: number
}

export interface PlatformRules {
  captionMax: number
  /** False when some accounts may go past `captionMax` (X Premium), so going over only warns. */
  captionStrict: boolean
  minSec: number
  maxSec: number | null
  maxBytes: number | null
}

const MB = 1024 * 1024
/** POST /v1/media/presign accepts files up to 5 GB. */
export const PRESIGN_MAX_BYTES = 5 * 1024 * MB

export const PLATFORM_RULES: Record<ZernioPlatform, PlatformRules> = {
  // 3 s to 10 min; creator info can lower the maximum per account.
  tiktok: { captionMax: 2200, captionStrict: true, minSec: 3, maxSec: 600, maxBytes: 4096 * MB },
  // Description limit; the title (100) is separate. 15 min for unverified channels, 12 h verified.
  youtube: { captionMax: 5000, captionStrict: true, minSec: 1, maxSec: 12 * 3600, maxBytes: null },
  // A single video is always a Reel through the API: 3 to 90 seconds.
  instagram: { captionMax: 2200, captionStrict: true, minSec: 3, maxSec: 90, maxBytes: null },
  // Feed video up to 240 min. Reels are checked separately (FACEBOOK_REEL).
  facebook: { captionMax: 63206, captionStrict: true, minSec: 1, maxSec: 240 * 60, maxBytes: 4096 * MB },
  // X sets the duration cap per account; Zernio enforces only 512 MB. 25,000 characters with Premium.
  twitter: { captionMax: 280, captionStrict: false, minSec: 0.5, maxSec: null, maxBytes: 512 * MB },
  // 10 min on personal profiles, 30 min on organization pages.
  linkedin: { captionMax: 3000, captionStrict: true, minSec: 3, maxSec: 30 * 60, maxBytes: 5120 * MB },
  threads: { captionMax: 500, captionStrict: true, minSec: 0, maxSec: 5 * 60, maxBytes: 1024 * MB }
}

/** Facebook Reels: a single vertical video lasting 3–60 seconds. */
export const FACEBOOK_REEL = { minSec: 3, maxSec: 60 }
/** YouTube classifies a vertical video of 3 minutes or less as a Short. */
export const YOUTUBE_SHORT_MAX_SEC = 180
export const YOUTUBE_UNVERIFIED_MAX_SEC = 15 * 60
export const YOUTUBE_TITLE_MAX = 100
export const LINKEDIN_PERSONAL_MAX_SEC = 10 * 60

// ---- Scheduling -------------------------------------------------------------

/** Scheduled posts must be at least this far ahead when the user picks the time. */
export const SCHEDULE_MIN_LEAD_MS = 5 * 60_000
/** Zernio deletes an upload after 7 days unless a post using it has published. */
export const UPLOAD_RETENTION_MS = 7 * 86_400_000
/** Room for clock skew and platform queues (e.g. TikTok holding a post past its daily cap). */
export const SCHEDULE_SAFETY_MARGIN_MS = 12 * 3_600_000

export function scheduleWindow(now: number, uploadedAt: number = now): { min: number; max: number } {
  return { min: now + SCHEDULE_MIN_LEAD_MS, max: uploadedAt + UPLOAD_RETENTION_MS - SCHEDULE_SAFETY_MARGIN_MS }
}

/**
 * Null when `at` is an acceptable publish time. `graceMs` relaxes the lower
 * bound for checks that run after the user picked the time (dialog open,
 * upload in progress).
 */
export function scheduleError(at: number, now: number, uploadedAt: number = now, graceMs = 0): string | null {
  if (!Number.isFinite(at)) return 'Choose a date and time.'
  const { min, max } = scheduleWindow(now, uploadedAt)
  if (at < min - graceMs) return 'Pick a time at least 5 minutes from now.'
  if (at > max) {
    return uploadedAt < now
      ? 'Zernio keeps this upload for 7 days, so pick an earlier time or post the clip again.'
      : 'Zernio keeps uploads for 7 days, so schedule at most 6½ days ahead.'
  }
  return null
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// ---- Clip checks ------------------------------------------------------------

export function formatClipDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function platformLabel(platform: ZernioPlatform): string {
  return { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', twitter: 'X', linkedin: 'LinkedIn', threads: 'Threads' }[platform]
}

export function isVertical(media: Pick<ClipMediaInfo, 'width' | 'height'>): boolean | null {
  return media.width && media.height ? media.height > media.width : null
}

export interface ClipCheckContext {
  /** From TikTok creator info; lowers TikTok's maximum for this account. */
  tiktokMaxSec?: number | null
  facebookFormat?: FacebookFormat
}

export interface ClipCheck {
  /** Why this platform can't take the clip; null when it can. */
  blocking: string | null
  notes: string[]
}

/** Whether `platform` accepts this clip, and anything the user should know first. */
export function checkClip(platform: ZernioPlatform, media: ClipMediaInfo, context: ClipCheckContext = {}): ClipCheck {
  const rules = PLATFORM_RULES[platform]
  const name = platformLabel(platform)
  const seconds = media.durationMs == null ? null : media.durationMs / 1000
  const vertical = isVertical(media)
  const notes: string[] = []

  let maxSec = rules.maxSec
  if (platform === 'tiktok' && context.tiktokMaxSec && context.tiktokMaxSec > 0) maxSec = Math.min(maxSec ?? Infinity, context.tiktokMaxSec)
  let minSec = rules.minSec
  if (platform === 'facebook' && context.facebookFormat === 'reel') {
    minSec = FACEBOOK_REEL.minSec
    maxSec = FACEBOOK_REEL.maxSec
    if (vertical === false) return { blocking: 'Facebook Reels need a vertical video. Post it to the feed instead.', notes }
  }

  if (media.sizeBytes > PRESIGN_MAX_BYTES) return { blocking: 'Zernio accepts uploads up to 5 GB.', notes }
  if (rules.maxBytes != null && media.sizeBytes > rules.maxBytes) {
    const size = rules.maxBytes >= 1024 * MB ? `${rules.maxBytes / (1024 * MB)} GB` : `${rules.maxBytes / MB} MB`
    return { blocking: `${name} accepts videos up to ${size}.`, notes }
  }
  if (seconds != null) {
    if (seconds < minSec) return { blocking: `${name} needs clips of at least ${minSec} seconds.`, notes }
    if (maxSec != null && seconds > maxSec + 0.5) {
      const what = platform === 'instagram' ? 'Instagram Reels' : platform === 'facebook' && context.facebookFormat === 'reel' ? 'Facebook Reels' : name
      const why = platform === 'tiktok' && maxSec < (rules.maxSec ?? Infinity) ? ' for this account' : ''
      return { blocking: `${what} can be at most ${formatClipDuration(maxSec)}${why}. This clip is ${formatClipDuration(seconds)}.`, notes }
    }
  }

  if (platform === 'youtube' && seconds != null) {
    notes.push(vertical !== false && seconds <= YOUTUBE_SHORT_MAX_SEC ? 'Posts as a Short.' : 'Posts as a regular video.')
    if (seconds > YOUTUBE_UNVERIFIED_MAX_SEC) notes.push('Channels need phone verification for videos over 15 minutes.')
  }
  if (platform === 'tiktok' && vertical === false) notes.push('TikTok works best with vertical 9:16 video.')
  if (platform === 'instagram' && vertical === false) notes.push('Reels are 9:16, so Instagram will letterbox this clip.')
  if (platform === 'linkedin' && seconds != null && seconds > LINKEDIN_PERSONAL_MAX_SEC) notes.push('Personal profiles allow up to 10 minutes; Pages allow 30.')
  return { blocking: null, notes }
}

/** Default Facebook format for a clip: a Reel when it qualifies, otherwise a feed video. */
export function defaultFacebookFormat(media: ClipMediaInfo): FacebookFormat {
  if (media.durationMs == null || media.width == null || media.height == null) return 'feed'
  return checkClip('facebook', media, { facebookFormat: 'reel' }).blocking ? 'feed' : 'reel'
}

/** Characters as people count them (code points), close to how the platforms count. */
export function captionLength(caption: string): number {
  return [...caption].length
}

export interface CaptionCheck {
  error: string | null
  warning: string | null
}

export function checkCaption(platform: ZernioPlatform, caption: string): CaptionCheck {
  const rules = PLATFORM_RULES[platform]
  const length = captionLength(caption)
  if (length <= rules.captionMax) return { error: null, warning: null }
  const text = `${platformLabel(platform)} allows ${rules.captionMax.toLocaleString('en-US')} characters.`
  return rules.captionStrict
    ? { error: text, warning: null }
    : { error: null, warning: `${text} Only X Premium accounts can post longer captions.` }
}

// ---- Caption defaults -----------------------------------------------------

/** "startup tips" → "#StartupTips", "ai" → "#ai". Drops tags with nothing usable. */
export function hashtagFor(tag: string): string | null {
  const words = tag.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return null
  const joined = words.length === 1 ? words[0] : words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')
  return `#${joined.slice(0, 60)}`
}

export function defaultCaption(title: string, tags: string[], maxTags = 5): string {
  const seen = new Set<string>()
  const hashtags: string[] = []
  for (const tag of tags) {
    const hashtag = hashtagFor(tag)
    if (!hashtag || seen.has(hashtag.toLowerCase())) continue
    seen.add(hashtag.toLowerCase())
    hashtags.push(hashtag)
    if (hashtags.length === maxTags) break
  }
  return [title.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

/** YouTube titles are at most 100 characters and can't contain angle brackets. */
export function youtubeTitleFor(title: string): string {
  const cleaned = title.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  const chars = [...cleaned]
  if (chars.length <= YOUTUBE_TITLE_MAX) return cleaned
  return `${chars.slice(0, YOUTUBE_TITLE_MAX - 1).join('').trimEnd()}…`
}

// ---- TikTok -----------------------------------------------------------------

export interface TikTokCreatorInfo {
  accountId: string
  nickname: string | null
  /** False when TikTok won't accept another direct post from this creator right now. */
  canPostMore: boolean
  /** Only these values may be sent as privacy_level. */
  privacyLevels: { value: string; label: string }[]
  maxVideoDurationSec: number | null
  /** False when the creator turned the interaction off in the TikTok app. */
  interactions: { comment: boolean; duet: boolean; stitch: boolean }
  /** Commercial content disclosures the account can make ('brand_organic', 'brand_content'). */
  commercialContentTypes: string[]
}

export const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me'
}

/** Commercial disclosures every selected TikTok account can make (all of them when unreported). */
export function sharedCommercialTypes(infos: TikTokCreatorInfo[]): string[] {
  const [first, ...rest] = infos
  if (!first) return []
  return first.commercialContentTypes.filter((type) => rest.every((info) => info.commercialContentTypes.includes(type)))
}

/**
 * One TikTok account's choices, checked against its own creator info.
 * TikTok's rules: the user picks the privacy level from that creator's
 * options (no default), and branded content can't be private.
 */
export function tiktokAccountError(options: TikTokPostOptions, account: TikTokAccountOptions | undefined, info: TikTokCreatorInfo): string | null {
  const privacy = account?.privacyLevel ?? ''
  if (!privacy) return 'Choose who can view the TikTok post.'
  if (!info.privacyLevels.some((level) => level.value === privacy)) return 'That TikTok privacy option isn’t available for this account. Choose another.'
  if (options.disclose && options.brandedContent && privacy === 'SELF_ONLY') return 'Branded content can’t be private on TikTok. Choose another privacy option.'
  if (!options.draft && !info.canPostMore) return 'TikTok isn’t accepting more posts from this account right now. Try later, or send it to your TikTok inbox.'
  return null
}

/**
 * Every selected TikTok account's choices, then the ones they share
 * (disclosure and consent). `label` names an account when there are several.
 */
export function tiktokOptionsError(options: TikTokPostOptions, infos: TikTokCreatorInfo[], label?: (accountId: string) => string): string | null {
  for (const info of infos) {
    const error = tiktokAccountError(options, options.accounts[info.accountId], info)
    if (error) return infos.length > 1 && label ? `${label(info.accountId)}: ${error}` : error
  }
  if (options.disclose && !options.yourBrand && !options.brandedContent) return 'Choose whether the TikTok post promotes your brand, a third party, or both.'
  if (options.disclose) {
    const requiredTypes = [options.yourBrand ? 'brand_organic' : null, options.brandedContent ? 'brand_content' : null].filter((type): type is string => type !== null)
    for (const info of infos) {
      // Older creator-info responses may omit this field. When Zernio does
      // report available types, reject a disclosure this creator cannot make.
      if (info.commercialContentTypes.length === 0) continue
      if (requiredTypes.some((type) => !info.commercialContentTypes.includes(type))) {
        const message = 'This TikTok account does not offer the selected commercial content disclosure.'
        return infos.length > 1 && label ? `${label(info.accountId)}: ${message}` : message
      }
    }
  }
  if (!options.consent) return 'Agree to TikTok’s terms to post there.'
  return null
}

/** TikTok's required declaration, shown next to the consent checkbox. */
export function tiktokConsentText(brandedContent: boolean): string {
  return brandedContent
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
    : "By posting, you agree to TikTok's Music Usage Confirmation."
}

/** Fixed TikTok legal pages the dialog may open; the main process maps keys to URLs. */
export const TIKTOK_LEGAL_LINKS = {
  musicUsage: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
  brandedContent: 'https://www.tiktok.com/legal/page/global/bc-policy/en'
} as const
export type TikTokLegalLink = keyof typeof TIKTOK_LEGAL_LINKS

// ---- Requests and results ---------------------------------------------------

export type FacebookFormat = 'reel' | 'feed'
export type YouTubeVisibility = 'public' | 'unlisted' | 'private'

/** Choices made separately for each TikTok account: each creator has its own options. */
export interface TikTokAccountOptions {
  /** '' until the user picks one; TikTok forbids a default. */
  privacyLevel: string
  allowComment: boolean
  allowDuet: boolean
  allowStitch: boolean
}

export const EMPTY_TIKTOK_ACCOUNT: TikTokAccountOptions = { privacyLevel: '', allowComment: false, allowDuet: false, allowStitch: false }

export interface TikTokPostOptions {
  /** By TikTok account id. */
  accounts: Record<string, TikTokAccountOptions>
  /** Commercial content disclosure. */
  disclose: boolean
  yourBrand: boolean
  brandedContent: boolean
  madeWithAi: boolean
  /** Send to the creator's TikTok inbox to finish in the app, instead of posting directly. */
  draft: boolean
  /** The user ticked TikTok's consent declaration. */
  consent: boolean
}

export interface YouTubePostOptions {
  title: string
  visibility: YouTubeVisibility
  madeForKids: boolean
  categoryId?: string
  tags?: string[]
}

export interface PostOptions {
  tiktok?: TikTokPostOptions
  youtube?: YouTubePostOptions
  instagram?: { shareToFeed: boolean }
  facebook?: { format: FacebookFormat; title?: string }
  threads?: { topicTag?: string }
}

export type PostTiming = { mode: 'now' } | { mode: 'schedule'; scheduledFor: string; timezone: string }

export interface PostTarget {
  platform: ZernioPlatform
  accountId: string
  /** Overrides the shared content for this account; used by automation metadata. */
  customContent?: string
}

export interface PostClipRequest {
  /** Chosen by the renderer per clip. Progress events carry it, and a retry with it reuses the upload. */
  attemptId: string
  clipPath: string
  clipTitle: string
  /** From job_output.json; used only when ffprobe can't read the file. */
  durationMs: number | null
  caption: string
  targets: PostTarget[]
  timing: PostTiming
  options: PostOptions
}

export interface PostProgress {
  attemptId: string
  phase: 'uploading' | 'publishing'
  transferred: number
  total: number
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled' | 'missing'
export type PostTargetStatus = 'pending' | 'processing' | 'uploading' | 'published' | 'failed' | 'cancelled'

export interface PostRecordTarget {
  platform: string
  accountId: string
  /** @handle or display name when the post was made; for display only. */
  handle: string | null
  status: PostTargetStatus
  error: string | null
  url: string | null
  /** TikTok Creator Inbox upload: "published" means handed to the inbox. */
  inbox: boolean
}

/** One post in the local history (userData/zernio-posts.json). Nothing secret. */
export interface PostRecord {
  /** Its failed automation clip was returned to the queue; only the new attempt may post. */
  automationRequeued?: boolean
  id: string
  clipPath: string
  clipTitle: string
  targets: PostRecordTarget[]
  scheduledFor: string | null
  timezone: string | null
  status: PostStatus
  error: string | null
  createdAt: string
  /** When the clip reached Zernio's storage; bounds rescheduling (7-day retention). */
  uploadedAt: string
  refreshedAt: string | null
}

export type PostOutcome = 'published' | 'scheduled' | 'partial' | 'failed' | 'retrying' | 'publishing' | 'duplicate'

export interface PostClipResult {
  post: PostRecord | null
  outcome: PostOutcome
  message: string
  warnings: string[]
}

export interface PostsRefreshResult {
  posts: PostRecord[]
  /** Set when some statuses couldn't be refreshed; the list is still usable. */
  error: string | null
}

const ACTIVE: PostStatus[] = ['scheduled', 'publishing']
export function isPostActive(post: Pick<PostRecord, 'status'>): boolean {
  return ACTIVE.includes(post.status)
}
