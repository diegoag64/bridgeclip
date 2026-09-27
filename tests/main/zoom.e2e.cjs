const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('app zoom shortcuts work with focused fields, apply once, and reset', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-zoom-e2e-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  const modifier = process.platform === 'darwin' ? 'meta' : 'control'
  const level = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  // CDP keyboard events skip Electron's before-input-event hook. Use native input.
  const press = (keyCode, modifiers = [modifier]) => app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }, { keyCode, modifiers })
  const field = page.getByRole('textbox', { name: 'Video link', exact: true })
  await field.fill('zoom-test')
  // Even a renderer control that consumes keyboard events cannot block zoom.
  await field.evaluate(el => el.addEventListener('keydown', e => { e.preventDefault(); e.stopPropagation() }))
  for (const [key, expected] of [['-', -.5], ['-', -1], ['=', -.5], ['Shift+=', 0], ['-', -.5], ['0', 0]]) {
    await press(key.replace('Shift+', ''), [modifier, ...(key.startsWith('Shift+') ? ['shift'] : [])])
    assert.equal(await level(), expected, key)
    assert.equal(await field.inputValue(), 'zoom-test')
  }
  await press('-', [])
  assert.equal(await level(), 0, 'Unmodified typing must not zoom')
  await press('-', [modifier, 'alt'])
  assert.equal(await level(), 0, 'Option/Alt shortcuts must not zoom')
  await press('numsub')
  assert.equal(await level(), -.5, 'Keypad minus also zooms out')
  await press('0')
  assert.equal(await level(), 0)
})
