'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const path = require('node:path')
const { loadMain, tempDir } = require('../zernio/support/load-main.cjs')
const { directoryLinkType, fileLinksAvailable } = require('../support/symlinks.cjs')
const source = "export * from './src/main/output-storage'"
const { measureOutputStorage } = loadMain(source)

test('storage totals include nested and hidden files, and reflect added/deleted files', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  fs.mkdirSync(path.join(temp.dir, 'run', '.editor'), { recursive: true })
  fs.writeFileSync(path.join(temp.dir, 'run', '.editor', 'source.mp4'), Buffer.alloc(1234))
  fs.writeFileSync(path.join(temp.dir, '.metadata'), Buffer.alloc(56))
  fs.writeFileSync(path.join(temp.dir, 'empty'), '')
  assert.deepEqual(await measureOutputStorage(temp.dir), { outputDirectory: temp.dir, bytes: 1290, fileCount: 3, exists: true, unreadableCount: 0 })
  fs.unlinkSync(path.join(temp.dir, '.metadata'))
  fs.writeFileSync(path.join(temp.dir, 'clip.mp4'), Buffer.alloc(1000))
  assert.equal((await measureOutputStorage(temp.dir)).bytes, 2234)
})

test('empty and missing output folders report zero without creating a directory', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  assert.equal((await measureOutputStorage(temp.dir)).bytes, 0)
  const missing = path.join(temp.dir, 'missing')
  assert.deepEqual(await measureOutputStorage(missing), { outputDirectory: missing, bytes: 0, fileCount: 0, exists: false, unreadableCount: 0 })
  assert.equal(fs.existsSync(missing), false)
})

test('links inside the output folder are excluded, including loops; a linked output root works', { skip: !directoryLinkType }, async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  const output = path.join(temp.dir, 'output')
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'clip'), '123')
  fs.mkdirSync(path.join(temp.dir, 'external'))
  fs.writeFileSync(path.join(temp.dir, 'external', 'video'), '123456789')
  fs.symlinkSync(path.join(temp.dir, 'external'), path.join(output, 'external'), directoryLinkType)
  fs.symlinkSync(output, path.join(output, 'loop'), directoryLinkType)
  fs.symlinkSync(output, path.join(temp.dir, 'alias'), directoryLinkType)
  if (fileLinksAvailable) fs.symlinkSync(path.join(output, 'clip'), path.join(output, 'file-link'), 'file')
  const result = await measureOutputStorage(path.join(temp.dir, 'alias'))
  assert.equal(result.bytes, 3)
  assert.equal(result.fileCount, 1)
  assert.equal(result.unreadableCount, 0)
})

test('unreadable entries mark totals as partial and files removed during scanning are skipped', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  fs.mkdirSync(path.join(temp.dir, 'blocked'))
  for (const name of ['readable', 'denied', 'removed']) fs.writeFileSync(path.join(temp.dir, name), '1234')
  const scanner = loadMain(source, { 'fs/promises': {
    ...promises,
    readdir: async (dir) => {
      if (path.basename(dir) === 'blocked') throw Object.assign(new Error('Denied'), { code: 'EACCES' })
      return promises.readdir(dir)
    },
    lstat: async (file) => {
      const name = path.basename(file)
      if (['denied', 'removed'].includes(name)) throw Object.assign(new Error(name), { code: name === 'denied' ? 'EACCES' : 'ENOENT' })
      return promises.lstat(file)
    }
  } })
  assert.deepEqual(await scanner.measureOutputStorage(temp.dir), { outputDirectory: temp.dir, bytes: 4, fileCount: 1, exists: true, unreadableCount: 2 })
})
