#!/usr/bin/env node
import {sanitizePublic} from '../lib/auth-privacy.js'
// MCP stdio transport: one JSON-RPC message per line. stdout is protocol only.
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { keyboardContractBlock } from '../lib/focus-policy.js'
import { sourceContext } from '../lib/session-source.js'

const dataDir = process.env.CODEX_INPUT_DATA_DIR || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'independent-input')
let tool
const log = (...args) => console.error('[independent-input]', ...args)
const dispose = await apply({
  tools: { register(value) { tool = value; return () => {} } },
  attachments: { async saveImage({ data, mediaType }) { return { type: 'image', data: data.toString('base64'), mimeType: mediaType } } },
  logger: { info: log, warn: log },
}, {}, { defineTool: value => value, settingsFile: join(dataDir, 'settings.json'), shotsDir: join(dataDir, 'shots') })

const actions = ['control_request','control_wait','control_cancel','status', 'windows', 'observe', 'capture', 'click', 'type', 'key', 'scroll', 'drag', 'bounds', 'place', 'reveal', 'open', 'open_status', 'move', 'begin', 'finish', 'pause', 'resume', 'overlay']
const inputActions = ['click', 'type', 'key', 'scroll', 'drag', 'bounds', 'place', 'reveal', 'open']
const properties = Object.fromEntries(Object.entries(tool.parameters).map(([key, value]) => {
  const { required, ...schema } = value
  return [key, schema]
}))
properties.action.enum = actions
properties.mode.enum = ['auto', 'uia', 'message', 'value', 'invoke']
properties.cursorMode.enum = ['companion', 'clean']
properties.button.enum = ['left', 'right']
properties.hwnd.type = 'integer'
properties.hwnd.minimum = 1
properties.cursorSize.anyOf = [{ const: 0 }, { type: 'number', minimum: 24, maximum: 192 }]
properties.hwnd.description = '本工具 windows 返回的原生 HWND；输入动作必填。capture 可选，用于选定截图区域。不得传入 sky/cua 的 opaque Window.id'
properties.path.description = 'open:要打开的本地绝对文件/文件夹/明确exe；capture:保存PNG绝对路径，可省略。open只发一次系统请求，不自动重试或移动共享实例旧窗。'
const definition = {
  name: tool.name,
  description: '先看status.control；仅容量/FIFO阻塞用control_request/control_wait/control_cancel排队，pause/resume-required等用户明确继续，不当排队；wait≤45秒，到期保持原执行器active并立即续wait，同票FIFO；ready后先begin再fresh观察，无旧输入重放。主会话有独立工作时同一原CU子代理等待并用父子通道通知，不新建chat/后台模型。Stop/host end撤票，不自动续。仅新协议实例保证公平，官方状态unknown。Windows桌面默认独立输入后端。windows选择唯一hwnd，observe返回新鲜observationId/elementId及UIA树（includeScreenshot可选），click/type优先用本次两ID+hwnd，一个动作后重新observe；stale要求fresh observe后仅一次原动作，普通状态变化不是硬stop。兼容hwnd+屏幕绝对物理像素；不要传sky/cua opaque ID、逻辑坐标或截图ID。UIA/offscreen=false仅provider报告，不保证屏幕可见。includeScreenshot实际附图后先看图核对场景/目标；mappingVerified/occlusionSafe不验证业务fresh。无图不作视觉验收；画面与UIA不符仅只读fresh核对，报告观察不一致，不判点击无效或盲重试/改焦点/搬窗。capture报告方法/原点/尺寸/遮挡限制。auto/message仅走目标native窗口消息；元素ID仅支持已核标准Button/Edit，未知仅该语义route受限、不回退provider；fresh图核后可显式坐标message。最多三个独立execution指针并行，同root预约排他、第四FIFO；每屏共享一个header。type mode:value在preserve下仅目标当前系统前台根允许，外国前台拒绝provider写入，后台用fresh消息路径；仅fresh元素双ID+hwnd、无坐标，对可写Edit/ComboBox窄ValuePattern.SetValue+回读，不主动请求焦点但provider可能激活，不能保证DOM/input/change/React状态。type无坐标保留显式child；key x/y成对时选child，否则直投hwnd。显式uia调用provider可能SetFocus/激活，仅获允许时选择。reveal仅显式对授权可见非最小化顶层窗提普通Z序，NOACTIVATE/不移缩/不永久置顶，可能覆盖同屏其它窗；不自动用于独占游戏屏，后fresh观察，不保证全程前台。bounds/place仍NOZORDER。不调用真实输入/官方CU，不自动fallback原生CU。begin清观察但不清暂停，先begin再observe；finish只结束输入会话，yieldSeconds是资源让出提示、不暂停根任务，后续须begin。active时物理Ctrl+Esc或pause锁暂停，普通键鼠不结束；用户明确继续才resume。宿主stop/end/拒绝仍立即停止，不可绕过。',
  inputSchema: { type: 'object', properties, required: ['action'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments 必须为对象')
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key]
    if (!schema) throw new Error(`未知参数：${key}`)
    const valid = schema.type === 'integer' ? Number.isInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === schema.type
    if (!valid || (schema.enum && !schema.enum.includes(value))) throw new Error(`参数无效：${key}`)
  }
  if (!actions.includes(args.action)) throw new Error('action 无效或缺失')
  if(args.waitMs!==undefined && (args.waitMs<0 || args.waitMs>45000))throw new Error('waitMs须0–45000')
  if (args.cursorSize !== undefined && args.cursorSize !== 0 && (args.cursorSize < 24 || args.cursorSize > 192)) throw new Error('cursorSize 为0（系统大小）或24–192（手动像素）')
  if (args.hwnd !== undefined && (!Number.isSafeInteger(args.hwnd) || args.hwnd <= 0)) throw new Error('hwnd 必须是本工具 windows 返回的正整数')
  if (((inputActions.includes(args.action) && args.action !== 'open') || args.action === 'observe') && (!Number.isSafeInteger(args.hwnd) || args.hwnd <= 0)) throw new Error('此动作必须提供正整数目标 hwnd；先用 windows 获取')
  if (args.maxTextChars !== undefined && (args.maxTextChars < 1 || args.maxTextChars > 16384)) throw new Error('maxTextChars须1–16384')
  if (args.limit !== undefined && (args.limit < 1 || args.limit > 100)) throw new Error('limit须1–100')
  if (args.offset !== undefined && args.offset < 0) throw new Error('offset须非负')
  if (args.pid !== undefined && args.pid < 1) throw new Error('pid须正整数')
  if (args.windowObservationId !== undefined && (!args.windowObservationId || !['click','type','key','scroll','drag'].includes(args.action) || args.elementId || args.observationId)) throw new Error('windowObservationId仅用于独立坐标/窗口输入guard，不能与元素IDs组合')
  if (args.maxElements !== undefined && (args.maxElements < 1 || args.maxElements > 500)) throw new Error('maxElements必须为1–500')
  const contract=keyboardContractBlock(args.action,args);if(contract)throw new Error(contract.note)
  const semantic = args.elementId !== undefined || args.observationId !== undefined
  if (semantic && (!['click','type'].includes(args.action) || !args.elementId || !args.observationId)) throw new Error('元素click/type必须同时带本次observationId和elementId')
  const required = { click: semantic ? [] : ['x', 'y'], move: ['x', 'y'], scroll: ['x', 'y'], drag: ['x', 'y', 'toX', 'toY'], bounds: ['x','y','width','height'], open: ['path'], type: ['text'], key: ['keys'] }[args.action] || []
  for (const key of required) if (args[key] === undefined) throw new Error(`缺少参数：${key}`)
  if (args.action === 'bounds' && (args.width < 1 || args.height < 1)) throw new Error('bounds宽高必须是正整数')
}

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
async function handle(message, requestOptions={}) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') throw Object.assign(new Error('Invalid Request'), { code: -32600 })
  switch (message.method) {
    case 'initialize': return {
      protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'dsh-independent-input', version: '0.7.6' },
    }
    case 'ping': return {}
    case 'tools/list': return { tools: [definition] }
    case 'tools/call': {
      if (message.params?.name !== tool.name) throw Object.assign(new Error('Unknown tool'), { code: -32602 })
      try {
        validate(message.params.arguments)
        if (process.platform !== 'win32') throw new Error('独立输入仅支持 Windows')
        if (process.env.CODEX_INPUT_ENABLED === '0') throw new Error('独立输入总开关已关闭（CODEX_INPUT_ENABLED=0）')
        const result = await tool.execute(message.params.arguments, requestOptions.context||sourceContext(message.params._meta), {signal:requestOptions.signal})
        if(result.meta?.controlReminder) requestOptions.notice=result.meta.controlReminder
        return {
          content: [{ type: 'text', text: result.meta?.enabled === false ? '独立输入已关闭：修改 Codex 独立输入数据目录的 settings.json 中 enabled 为 true，重启 MCP。' : result.text }, ...(result.images || []), { type: 'text', text: JSON.stringify(result.meta || {}) }],
          isError: result.meta?.ok === false || (result.meta?.paused === true && inputActions.includes(message.params.arguments.action)),
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `独立输入没完成：${error.message}` }], isError: true }
      }
    }
    default: throw Object.assign(new Error('Method not found'), { code: -32601 })
  }
}

let closed = false
const send = value => new Promise(resolve=>{if(closed){resolve(false);return}process.stdout.write(`${JSON.stringify(sanitizePublic(value))}\n`,error=>resolve(!error))})
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const requests = new Map()
let queue = Promise.resolve(), active = null
lines.on('line', line => {
  if (!line.trim() || closed) return
  let message
  try { message = JSON.parse(line) } catch { send({ jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'} }); return }
  if (message?.id === undefined && typeof message?.method === 'string') {
    if (message.method === 'notifications/cancelled') {
      const cancelId=message.params?.requestId
      const entry = (typeof cancelId==='string'||typeof cancelId==='number') ? requests.get(cancelId) : null
      if (entry && entry.message.method !== 'initialize') { entry.cancelled = true; entry.controller.abort(); if(entry.message.method==='tools/call')dispose.cancelRequest?.(entry.context) }
    }
    return // Notifications never receive responses.
  }
  const entry = { message, cancelled:false, controller:new AbortController(), context:sourceContext(message.params?._meta), fast:message.method==='tools/call'&&['status','control_request','control_wait','control_cancel'].includes(message.params?.arguments?.action) }
  requests.set(message?.id, entry)
  const run=async () => {
    if (closed) { requests.delete(message?.id); return }
    if (entry.cancelled) { requests.delete(message?.id); return }
    if(!entry.fast)active = entry
    try { const options={context:entry.context,signal:entry.controller.signal};const result=await handle(message,options); if(!entry.cancelled){const written=await send({jsonrpc:'2.0',id:message?.id??null,result});if(written&&options.notice)await dispose.reminderDelivered?.(entry.context,options.notice.leaseId)} }
    catch(error) { if(!entry.cancelled) send({jsonrpc:'2.0',id:message?.id??null,error:{code:error.code||-32603,message:error.message}}) }
    finally {
      // A cancellation can arrive after enqueue returns but before its tool
      // response is written. Cleanup follows handle settlement, never precedes
      // a late queue writer, and cannot interrupt the desktop holder.
      if(entry.cancelled&&message.params?.arguments?.action==='control_request')await dispose.cancelQueuedTicket?.(entry.context).catch(log)
      if(active===entry) active=null; requests.delete(message?.id)
    }
  }
  if(entry.fast)run().catch(log);else queue=queue.then(run).catch(log)
})
const disconnect = () => { if(closed)return; closed=true; for(const entry of requests.values()){entry.cancelled=true;entry.controller.abort()}; dispose() }
lines.on('close', disconnect)
process.stdin.on('error', disconnect)
process.stdout.on('error', disconnect)
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, disconnect)
process.on('exit', disconnect)
