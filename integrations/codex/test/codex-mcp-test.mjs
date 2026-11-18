// Exercises the shipped stdio entry. No real mouse/keyboard input is sent.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = await mkdtemp(join(tmpdir(), 'independent-input-test-'))
async function run(extraEnv = {}) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../scripts/codex-mcp.mjs', import.meta.url))], {
    env: { ...process.env, CODEX_INPUT_DATA_DIR: temp, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const pending = new Map()
  let id = 0
  let stderr = ''
  proc.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: proc.stdout })
  lines.on('line', line => {
    const response = JSON.parse(line)
    pending.get(response.id)?.(response)
    pending.delete(response.id)
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const next = ++id
    const timer = setTimeout(() => reject(new Error(`timeout ${method}: ${stderr}`)), 45000)
    pending.set(next, value => { clearTimeout(timer); resolve(value) })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
  })
  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.result.protocolVersion, '2024-11-05')
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const list = await call('tools/list', {})
    assert.equal(list.result.tools[0].name, 'independent_input')
    assert.deepEqual(list.result.tools[0].inputSchema.required, ['action'])
    const toolCall = args => call('tools/call', { name: 'independent_input', arguments: args })
    for (const args of [{ action: 'click', x: 0, y: 0 }, { action: 'key', hwnd: 1, keys: 'enter', mode: 'physical' }, { action: 'unknown' }]) {
      assert.equal((await toolCall(args)).result.isError, true)
    }
    assert.equal((await call('unknown', {})).error.code, -32601)
    assert.equal((await call('tools/call', { name: 'unknown', arguments: {} })).error.code, -32602)
    if (extraEnv.CODEX_INPUT_ENABLED === '0') {
      assert.match((await toolCall({ action: 'status' })).result.content[0].text, /总开关已关闭/)
    } else if (process.platform === 'win32') {
      const status = (await toolCall({ action: 'status' })).result
      assert.equal(status.isError, false, status.content[0].text)
      const state = JSON.parse(status.content.at(-1).text)
      assert.equal(typeof state.paused, 'boolean')
      const windows = (await toolCall({ action: 'windows' })).result
      assert.equal(windows.isError, false, windows.content[0].text)
      assert.ok(Array.isArray(JSON.parse(windows.content.at(-1).text).windows))
      const meta = result => JSON.parse(result.content.at(-1).text)
      assert.equal(state.sessionState, 'idle')
      const noWindow = (await toolCall({ action: 'observe', hwnd: 1 })).result
      assert.equal(noWindow.isError, true)
      assert.equal(meta(noWindow).reason, 'target-hwnd-invalid')
      await toolCall({ action: 'pause' })
      const begun = (await toolCall({ action: 'begin' })).result
      assert.equal(meta(begun).paused, true, 'begin must not clear a pause')
      assert.equal(meta(begun).sessionState, 'active')
      await toolCall({ action: 'finish' })
      await toolCall({ action: 'resume' })
      const afterFinish = (await toolCall({ action: 'key', hwnd: 1, keys: 'enter' })).result
      assert.equal(meta(afterFinish).reason, 'session-finished', 'finish must reject before touching any HWND')
      await toolCall({ action: 'begin' })
      await toolCall({ action: 'pause' })
      const pausedInput = (await toolCall({ action: 'key', hwnd: 1, keys: 'enter' })).result
      assert.equal(meta(pausedInput).paused, true, 'paused input is rejected before target lookup')
      await toolCall({ action: 'finish' })
      // Small screenshot verifies image attachment conversion, without controlling input.
      const shot = (await toolCall({ action: 'capture', rect: '0,0,16,16' })).result
      assert.equal(shot.isError, false, shot.content[0].text)
      const image = shot.content.find(item => item.type === 'image')
      assert.equal(image.mimeType, 'image/png')
      assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG')
      assert.deepEqual(JSON.parse(shot.content.at(-1).text).screenshot, { height: 16, width: 16, scale: 1, x: 0, y: 0 })
      assert.equal(meta(shot).method, 'screen-copy')
      assert.equal(meta(shot).occlusionSafe, false)
      console.log('real sidecar status/windows/capture + MCP image: PASS')
    }
  } finally {
    proc.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => { proc.kill(); resolve() }, 3000)
      proc.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
try { await run(); await run({ CODEX_INPUT_ENABLED: '0' }); console.log('stdio protocol, validation, disabled switch: PASS') }
finally { await rm(temp, { recursive: true, force: true }) }
