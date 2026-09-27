import { lstat, readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { OutputStorageUsage } from '../shared/output-storage'

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Sum file sizes asynchronously, without following links inside the output folder. */
export async function measureOutputStorage(outputDirectory: string): Promise<OutputStorageUsage> {
  const usage: OutputStorageUsage = { outputDirectory, bytes: 0, fileCount: 0, exists: true, unreadableCount: 0 }
  try {
    if (!(await stat(outputDirectory)).isDirectory()) throw new Error('The output folder is not a directory.')
  } catch (error) {
    if (!missing(error)) throw error
    return { ...usage, exists: false }
  }

  const directories = [outputDirectory]
  while (directories.length) {
    const directory = directories.pop()!
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (!missing(error)) usage.unreadableCount++
      continue
    }
    for (const name of names) {
      const path = join(directory, name)
      try {
        const info = await lstat(path)
        if (info.isDirectory()) directories.push(path)
        else if (info.isFile()) {
          usage.bytes += info.size
          usage.fileCount++
        }
      } catch (error) {
        // Files may disappear while a run is being cleaned up.
        if (!missing(error)) usage.unreadableCount++
      }
    }
  }
  return usage
}
