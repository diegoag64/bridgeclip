import type { FileHandle } from 'fs/promises'
import { readResponseText } from '../http-response'
import { lookup as dnsLookup } from 'dns'
import { Readable, Transform } from 'stream'
import { Agent } from 'undici'
import { isPublicAddress } from '../network-policy'
import { isUploadUrl, ZernioApiError } from './client'
import { transientHttpStatus, transientRetryDelay } from '../http-retry'
import { setTimeout as delay } from 'timers/promises'
import { logger } from '../logger'

export interface UploadOptions {
  contentType: string
  size: number
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

export class ZernioUploadCancelledError extends ZernioApiError {
  constructor() {
    super('Upload cancelled.', 0)
  }
}

const STALL_MS = 60_000
/** Once every byte is sent, storage gets this long to confirm. */
const CONFIRM_MS = 120_000
/** Presigned upload URLs expire after an hour. */
const MAX_MS = 55 * 60_000

/** Container types Zernio's presign accepts for the clip formats BridgeClip writes. */
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

export function videoContentType(filePath: string): string | null {
  const match = /\.[^./\\]+$/.exec(filePath)
  return match ? VIDEO_TYPES[match[0].toLowerCase()] ?? null : null
}

/**
 * Stream a file to a presigned storage URL. The request carries no
 * Authorization header (storage authenticates by the signature in the URL),
 * reports progress as bytes leave the file, and aborts when nothing moves
 * for a minute.
 */
export async function putFile(uploadUrl: string, source: FileHandle, options: UploadOptions): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      options.onProgress?.(0, options.size)
      return await putFileAttempt(uploadUrl, source, options)
    } catch (error) {
      if (options.signal?.aborted || error instanceof ZernioUploadCancelledError) throw new ZernioUploadCancelledError()
      const wait = error instanceof ZernioApiError && error.code !== 'unsafe_upload_destination' && (error.status === 0 || error.status === 429 || transientHttpStatus(error.status))
        ? transientRetryDelay(attempt, error.retryAfterSeconds === null ? null : String(error.retryAfterSeconds)) : null
      if (wait === null) throw error
      logger.warn('zernio.post.upload.retry', { attempt: attempt + 1, status: (error as ZernioApiError).status })
      try { await delay(wait, undefined, { signal: options.signal }) }
      catch { throw new ZernioUploadCancelledError() }
    }
  }
}

async function putFileAttempt(uploadUrl: string, source: FileHandle, options: UploadOptions): Promise<void> {
  if (options.signal?.aborted) throw new ZernioUploadCancelledError()
  const secure = isUploadUrl(uploadUrl)
  if (!secure && !(uploadUrl.startsWith('http://') && isUploadUrl(uploadUrl, true))) {
    throw new ZernioApiError('Zernio did not return a secure upload link.', 502, 'unsafe_upload_destination')
  }
  // Resolve at socket creation and pass only the checked address to connect.
  // Undici retains the original hostname for TLS SNI and certificate checks.
  let destinationBlocked = false
  const dispatcher = secure ? new Agent({ connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { all: true }, (error, addresses) => {
        const publicAddresses = addresses?.filter(({ address }) => isPublicAddress(address)) ?? []
        if (error || publicAddresses.length === 0) {
          destinationBlocked = !error
          callback(new Error('Upload destination is not public'), '', 0)
          return
        }
        // Undici requests all addresses for family selection. Returning one
        // string to that callback fails with ERR_INVALID_IP_ADDRESS.
        // Pass only validated addresses so mixed DNS answers cannot connect
        // to a private address.
        if (options.all) callback(null, publicAddresses)
        else callback(null, publicAddresses[0].address, publicAddresses[0].family)
      })
    }
  } }) : null
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })

  let sent = 0
  let lastActivity = Date.now()
  let stalled = false
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > (sent >= options.size ? CONFIRM_MS : STALL_MS)) {
      stalled = true
      controller.abort()
    }
  }, 2_000)
  const deadline = setTimeout(() => {
    stalled = true
    controller.abort()
  }, MAX_MS)

  // Explicit offsets replay the authorized handle from byte zero. Destroying a
  // failed upload stream must not close the caller's handle before a retry.
  const file = Readable.from((async function* () {
    for (let position = 0; position < options.size;) {
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, options.size - position))
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (!bytesRead) throw new Error('Upload source ended before the expected size')
      position += bytesRead
      yield buffer.subarray(0, bytesRead)
    }
  })(), { objectMode: false })
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sent += chunk.length
      lastActivity = Date.now()
      options.onProgress?.(sent, options.size)
      callback(null, chunk)
    }
  })
  file.on('error', (error) => counter.destroy(error))

  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      // Storage needs the exact length (no chunked encoding) and the type the presign named.
      headers: { 'Content-Type': options.contentType, 'Content-Length': String(options.size) },
      body: Readable.toWeb(file.pipe(counter)) as unknown as BodyInit,
      duplex: 'half',
      redirect: 'error',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    } as RequestInit & { duplex: 'half'; dispatcher?: Agent })
    await readResponseText(response, 64 * 1024)
    if (!response.ok) {
      const header = response.headers.get('retry-after')
      const seconds = header === null ? null : Number.isFinite(Number(header)) ? Math.max(0, Number(header)) : Math.max(0, (Date.parse(header) - Date.now()) / 1000)
      throw new ZernioApiError(`Uploading the clip to Zernio's storage failed (HTTP ${response.status}).`, response.status, null, seconds !== null && Number.isFinite(seconds) ? seconds : null)
    }
  } catch (error) {
    if (error instanceof ZernioApiError) throw error
    if (options.signal?.aborted) throw new ZernioUploadCancelledError()
    if (destinationBlocked) throw new ZernioApiError('The upload was interrupted because its destination is not public.', 0, 'unsafe_upload_destination')
    throw new ZernioApiError(
      stalled ? 'The upload stalled. Check your connection and try again.' : 'The upload was interrupted. Check your connection and try again.',
      0
    )
  } finally {
    clearInterval(watchdog)
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', cancel)
    file.destroy()
    counter.destroy()
    await dispatcher?.close()
  }
}
