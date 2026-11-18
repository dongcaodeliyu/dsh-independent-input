# 独立 WGC 窗口截图 helper

仅使用 Windows.Graphics.Capture 的 CreateForWindow 获取指定窗口；不输入、不激活、不恢复窗口，不关闭系统捕获边框，不调用官方 CU helper。不会回退屏幕采样。

## 构建

在 Windows x64 开发者命令行运行 `build.cmd`，或直接由脚本通过 vswhere 定位已安装的 Visual Studio C++ 工具。需要现有 Windows SDK 的 C++/WinRT、WIC 与 D3D11。构建使用 C++17、/MT 静态 CRT，输出 `bin/win-x64/dsh-window-capture.exe`。无需安装额外运行时。新 MSVC 的实验 coroutine 弃用诊断被显式静默，以兼容 SDK 中 C++17 C++/WinRT 头。

## CLI

```
dsh-window-capture.exe --probe
dsh-window-capture.exe --hwnd 123456 --path C:\absolute\capture.png --timeout-ms 5000
```

`--probe` 仅查询系统能力和 API 元数据，不获取窗口、不截图。截图 timeout 范围 1–60000 ms，默认 5000。目标 PNG 父目录须已存在；成功原子替换目标文件。stdout 为一行 UTF-8 JSON；退出码 0 成功、1 失败、构建环境错误为脚本退出码 2。

成功字段：`ok`, `path`, `sourceHwnd`（十进制字符串），`captureBackend: "wgc-window"`, PNG 实际 `width` / `height`, `occlusionSafe: true`, `mappingVerified`, `mappingSource`, `screenRect`。

`occlusionSafe` 描述窗口捕获 API，不代表已人工验收图像。使用每监视器 V2 DPI 上下文，以帧 ContentSize 精确匹配 DWM extended frame bounds，次选 GetWindowRect；匹配时 screenRect 为物理屏幕像素 `{x,y,width,height}`。无法精确匹配时 `mappingVerified:false`, `mappingSource:"unverified"`, `screenRect:null`；此图仅可视觉使用，调用方必须重新观察，禁止据其派发坐标输入。helper 不编造比例。

失败字段：`ok:false`, `reason`，API 错误可带十六进制 `hresult`。包括 invalid_arguments、window_closed、window_hidden、window_minimized、window_cloaked、window_capture_protected、window_empty、window_geometry_failed、window_geometry_changed_reobserve、wgc_unsupported、capture_timeout、frame_size_invalid、png_format_unsupported、capture_api_failed、capture_failed。受保护内容不保证都可由 display affinity 检出，系统可拒绝或不给帧；不将黑色图像作为唯一无效判据。

获取帧前后及 PNG 提交前检查窗口矩形变化；变化时返回 fresh-observe 错误并清理临时 PNG。检查只证明采样时几何一致，调用方输入前仍须遵守其观察新鲜度契约。图像通过 GPU staging 行距交给 WIC，编码器只写实际宽度像素；不把 GPU padding 当图像宽度。

## 验证范围

`test-cli.ps1` 只执行 probe、参数错误、无效 HWND，不捕获任何用户窗口。真实窗口被遮挡时的内容、DPI 映射、最小化、resize 和生命周期验收由协调的唯一 Terra 对自有 fixture 统一进行；编译/probe 不代表这些已通过。

Microsoft 参考：[CreateForWindow](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)、[CreateFreeThreaded](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded?view=winrt-26100)。
