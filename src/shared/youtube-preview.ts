export interface YouTubePreview {
  title: string
  channel: string | null
  durationSeconds: number | null
  viewCount: number | null
  /** ISO calendar date, without a timezone. */
  uploadedOn: string | null
}
