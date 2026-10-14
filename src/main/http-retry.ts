import { setTimeout as delay } from 'timers/promises'
import { readResponseText } from './http-response'
import { logger } from './logger'

export function transientHttpStatus(status: number): boolean {
  return [408, 500, 502, 503, 504].includes(status)
}

/** Two retries, bounded waits, and never shorter than the provider's minimum. */
export function transientRetryDelay(attempt: number, retryAfter: string | null = null): number | null {
  const base = [500, 1500][attempt]
  if (base === undefined) return null
  let minimum = 0
  if (retryAfter) {
    const seconds = Number(retryAfter)
    minimum = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
    if (!Number.isFinite(minimum)) minimum = 0
  }
  return minimum > 10_000 ? null : Math.max(base, minimum)
}

function transientNetworkError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'TypeError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(String((error as NodeJS.ErrnoException).code)))
}

/** Only opt in when replaying the request is safe. Read the body inside the retry. */
export async function fetchTextWithRetry(url: string, init: RequestInit, options: {
  timeoutMs: number; maxBytes: number; tooLargeMessage?: string; retry: boolean; retryRateLimit?: boolean; operation: string
  /** Some providers intermittently return an empty or malformed success body. */
  acceptText?: (text: string) => boolean
  beforeAttempt?: () => void
  onResponse?: (response: Response) => void
}): Promise<{ response: Response; text: string }> {
  for (let attempt = 0; ; attempt++) {
    let wait: number | null
    try {
      options.beforeAttempt?.()
      const response = await fetch(url, { ...init, signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs) })
      options.onResponse?.(response)
      const retryable = transientHttpStatus(response.status) || (options.retryRateLimit && response.status === 429)
      wait = options.retry && retryable ? transientRetryDelay(attempt, response.headers.get('retry-after')) : null
      if (wait === null) {
        const text = await readResponseText(response, options.maxBytes, options.tooLargeMessage)
        wait = options.retry && response.ok && options.acceptText && !options.acceptText(text) ? transientRetryDelay(attempt) : null
        if (wait === null) return { response, text }
      } else await response.body?.cancel()
    } catch (error) {
      wait = options.retry && !init.signal?.aborted && transientNetworkError(error) ? transientRetryDelay(attempt) : null
      if (wait === null) throw error
    }
    logger.warn('http.request.retry', { operation: options.operation, attempt: attempt + 1 })
    await delay(wait, undefined, { signal: init.signal ?? undefined })
  }
}
