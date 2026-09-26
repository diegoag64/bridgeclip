import { editorBusy } from './clip-editor'
import { lstatSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { getJobOutput, isRunFavorite, LIBRARY_FAVORITE_FILE, removeRunThumbnails } from './file-manager'
import type { JobOutput } from '../shared/job-output'
import { dismissJob, liveJobIds } from './job-manager'
import { loadSettings } from './settings-store'

/** Only a completed, immediate child of the configured Library can be changed. */
async function checkedRun(raw: unknown): Promise<{ check: () => string; output: JobOutput }> {
  const librarySetting = loadSettings().outputDirectory
  if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) throw new Error('Choose a run in your Library.')
  const library = realpathSync(librarySetting)
  const path = resolve(raw)
  const original = lstatSync(path)
  const canonical = realpathSync(path)
  const check = (): string => {
    const current = lstatSync(path)
    if (loadSettings().outputDirectory !== librarySetting || realpathSync(librarySetting) !== library ||
        !current.isDirectory() || current.isSymbolicLink() || realpathSync(path) !== canonical ||
        dirname(canonical) !== library || realpathSync(dirname(path)) !== library ||
        current.dev !== original.dev || current.ino !== original.ino) throw new Error('The Library run changed. Refresh and try again.')
    if (editorBusy(path)) throw new Error('Wait for the editor to finish before changing this run.')
    if (liveJobIds().has(basename(path))) throw new Error('Wait for this run to finish before changing it.')
    return path
  }
  check()
  const output = await getJobOutput(path, library)
  if (!output) throw new Error('This completed run is no longer available in your Library.')
  check()
  return { check, output }
}

export async function setLibraryFavorite(outputDir: unknown, favorite: unknown): Promise<boolean> {
  if (typeof favorite !== 'boolean') throw new Error('Choose a valid favorite value.')
  const { check } = await checkedRun(outputDir)
  const path = check()
  const marker = join(path, LIBRARY_FAVORITE_FILE)
  if (favorite) {
    if (!isRunFavorite(path)) writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  } else {
    try { unlinkSync(marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return favorite
}

export async function deleteLibraryRun(outputDir: unknown): Promise<void> {
  const { check, output } = await checkedRun(outputDir)
  const path = check()
  removeRunThumbnails(path, output)
  check()
  // Never follow the manifest's media paths. Remove only this validated run
  // directory; recursive rm unlinks internal symlinks rather than their targets.
  rmSync(path, { recursive: true })
  dismissJob(basename(path))
}
