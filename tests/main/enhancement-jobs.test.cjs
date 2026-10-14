const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function setup() {
  let key = 'workspace-a'
  let release
  const calls = []
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/automation-enhancement-jobs.ts'), 'utf8')
  const module = { exports: {} }
  const mocks = {
    '../shared/automations': { MAX_ENHANCEMENT_GUIDANCE: 2000 },
    './settings-store': { loadSettings: () => ({ zernioApiKey: key }) },
    './zernio/workspace-cache': { workspaceId: key => key },
    './automations': {
      listAutomations: () => [{ id: 'automation', name: 'Daily clips' }],
      automationEnhancementGroups: async () => [{ key: 'source', title: 'Interview', contentIds: ['a', 'b', 'c', 'd', 'e', 'f'] }],
      enhanceAutomationBatch: async (_id, ids, _key, _guidance, progress) => {
        calls.push([...ids]); progress({ phase: 'writing' })
        await new Promise(resolve => { release = resolve })
        return { completed: ids.length, skipped: 0, errors: [] }
      }
    }
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: id => mocks[id] ?? require(id), structuredClone })
  return { api: module.exports, calls, release: () => release(), changeWorkspace: () => { key = 'workspace-b' } }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('stopping a source enhancement finishes only the current batch and keeps its result available', async () => {
  const f = setup()
  await assert.rejects(f.api.startEnhancementJob('automation', 'source', 'x'.repeat(2001)), /2000/)
  assert.equal(f.calls.length, 0)
  const job = await f.api.startEnhancementJob('automation', 'source')
  await assert.rejects(f.api.startEnhancementJob('automation', 'source'), /already has an enhancement/)
  assert.equal(f.api.listEnhancementJobs()[0].stage.phase, 'writing')
  assert.throws(() => f.api.controlEnhancementJob(job.id, 'dismiss'), /Wait/)
  f.api.controlEnhancementJob(job.id, 'stop')
  assert.equal(f.api.listEnhancementJobs()[0].status, 'running')
  f.release(); await settle()
  const stopped = f.api.listEnhancementJobs()[0]
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.completed, 5)
  assert.equal(stopped.processed, 5)
  assert.equal(stopped.total, 6)
  assert.equal(f.calls.length, 1, 'the remaining clip is never submitted')
  f.api.controlEnhancementJob(job.id, 'dismiss')
  assert.equal(f.api.listEnhancementJobs().length, 0)
})

test('changing workspaces hides earlier enhancement runs and prevents their remaining batches', async () => {
  const f = setup()
  const job = await f.api.startEnhancementJob('automation', 'source')
  f.changeWorkspace()
  assert.equal(f.api.listEnhancementJobs().length, 0)
  assert.throws(() => f.api.controlEnhancementJob(job.id, 'stop'), /not found/)
  f.release(); await settle()
  assert.equal(f.calls.length, 1)
  assert.equal(f.api.listEnhancementJobs().length, 0)
})
