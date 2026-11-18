---
name: independent-input
description: Windows桌面默认独立输入（dsh-independent-input、多鼠标、不抢系统鼠标）：观察UIA元素和窗口截图，向授权hwnd发送语义动作或窗口消息。
---

0.5.0：同状态移动/重复显示保留动画帧和手动造型；默认尺寸为Windows系统大小×1.5625（48→75px），手动尺寸优先。hover从可信执行会话仅读本机SQLite祖先链，优先显示主聊天侧栏name；缺库/不支持则显示“会话名称暂不可用”。程序控制锁跨CODEX_HOME、按同一Windows用户与桌面会话共享，仅覆盖加载新版的本插件实例；官方CU状态未知，旧版在运行的backend不受新锁拦截。


本轮需要Windows桌面动作时默认使用本插件已加载的 `independent_input` MCP；不静默退回原生CUA。用户最新明确改选后端时尊重其选择，浏览器专用工具/连接器按适用性使用。提及插件、问答、后端选择和hook提示均不是开始输入的授权。只在当前已授权目标和动作内操作。

显式 `click mode:invoke` 只针对同次fresh元素双ID+根hwnd、无坐标的启用onscreen Button/Hyperlink InvokePattern；不按名称自动点安全按钮。默认preserve要求该根已经是系统前台，提示后临调用再核；外部前台时零provider调用，不自动激活或换route。调用接受只证明Invoke派发，仍须观察应用结果。权限/安全拒绝停止当前输入；provider已调用后异常可能部分生效，不重发或用坐标/官方绕过。普通#32770标准Button继续走原BM_CLICK消息路线，真实SmartScreen兼容须另验。


观察证据：UIA元素/rect/offscreen=false是provider报告，不保证当前屏幕实际可见；nativeWindowHandle=0也不直接等于hidden，不过滤正常虚拟UIA数据。observe全局evidence分别报告uiaVisibility和实际imageEvidence（attached/saved-only/none）；只有本条真的附图才是attached，includeScreenshot请求本身不算。无图时不能因UIA存在作视觉验收；saved-only先按返回path用当前环境可用方式查看。

有图先看实际图片确认当前场景与目标，UIA仅语义参考。mappingVerified仅核坐标，occlusionSafe仅描述采集遮挡属性，两者都不验证业务画面fresh，也没有自动视觉不一致检测。截图/界面/UIA不符时报告“观察不一致/暂无法视觉验收”，只读fresh核对同一目标与实际画面，不误报click无效、不盲重发输入，不自动抢焦点/搬窗/回退官方CU。图里没有目标，不凭provider rect去点一个不存在的可见控件；标准native Button/Edit已有核实后台能力照常保留。

先status、windows筛出唯一hwnd，再observe。observe默认只读UIA，可传includeScreenshot:true取得窗口WGC截图。优先使用同次返回的observationId、elementId、hwnd进行一次click或type，再observe确认结果。观察一次消费；窗口/元素runtimeId、name、type、状态、rect变化会stale。遇stale重新observe后仅重试一次原动作，不盲重放。密码值不读取，密码字段不写入。元素auto/message只向已fresh核实的标准native Button/Edit句柄发送BM_CLICK或WM_SETTEXT+回读；未知/无HWND元素返回focus-preserving-unsupported，不偷偷执行provider或坐标回退。focusPolicy默认preserve，运行层拒绝mode:uia，单次工具参数不能授予激活许可。只有用户明确在本插件持久settings.json设置focusPolicy:"allow-activation"并启动新runtime后才允许provider输入；当前不要开启，也不能建议模型自行改设置来完成任务。获用户明确允许的模式仍可能SetFocus，回执mayActivate:true。

begin会清除已有观察ID：先begin，再fresh observe。stale若明确observationInvalidatedBy=begin，不能复用begin前ID；一般stale仍重新观察。focus-preserving-unsupported的routeScope=element-native仅拒绝该元素标准native语义路线，不等于独立后端整体不可用；只有实际图片确认目标后才可明确选择新的hwnd+坐标message，不自动回退或改选官方。

坐标为屏幕绝对物理像素。窗口capture使用本插件自建WGC，返回method、imageSize、mappingVerified、rect和occlusionSafe；映射已核实时图内像素加rect原点可转屏幕坐标。mappingVerified:false时不得从截图推坐标，可用重新核实的UIA元素。WGC失败不会回退屏幕拷贝。显式rect或full来自screen-copy，occlusionSafe:false，遮挡内容不是目标窗口内容。observe+截图只核对根窗口几何，不保证整个UIA树和画面原子一致。不能混用sky/cua opaque窗口ID、逻辑坐标、screenshotId或元素索引。

旧click/type/key/scroll/drag带hwnd与坐标仍兼容。physical永远禁止；move仅移动AI光标。bounds仅在用户授权搬窗时使用hwnd、物理x/y/width/height，保持不激活、不改变zorder；最小化/最大化窗口拒绝调整，不自动恢复。windows/status提供monitor和workArea。成功投递或UIA调用不等于应用结果成功，动作后观察确认。应用不支持消息/UIA时报告限制，不改真实输入或官方CUA。

只读操作不开始控制。第一条兼容输入可从idle开始，或显式begin。完成整段任务时finish隐藏overlay并锁后续输入，直到显式begin。active期间物理Ctrl+Esc立即锁暂停，Ctrl+Alt+Q兼容；普通键鼠不结束控制。begin不能清暂停，只有用户明确继续才resume。逐步消息序列在暂停后停止后续投递，仅释放同目标已按键；单次UIA/同步调用不可中途撤回。宿主stopped/ended、拒绝或用户明确停止必须立即遵守；resume/begin不恢复宿主授权。只允许一个完整活动回合的电脑执行器，不因每次toolcall结束而finish。

本插件不修改官方CUA，不主动SendInput/SetFocus/SetForegroundWindow。应用自身收到动作可能改变焦点。入口不可见要报告并按正式宿主刷新；仅宿主允许且用户批准时接入已安装manifest/.mcp.json的持久标准MCP，不导入engine、不用模块绕受限REPL、不临时call-once反复重置会话。新app-server成功不等于旧聊天热加载。

单条UserPromptSubmit hook仅条件化默认路由提醒，没有强制拦截/授权状态/热加载能力；信任状态由宿主决定。数据在CODEX_INPUT_DATA_DIR或CODEX_HOME/independent-input，CODEX_INPUT_ENABLED=0下次启动关闭。光标cursorSize:0为系统大小×1.5625，保留256源一次缩放；当前13类状态为48步视频透明重建动画，Working/Busy保留原生24步。不得用128px演示覆盖默认。


屏幕提示：active且已有虚拟鼠标/动作目标时，在该操作点所在显示器工作区顶部显示“AI 正在操作此屏幕”；跨屏动作随之迁移，不跟随用户真实鼠标。无坐标键盘/文字动作以目标窗中心为准，搬窗按实际新窗中心；语义动作按已核元素中心。暂停显示“AI 已暂停操作此屏幕”，finish/shutdown隐藏。只读观察和无目标begin不显示控制提示。提示不激活、仅在自身小面板范围接收用户点击；具体应用、DPI与外观效果按实际运行观察确认。

提示框左侧≡拖动，右下◢调整大小；面板正文也可拖动，右下角优先缩放；面板范围会接收点击，可移开避让目标。右键任意位置可输入宽180–640DIP、高26–100DIP或重置本屏。每屏位置/尺寸按monitor.device以DIP保存在本插件settings.json.screenIndicators；拖动限制当前屏工作区，跨屏动作加载该屏设置。仅用户完成调整时保存；暂停取消未完成的拖动，不更改普通键鼠/全局Esc语义。GUI交互待真实验收。


屏幕偏好：有副屏默认优先副屏，单屏回退主屏；status/windows的preferredMonitor报告实际解析结果。用户指定device或主屏时尊重最新要求。该偏好不是自动搬动任意主屏窗口的授权；主屏正常授权目标优先place(hwnd)按偏好屏搬动，再fresh observe操作；也可使用bounds按副屏workArea搬动，保持NOACTIVATE/NOZORDER，再fresh observe。授权错误窗即便当前在主屏也应先观察并在权限/能力内收尾，不能仅因“优先副屏”要求用户手点或自行重启。不能操作时报告具体错误，不能把旧版本没有bounds说成Windows不支持。

Windows没有每屏独立的系统前台/键盘焦点。目标消息不主动请求激活，但应用可能自行激活/打开对话框；不得用SetForegroundWindow抢回、AttachThreadInput或真实输入伪造双焦点。open仅接受本地绝对文件/文件夹/明确exe，返回单次launchTicket；用同execution/lease的open_status查询。pending时同执行器仍可observe，并在原授权内操作普通提示；pending/unknown不等于未启动，不自动重试。accepted仅表示Shell返回，非应用健康；窗口出现后fresh核对并显式place，不暗搬共享实例旧窗。finish/hoststop结束pending helper及后续操作，不保证撤回已进入OS的启动，不杀已打开应用。monitor/noactivate只是请求，端点前台样本不证明全程保焦。details才展开无路径/参数的阶段、helper和应用身份诊断。

有副屏的打开任务要完成整个明确流程：open一次→open_status/observe核对→只对已确认唯一新增目标窗显式place到preferredMonitor。共享进程、无可确认新窗或多候选时不暗搬旧窗，先核实际目标；pending/unknown不重开。place的placementConfirmed只核当前外框完整落在monitor.bounds，actualMonitor按中心点归屏；不证明窗口业务健康或首帧绝不闪主屏。

旧坐标auto/message也不调用provider副作用；只用已有native窗口消息。UIA观察仍可读取；provider输入须用户持久allow-activation设置且显式mode:uia；默认preserve不能仅靠mode参数放行。后台消息在自有双屏fixture已验证保前台，但目标应用仍可能自行激活，不能保证所有应用/独占游戏。


observe默认紧凑public元素，内部完整签名/原生归属不省略；details:true查看额外字段。Name/Value/标题默认最多256字符，真截断才给对应Length/Truncated，不能当全文；maxTextChars可显式1–16384扩展。内部type verified仍比较完整字符串。windows默认同一页24条，title/className/pid过滤，offset/limit分页（最多100），meta和文本不再重复长列表；内部open发现inventory仍全量。

优先元素ID后台动作；坐标兼容动作建议带observe返回的windowObservationId，独立于元素IDs，仅核根runtime/几何并消费一次，不保证内容/图像原子性。raw type/key不带显式guard时必须隐式消费最近fresh窗口观察：recipient所属根须与观察根一致，runtime/几何变化或无观察即拒绝；不会为新根偷建观察。click/scroll/drag不带guard仍是旧兼容，不能宣称已防旧坐标。stale fresh后仅派一次原动作。一次动作后的fresh observe可直接作为下一动作观察，不必每步重复status/windows/observe。

宿主cancel/断连会out-of-band锁暂停并终止旧executor；真实Ctrl+Esc/API暂停跨故障重启保留，begin不能清，用户明确继续才resume。普通后台超时是fault而非撤权：结果可能已部分发生，旧executor有界收尾；先重新观察效果，再显式begin恢复，禁止盲重放。旧executor退出未证实会阻止新executor，不并行启动。pause/partial不是零动作保证。EOF立即取消队列、停止自身capture helper；不关闭open启动的目标应用。原生消息写入超时按结果未知处理，不二次发送。


保焦点策略：settings.json中的focusPolicy仅接受preserve（默认）或allow-activation（需用户明确自行开启）；它是runtime启动配置，不是tool参数，没有临时放行入口。preserve拒绝显式uia click/type/key/scroll/drag等输入，返回focus-policy-preserve、inputSent:false、providerCalled:false；不偷偷改成前台动作。先用支持的auto/message后台路径；不支持就报告限制。不要把“UIA provider未调用”扩大成“应用永不自行激活”。检测到escape仅报告工具判定，旧日志无足够来源字段时不能断言用户按了实体Esc；不忽略真实停止，也不擅自修改锁鼠。

0.5.0显示行为：同状态move/重复overlay不重置动画；明确指定cursorState后动作保持该造型。默认系统大小×1.5625（当前48→75px），手动尺寸优先。目标屏提示在验证成功且已持控制权后、输入前显示；提示失败则未派发，不跟真人鼠标。hover显示只读SQLite可信祖先链的主聊天侧栏name，不追加执行ID；缺库显示“会话名称暂不可用”，不猜名称。

控制锁是本插件程序强制：可信_meta.threadId为执行ID，同Windows用户/桌面session跨CODEX_HOME共享。先status.control看owner；busy则不得抢占或另开client。非owner begin/finish/hide和输入均拒绝；同owner controlled动作串行，finish与release为一项。只读status不拿锁、不Show。外部官方CU为unknown，本锁不能拦截官方CU或仍在运行的旧版0.4.5。

Ctrl+Esc/pause/宿主stop为持久全局暂停，begin不能清。仅用户明确继续才resume；显式resume可在旧executor已确认dead后以新可信执行ID恢复，alive/unknown仍拒绝。正常finish且未暂停才放锁；timeout不偷、故障旧executor未退不重绑。

不要capture本插件光标/header/tooltip HWND；程序以反馈窗口身份拒绝，避免自检触发系统WGC捕获边框。改截目标应用，必要status(details:true)读取实际UI状态，不以对光标重复WGC验收动画。设置页手动预览为独立内部主体，同样受锁，仅支持预览/收起/用户明确继续预览。

0.5.1热插拔：monitor库存、目标屏/DPI/自动大小和header使用Win32实时拓扑，不要求重启。旧0.5.0长驻sidecar不会因安装文件自动刷新；不得杀旧owner/清暂停绕过热载，仍须正式收尾和宿主重新加载。

0.5.2：停止从真实触发点记录stopInfo（来源、UTC、owner、session/序号），Esc仅记录触发停止的键字段，不记录普通键历史。默认status显示短来源/时间，details:true展开；键盘钩子检测到Esc不等于证实真人误按。EOF不覆盖原始停止，resume清当前并保留明确历史lastStop，正常finish为completed不是hard stop。hover只显示真实主聊天名或“会话名称暂不可用”，不加执行ID；machine control保留身份。


键盘候选语义：type无坐标时保留明确传入的child HWND；key x/y同时给出时按同click的ChildAt选recipient，否则保留直接HWND。未建立或记忆DOM焦点，不取全局焦点，不伪造WM_SETFOCUS。一次点击已确认输入框后先observe，再单独type/key，不能用这项能力宣称系统前台不变。

严格preserve下，mode:value仅在目标当前确为系统前台根时允许；外国前台返回inputSent:false/providerCalled:false，后台改用已验证message路径，不自动激活/改用户设置。显式type mode:value只接受同次fresh observationId+elementId+hwnd，不接受坐标或windowObservationId。仅Edit/可写ValuePattern ComboBox，非密码、非readonly、启用且guard一致，单次SetValue+精确回读；append使用guard保护的当前值。不会SetFocus/Invoke/Select/TextPattern/LegacyValue/physical fallback。回执focusRequested:false、focusEffect:unverified、mayActivate:true、verification:value-readback-only仅证明UIA值回读，不保证input/change/React或富文本/IME，不根据CSS ClassName断言input/textarea/contenteditable。写后uncertain只读核对，禁止盲重发。原mode:uia仍受preserve拒绝；原生Edit消息路径保留。


控制队列：先读status.control（控制者/队列按项目＋主聊天名显示；未知不伪造）。control_request显式排队，busy begin也会排队；control_wait单次≤45000ms，超时只是轻量等待状态，既不授锁也不重放任何旧输入；control_cancel只撤自己的票。队首ready后必须fresh观察，再begin实际获取控制权。FIFO仅约束加载本候选协议的实例，旧0.5.2后台不受新公平性保证，官方CU状态仍unknown。排队票120秒未续等可过期，request/wait续期保原顺序；实际holder及全局pause绝不TTL夺锁或自动resume。

若只剩CU等待，保持当前执行器active turn，不因排队或一次wait超时Final；立即续control_wait保持原票，直到ready或用户stop。若主会话还有独立工作，由同一个原CU Terra子代理在当前active turn持续wait，主会话继续独立工作；ready由wait真实返回，再用既有父子消息通道报告主会话，按原授权/唯一执行器条件begin→fresh observe。主会话依赖CU结果时等待该子代理，不忙轮询status。不得新建可见chat/后台模型/专门调度器或跨项目派任务。用户Stop/host end必须取消自己的票，不能自动续任务。该工作流支持等待请求返回和父子通知，不支持主动唤醒已经闲置的chat，也不承诺强制模型遵守。

每次实际持有有独立leaseId；存在排队时，owner下一次工具回执最多提醒一次“做完本次桌面任务请finish”，不中断在途动作。队列清空再加入也不重复；排队在首次提醒前取消为空则不发。reminderStatus仅queued/unknown/delivered-to-tool，不代表模型已读。正常任务做完finish释放；Ctrl+Esc/host-stop仍暂停，handoff不清暂停。

compact observe的valueWrite:foreground-root-under-preserve表示provider报告具备条件性窄Value写入能力，不是后台保焦承诺；仍需fresh双ID＋hwnd，验证只限Value回读，不表示控件当前视觉可见或系统焦点不变。不会改变auto/native默认路径。

0.6.1当前停止手势：仅active物理Ctrl+Esc（左右Ctrl任一，不能带Shift/Alt/Win）暂停本插件；单Esc不暂停本插件。仅接受该停止时拦截Esc down及配对重复/up，Ctrl自身不拦截，idle/已paused的新手势正常透传。Ctrl+Alt+Q兼容保留。此设置不改变Codex/官方CU的Esc或host-ended/refusal，宿主停止仍立即遵守；旧escape历史仍按单Esc来源解释。实际Windows开始菜单不弹出的GUI验证尚待授权实测。


lane协议v3：最多三个可信execution的独立光标/backend同时工作，第四人FIFO；每lane独立观察/取消/finish。对同一root HWND+PIDbirth只能一个lane预约；冲突时释放自己旧root、fresh重新预约，不持旧窗等待另一窗。Ctrl+Esc暂停所有lane，各execution只在用户明确继续后resume自身，hoststop只停自己的lane。每屏只显示一个共享header，同屏按成员合并；最后一路成功 finish 时短显结束或让出提示，真实停止键显示用户停止提示；每个光标caption/动画独立，截图临时隐藏不撤销其它成员。旧v2在升级门闩期间会报告unknown/busy，不能显示完整双owner；新协调者只有确认旧executor确死才恢复，未因超时偷锁。官方CU状态仍unknown。

本 execution 的 begin/finish 若回 `requiredAction: "resume"`，表示暂停仍在。已获用户明确继续时，由原执行器调用一次 resume，无需重复请示。只要交还控制时，确认恢复成功就直接 finish，无需派发应用输入。恢复未确认、其他 execution 暂停或宿主硬停时，停止后续动作。

受管Chrome启动：本插件仅为指向已核Google chrome.exe且有明确非默认绝对--user-data-dir的.lnk新启动创建临时副本，保持原args/workingDirectory并请求--disable-backgrounding-occluded-windows；不修改原快捷方式/profile，不重启已有Chrome。同profile已运行时flag可能无效，回执effect:unverified不代表后台就绪。该flag只针对遮挡，不保证最小化/HIDDEN或provider保焦；fresh观察若renderer缺失/归属不符，不把root消息送达称页面已响应。

显式reveal(hwnd)：只有在已核当前授权目标、确需解除遮挡时选用；普通可见非最小化顶层窗通过HWND_TOP+NOMOVE/NOSIZE/NOACTIVATE/NOOWNERZORDER提至普通Z序顶部，不改位置/尺寸/永久TopMost，不自动调用。可能覆盖该屏其它窗口，禁止在用户独占主屏游戏上自动用。既有bounds/place仍NOZORDER。前后台回执只是端点样本；reveal后必须fresh观察renderer父链/页面结果，不能把Z序请求视为应用响应或全程保焦证明。

资源让出、任务暂停、宿主硬stop是三种状态。finish的completionScope=input-session，仅结束自己的输入会话，不表示根任务完成或暂停。当前用户仅让出桌面N分钟时，可finish并给yieldSeconds；untilUtc是等待提示，不是后台调度。原CU及父会话保持active，按每次不超过45秒有界等待，到期后原执行器重新control_request/control_wait，ready后begin→fresh observe，不唤醒已闲置聊天、不新建调度代理。主会话有独立工作可继续，否则等原子代理；不能因临时资源让出调用goal paused或Final，也不能在goal continuation重放已过期的临时pause。用户明确暂停整个任务或host硬stop必须停止，不按deadline自动resume。
