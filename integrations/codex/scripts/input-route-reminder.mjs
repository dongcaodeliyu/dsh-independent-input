#!/usr/bin/env node
// Stateless conditional default, not permission or a tool interceptor.
const context = '[Windows桌面默认后端] 若本轮确需已获用户授权的Windows桌面动作，默认使用独立输入插件 server independent-input / tool independent_input，不静默回退原生Computer Use。用户后续明确改选时尊重最新要求；浏览器及专门连接器仍按任务适用性选择。提及、引用、历史、状态问答或本提示本身不授予输入权限。先windows选唯一hwnd；begin清观察，先begin再observe→单动作→再observe；元素语义拒绝只限该route，fresh图核后可显式坐标message，不自动切官方。stale只fresh后原动作一次，普通键鼠不算硬stop。active真实Ctrl+Esc/pause锁停，用户明确继续才resume；若本execution回requiredAction=resume且已获允许，原执行器直接resume一次，不重复请示；只交还时确认恢复后直接finish，不发应用输入。finish只结束输入会话。让出N分钟用finish/yieldSeconds，原CU及父保持active有界等原deadline再排队，不Final/goal暂停或重放旧pause；用户整任务pause/host硬stop仍停。宿主stopped/ended/权限拒绝立即停，begin不清暂停。工具不可见准确报告并正式刷新，不用模块/受限REPL或新client绕入口。有副屏优先；open单次票据→open_status/observe→确认唯一新窗再显式place到preferredMonitor，unknown/shared不暗搬、不重开；monitor/noactivate仅请求，不承诺首帧或保焦。保留已授权主屏目标收尾。本插件同桌面最多三execution/不同根窗口，第四FIFO，每屏一共享提示；官方状态unknown。busy才control_request/control_wait，每次≤45秒到期续原票，不因等待Final；原CU子代理可等并经父子消息通知，ready先begin再fresh观察；stop撤自己票，不新建chat/后台模型。保持唯一已协调电脑执行器。软提示不授权、不热加载工具、不强制模型服从、不启动输入。'
let output = {}
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (input?.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string') {
    output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }
  }
} catch { /* Missing/invalid hook payload is a no-op, never an authorization. */ }
process.stdout.write(JSON.stringify(output) + '\n')
