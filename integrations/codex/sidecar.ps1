# dsh-independent-input sidecar
# Windows PowerShell 5.1, STA. 一条 JSON 一行请求/响应。
# 设计目标：默认不碰主人的真实光标和键盘焦点（UIA / 窗口消息），
# 物理输入只作为显式回退，并且主人一碰鼠标键盘就立刻暂停、还原光标。

. (Join-Path $PSScriptRoot 'lib/executor-bootstrap.ps1')
Wait-ExecutorPermit
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

# AI 光标模式：companion = 一直陪着；clean = 用一下就收。
# 插件 config / 环境变量都可以改，运行中还能用 setCursorMode 切换。
$script:focusPolicy = if($env:DSH_INPUT_FOCUS_POLICY -ceq 'allow-activation'){'allow-activation'}else{'preserve'}
$script:cursorMode = if ($env:DSH_INPUT_CURSOR_MODE -eq 'clean') { 'clean' } else { 'companion' }
$script:cursorHoldMs = 2600
if ($env:DSH_INPUT_CURSOR_HOLD_MS) {
  try { $script:cursorHoldMs = [int]$env:DSH_INPUT_CURSOR_HOLD_MS } catch { }
}
# AI 光标大小：0跟随目标屏Windows光标尺寸，24–192手动覆盖。
# GPT娘素材保留原256px帧，仅在最终显示尺寸做一次高质量缩放。
$script:cursorSize = 0
if ($env:DSH_INPUT_CURSOR_SIZE) {
  try { $script:cursorSize = [int]$env:DSH_INPUT_CURSOR_SIZE } catch { }
}
if ($script:cursorSize -ne 0 -and $script:cursorSize -lt 24) { $script:cursorSize = 24 }
if ($script:cursorSize -gt 192) { $script:cursorSize = 192 }
# AI 光标样式：主人给的 15 只光标里选一只。
$script:styleNames = @('pointer','work','unavailiable','link','text','cross','busy','move','vert','horz','help','handwriting','dgn1','dgn2','alternate')
$script:cursorStyle = 'pointer'
if ($env:DSH_INPUT_CURSOR_STYLE) {
  $wanted = ([string]$env:DSH_INPUT_CURSOR_STYLE).ToLower()
  if ($script:styleNames -contains $wanted) { $script:cursorStyle = $wanted }
}

# 先声明 DPI 感知，再加载 WinForms / UIA。否则高 DPI 屏上截图坐标和
# UIA FromPoint 会差一个缩放比，点不中目标。
$dpiCode = @'
using System;
using System.Runtime.InteropServices;
public static class DshDpiBootstrap {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Apply() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@
try { Add-Type -TypeDefinition $dpiCode; [DshDpiBootstrap]::Apply() } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$script:uia = $true
$script:uiaProxyRegistered = $false
$script:uiaProxyError = $null
try {
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  try {
    $proxyPath = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'WPF\UIAutomationClientsideProviders.dll'
    $proxyAssembly = [Reflection.AssemblyName]::GetAssemblyName($proxyPath)
    # .NET ProxyManager scans caller ReflectedType; keep a real, non-inlined
    # managed frame ahead of PowerShell DLR frames during cold proxy loading.
    Add-Type -ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location) -TypeDefinition @"
public static class DshUiaProxyBootstrap {
  [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
  public static void Register(System.Reflection.AssemblyName name) {
    System.Windows.Automation.ClientSettings.RegisterClientSideProviderAssembly(name);
  }
}
"@
    [DshUiaProxyBootstrap]::Register($proxyAssembly)
    $script:uiaProxyRegistered = $true
  } catch { $script:uiaProxyError = $_.Exception.ToString() }
} catch {
  $script:uia = $false
  $script:uiaProxyError = $_.Exception.ToString()
}

$refs = @(
  [System.Windows.Forms.Form].Assembly.Location,
  [System.Drawing.Bitmap].Assembly.Location,
  [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,
  [System.Drawing.Point].Assembly.Location
)

$cs = @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class DshInput
{
    public const int WH_KEYBOARD_LL = 13;
    public const int WH_MOUSE_LL = 14;

    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP = 0x0101;
    public const int WM_CHAR = 0x0102;
    public const uint WM_SETTEXT = 0x000C;
    public const uint WM_GETTEXT = 0x000D;
    public const uint WM_GETTEXTLENGTH = 0x000E;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int WM_SYSKEYUP = 0x0105;
    public const int WM_MOUSEMOVE = 0x0200;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const int WM_LBUTTONDBLCLK = 0x0203;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP = 0x0205;
    public const int WM_RBUTTONDBLCLK = 0x0206;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_HOTKEY = 0x0312;
    public const int WM_QUIT = 0x0012;

    public const int MK_LBUTTON = 0x0001;
    public const int MK_RBUTTON = 0x0002;

    public const int GW_OWNER = 4;
    public const int GA_ROOT = 2;
    public const int GWL_STYLE = -16;

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    public const int SW_RESTORE = 9;
    public const int SWP_NOACTIVATE = 0x0010;
    public const int SWP_SHOWWINDOW = 0x0040;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    public const uint LLMHF_INJECTED = 0x00000001;
    public const uint LLKHF_INJECTED = 0x00000010;

    public const int MOD_ALT = 0x0001;
    public const int MOD_CONTROL = 0x0002;
    public const int MOD_NOREPEAT = 0x4000;
    public const int VK_MENU = 0x12;
    public const int VK_Q = 0x51;
    public const int HOTKEY_ID = 0x4453;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr ChildWindowFromPointEx(IntPtr hWnd, POINT pt, uint flags);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
    [DllImport("user32.dll")]
    public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
    // Do not use WinForms Screen's process-wide topology cache: a long-lived
    // sidecar can miss display changes before/without its overlay message pump.
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct MONITORINFOEX { public int cbSize; public RECT monitor,work; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device; }
    delegate bool MonitorEnumProc(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data);
    [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorEnumProc callback,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetMonitorInfoW(IntPtr monitor,ref MONITORINFOEX info);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT rect,uint flags);
    public sealed class MonitorSnapshot {
        public string DeviceName; public Rectangle Bounds,WorkingArea; public bool Primary; public uint Dpi; public IntPtr Handle;
    }
    static MonitorSnapshot ReadMonitor(IntPtr handle) {
        if(handle==IntPtr.Zero)throw new InvalidOperationException("monitor-unavailable");
        var info=new MONITORINFOEX {cbSize=Marshal.SizeOf(typeof(MONITORINFOEX))};
        if(!GetMonitorInfoW(handle,ref info))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"GetMonitorInfo failed");
        uint dx=96,dy=96;try{if(GetDpiForMonitor(handle,0,out dx,out dy)!=0)dx=96;}catch{dx=96;}
        return new MonitorSnapshot {Handle=handle,DeviceName=info.device,Primary=(info.flags&1)!=0,Dpi=dx==0?96:dx,
            Bounds=Rectangle.FromLTRB(info.monitor.Left,info.monitor.Top,info.monitor.Right,info.monitor.Bottom),
            WorkingArea=Rectangle.FromLTRB(info.work.Left,info.work.Top,info.work.Right,info.work.Bottom)};
    }
    public static MonitorSnapshot[] EnumerateMonitors() {
        var result=new List<MonitorSnapshot>();Exception failure=null;
        MonitorEnumProc collect=delegate(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data){try{result.Add(ReadMonitor(monitor));return true;}catch(Exception e){failure=e;return false;}};
        bool ok=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,collect,IntPtr.Zero);
        GC.KeepAlive(collect);
        if(failure!=null)throw failure;
        if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"EnumDisplayMonitors failed");
        if(result.Count==0)throw new InvalidOperationException("no-monitor");
        return result.ToArray();
    }
    public static MonitorSnapshot MonitorAtPoint(int x,int y) {return ReadMonitor(MonitorFromPoint(new POINT {X=x,Y=y},2));}
    public static MonitorSnapshot MonitorAtRectangle(Rectangle rect) {var r=new RECT {Left=rect.Left,Top=rect.Top,Right=rect.Right,Bottom=rect.Bottom};return ReadMonitor(MonitorFromRect(ref r,2));}
    public static MonitorSnapshot PreferredMonitor(string preference) {
        var monitors=EnumerateMonitors();
        foreach(var monitor in monitors)if((string.Equals(preference,"primary",StringComparison.OrdinalIgnoreCase)&&monitor.Primary)||string.Equals(preference,monitor.DeviceName,StringComparison.OrdinalIgnoreCase))return monitor;
        foreach(var monitor in monitors)if(!monitor.Primary)return monitor;
        foreach(var monitor in monitors)if(monitor.Primary)return monitor;
        return monitors[0];
    }
    public static Rectangle VirtualBounds() {var monitors=EnumerateMonitors();Rectangle bounds=monitors[0].Bounds;for(int i=1;i<monitors.Length;i++)bounds=Rectangle.Union(bounds,monitors[i].Bounds);return bounds;}
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);

    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);

    public static uint DpiAt(int x, int y) { return MonitorAtPoint(x,y).Dpi; }

    public static int CursorSizeAt(int x, int y)
    {
        try { return Math.Max(24, Math.Min(192, GetSystemMetricsForDpi(13, DpiAt(x, y)))); }
        catch { return Math.Max(24, Math.Min(192, GetSystemMetrics(13))); }
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", EntryPoint = "PostMessageW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern IntPtr SendMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern IntPtr SendMessageReadW(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)]
    static extern IntPtr SendMessageValueW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern IntPtr SetWindowLongPtrW(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    static readonly DateTime StartTime = DateTime.UtcNow;
    static long lastUserInputTicks = 0;
    static long lastInjectedTick = 0;

    public static volatile bool Paused = false;
    static volatile bool sessionActive = false;
    public static bool SessionActive { get { return sessionActive; } set { lock(stopSync) { if(value&&!sessionActive) capturedStopEscape=false; sessionActive=value; } } }
    static bool capturedStopEscape=false;
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    public static volatile bool PhysicalActive = false;
    public static string PauseReason = "";
    public static int UserActiveMs = 800;
    static bool AllowPhysicalMouse = false;

    static readonly object heldLock = new object();
    static readonly List<ushort> heldKeys = new List<ushort>();
    static bool leftDown = false;
    static bool rightDown = false;

    static POINT savedCursor;
    static bool hasSavedCursor = false;

    static IntPtr mouseHook = IntPtr.Zero;
    static IntPtr keyHook = IntPtr.Zero;
    static Thread hookThread = null;
    static uint hookThreadId = 0;
    static Thread hotkeyThread = null;
    static uint hotkeyThreadId = 0;
    static LowLevelProc mouseProc = MouseHookProc;
    static LowLevelProc keyProc = KeyHookProc;
    public static bool HotkeyRegistered = false;
    public static bool EscapeHookRegistered = false;
    static IntPtr escapeHook = IntPtr.Zero;
    static LowLevelProc escapeProc = EscapeHookProc;

    static DshInput()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }
        int size = Marshal.SizeOf(typeof(INPUT));
        if (IntPtr.Size == 8 && size != 40) throw new Exception("INPUT size " + size + " is not 40");
    }

    public static long LastUserInputAgeMs()
    {
        try
        {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (GetLastInputInfo(ref info))
            {
                uint now = (uint)(GetTickCount64() & 0xFFFFFFFF);
                return (long)((now - info.dwTime) & 0xFFFFFFFF);
            }
        }
        catch { }
        long last = Interlocked.Read(ref lastUserInputTicks);
        if (last == 0) return -1;
        return (long)((DateTime.UtcNow.Ticks - last) / TimeSpan.TicksPerMillisecond);
    }

    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool SetPropW(IntPtr hwnd,string name,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetPropW(IntPtr hwnd,string name);
    public static void MarkFeedback(IntPtr hwnd) { SetPropW(hwnd,"DSH.IndependentInput.Feedback.v1",new IntPtr(0x445348)); }
    public static bool IsFeedbackWindow(IntPtr hwnd) { return GetPropW(hwnd,"DSH.IndependentInput.Feedback.v1")==new IntPtr(0x445348); }
    public static int AutoDisplaySize(int baseSize) {return (int)Math.Round(baseSize*1.5625,MidpointRounding.AwayFromZero);}
    public static int AutoDisplaySizeAt(int x,int y) {return AutoDisplaySize(CursorSizeAt(x,y));}

    public static bool TryCursorPos(out int x,out int y) {POINT p;bool ok=GetCursorPos(out p);x=p.X;y=p.Y;return ok;}

    public static int[] CursorPos()
    {
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    public static void SetUserActiveMs(int ms)
    {
        if (ms < 0) ms = 0;
        UserActiveMs = ms;
    }

    static void TouchUserInput()
    {
        Interlocked.Exchange(ref lastUserInputTicks, DateTime.UtcNow.Ticks);
    }

    public static void SimulateUserInput()
    {
        TouchUserInput();
    }

    static IntPtr MouseHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((data.flags & LLMHF_INJECTED) == 0)
            {
                TouchUserInput();
            }
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    static IntPtr KeyHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((data.flags & LLKHF_INJECTED) == 0)
            {
                TouchUserInput();
            }
        }
        return CallNextHookEx(keyHook, nCode, wParam, lParam);
    }

    static readonly object stopSync=new object();
    public static Dictionary<string,object> StopInfo=null,LastStop=null;
    static string stopSessionId=Guid.NewGuid().ToString("N");static long stopSequence=0;
    static string stopOwnerExecutionId=null,stopOwnerRootId=null,stopOwnerName="会话名称暂不可用";
    public static void SetStopOwner(string json) {
        if(string.IsNullOrEmpty(json))return;
        var owner=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json);
        object v;stopOwnerExecutionId=owner.TryGetValue("executionId",out v)&&v!=null?Convert.ToString(v):null;
        stopOwnerRootId=owner.TryGetValue("rootId",out v)&&v!=null?Convert.ToString(v):null;
        stopOwnerName=owner.TryGetValue("name",out v)&&v!=null?Convert.ToString(v):"会话名称暂不可用";
    }
    public static void RestoreStop(string json) {if(string.IsNullOrEmpty(json))return;StopInfo=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json);LastStop=StopInfo;}
    static Thread sharedPauseThread;static EventWaitHandle sharedPauseEvent;static volatile bool stopSharedPause;
    public static void StartSharedPause() {
        string name=Environment.GetEnvironmentVariable("DSH_INPUT_PAUSE_EVENT"),path=Environment.GetEnvironmentVariable("DSH_INPUT_SHARED_STOP_FILE"),execution=Environment.GetEnvironmentVariable("DSH_INPUT_EXECUTION_ID");
        if(string.IsNullOrEmpty(name)||string.IsNullOrEmpty(path)||string.IsNullOrEmpty(execution)||sharedPauseThread!=null)return;
        sharedPauseEvent=new EventWaitHandle(false,EventResetMode.AutoReset,name);stopSharedPause=false;
        sharedPauseThread=new Thread(delegate(){bool signaled=false;
            while(!stopSharedPause){
                bool recognized=false,readFailed=false;
                try {
                    var json=new System.Web.Script.Serialization.JavaScriptSerializer();var state=json.Deserialize<Dictionary<string,object>>(System.IO.File.ReadAllText(path));
                    object list;if(state.TryGetValue("lanes",out list))foreach(object item in (System.Collections.IEnumerable)list){var lane=(Dictionary<string,object>)item;
                        if(Convert.ToString(lane["executionId"])!=execution)continue;
                        object value;Dictionary<string,object> info=null;
                        // A newly rebuilt executor is awaiting its own explicit resume.
                        // A new desktop stop clears resuming and must still win.
                        if(lane.TryGetValue("resuming",out value)&&Convert.ToBoolean(value))continue;
                        if(Convert.ToBoolean(lane["paused"]))info=lane["stopInfo"] as Dictionary<string,object>;
                        else if(lane.TryGetValue("controllerFault",out value))info=value as Dictionary<string,object>;
                        if(info!=null&&info.ContainsKey("reason")&&info.ContainsKey("source")){recognized=true;if(!Paused){RecordStop(Convert.ToString(info["reason"]),Convert.ToString(info["source"]),null);RestoreStop(json.Serialize(info));EmitPauseState();ReleaseAll();DshOverlay.SetPaused(true);}}
                    }
                }catch{readFailed=true;}
                if((readFailed||signaled&&!recognized)&&!Paused){RecordStop("backend-control-state-unavailable","backend-control-state-unavailable",null);EmitPauseState();ReleaseAll();DshOverlay.SetPaused(true);}
                sharedPauseEvent.WaitOne();
                signaled=true;
            }
        });sharedPauseThread.IsBackground=true;sharedPauseThread.Start();
    }
    static string StopSource(string reason) {return reason.StartsWith("backend-timeout")?"backend-timeout":reason.StartsWith("backend-")?reason.Split(':')[0]:reason=="transport-eof"?"transport-eof":reason=="host-cancel"?"host-cancel":reason=="permission-refusal"?"permission-refusal":reason=="api"?"manual-tool":reason=="hotkey"?"keyboard-hotkey":"host-interrupt";}
    public static bool RecordStop(string reason,string source,Dictionary<string,object> keyboard) {
        lock(stopSync) {
            if(Paused)return false;
            StopInfo=new Dictionary<string,object> {{"reason",reason},{"source",source},{"kind",source.StartsWith("backend-")?"fault":"pause"},{"utcTimestamp",DateTime.UtcNow.ToString("o")},{"ownerExecutionId",stopOwnerExecutionId},{"ownerRootId",stopOwnerRootId},{"ownerName",stopOwnerName},{"sessionId",stopSessionId},{"sequence",++stopSequence}};
            if(keyboard!=null)StopInfo["keyboard"]=keyboard;
            LastStop=StopInfo;PauseReason=reason;Paused=true;return true;
        }
    }
    public static bool RecordKeyStop(uint vkCode,uint scanCode,uint flags,int eventType,bool leftControl,bool rightControl,bool otherModifiers) {
        if(!SessionActive||Paused||otherModifiers||(!leftControl&&!rightControl)||(eventType!=WM_KEYDOWN&&eventType!=WM_SYSKEYDOWN)||vkCode!=0x1B||(flags&LLKHF_INJECTED)!=0)return false;
        return RecordStop("control-escape","keyboard-hook",new Dictionary<string,object>{{"gesture","Ctrl+Esc"},{"leftControl",leftControl},{"rightControl",rightControl},{"vkCode",vkCode},{"scanCode",scanCode},{"flags",flags},{"injected",false},{"eventType",eventType}});
    }
    // 0=pass, 1=accepted stop+consume, 2=consume the accepted Esc repeat/up.
    // Ctrl keys and arbitrary keyboard contents are neither captured nor logged.
    public static int FilterStopKey(uint vkCode,uint scanCode,uint flags,int eventType,bool leftControl,bool rightControl,bool otherModifiers) {
        if(vkCode!=0x1B||(flags&LLKHF_INJECTED)!=0)return 0;
        lock(stopSync) {
            if(capturedStopEscape) {
                if(eventType==WM_KEYUP||eventType==WM_SYSKEYUP){capturedStopEscape=false;return 2;}
                if(eventType==WM_KEYDOWN||eventType==WM_SYSKEYDOWN)return 2;
            }
            if(RecordKeyStop(vkCode,scanCode,flags,eventType,leftControl,rightControl,otherModifiers)){capturedStopEscape=true;return 1;}
            return 0;
        }
    }
    static IntPtr EscapeHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if(nCode>=0) {
            KBDLLHOOKSTRUCT data=(KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam,typeof(KBDLLHOOKSTRUCT));
            if(data.vkCode==0x1B&&(data.flags&LLKHF_INJECTED)==0) {
                bool left=(GetAsyncKeyState(0xA2)&0x8000)!=0,right=(GetAsyncKeyState(0xA3)&0x8000)!=0;
                bool other=(GetAsyncKeyState(0x10)&0x8000)!=0||(GetAsyncKeyState(0x12)&0x8000)!=0||(GetAsyncKeyState(0x5B)&0x8000)!=0||(GetAsyncKeyState(0x5C)&0x8000)!=0;
                int disposition=FilterStopKey(data.vkCode,data.scanCode,data.flags,wParam.ToInt32(),left,right,other);
                if(disposition==1)ThreadPool.QueueUserWorkItem(delegate {EmitPauseState();if(Paused&&PauseReason=="control-escape")DshOverlay.SetPaused(true);});
                if(disposition!=0)return new IntPtr(1);
            }
        }
        return CallNextHookEx(escapeHook,nCode,wParam,lParam);
    }

    public static void StartHotkey()
    {
        if(Environment.GetEnvironmentVariable("DSH_INPUT_READONLY")=="1") return;
        if(Environment.GetEnvironmentVariable("DSH_INPUT_EXTERNAL_HEADERS")=="1") return;
        if (hotkeyThread != null) return;
        hotkeyThread = new Thread(HotkeyThreadProc);
        hotkeyThread.IsBackground = true;
        hotkeyThread.SetApartmentState(ApartmentState.STA);
        hotkeyThread.Start();
    }

    static void HotkeyThreadProc()
    {
        hotkeyThreadId = GetCurrentThreadId();
        escapeHook = SetWindowsHookEx(WH_KEYBOARD_LL, escapeProc, GetModuleHandle(null), 0);
        EscapeHookRegistered = escapeHook != IntPtr.Zero;
        try
        {
            HotkeyRegistered = RegisterHotKey(IntPtr.Zero, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_Q);
        }
        catch { HotkeyRegistered = false; }
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.message == WM_HOTKEY && msg.wParam.ToInt32() == HOTKEY_ID)
            {
                TogglePause("hotkey");
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnregisterHotKey(IntPtr.Zero, HOTKEY_ID);
        if (escapeHook != IntPtr.Zero) { UnhookWindowsHookEx(escapeHook); escapeHook = IntPtr.Zero; }
        EscapeHookRegistered = false;
        HotkeyRegistered = false;
        hotkeyThreadId = 0;
    }

    public static void StopHotkey()
    {
        if (hotkeyThreadId != 0)
        {
            PostThreadMessage(hotkeyThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            hotkeyThreadId = 0;
        }
        hotkeyThread = null;
    }

    public static void StartHooks()
    {
        if(Environment.GetEnvironmentVariable("DSH_INPUT_READONLY")=="1") return;
        if(Environment.GetEnvironmentVariable("DSH_INPUT_EXTERNAL_HEADERS")=="1") return;
        if (hookThread != null) return;
        hookThread = new Thread(HookThreadProc);
        hookThread.IsBackground = true;
        hookThread.SetApartmentState(ApartmentState.STA);
        hookThread.Start();
    }

    static void HookThreadProc()
    {
        hookThreadId = GetCurrentThreadId();
        IntPtr hmod = GetModuleHandle(null);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, hmod, 0);
        if (mouseHook == IntPtr.Zero) mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, IntPtr.Zero, 0);
        keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, hmod, 0);
        if (keyHook == IntPtr.Zero) keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, IntPtr.Zero, 0);

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (keyHook != IntPtr.Zero) { UnhookWindowsHookEx(keyHook); keyHook = IntPtr.Zero; }
        hookThreadId = 0;
    }

    public static void StopHooks()
    {
        if (hookThreadId != 0)
        {
            PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            hookThreadId = 0;
        }
        hookThread = null;
    }

    public static void TogglePause(string reason)
    {
        if (Paused) Resume();
        else Pause(reason);
    }

    public static void Pause(string reason)
    {
        Dictionary<string,object> key=reason=="hotkey"?new Dictionary<string,object>{{"vkCode",VK_Q},{"scanCode",null},{"flags",null},{"injected",null},{"eventType","WM_HOTKEY"}}:null;
        RecordStop(reason,StopSource(reason),key);
        EmitPauseState();
        ReleaseAll();
        DshOverlay.SetPaused(true);
    }

    public static void Resume()
    {
        if(TransportInterrupted || TransportEnded) { Paused=true; EmitPauseState(); return; }
        lock(stopSync) {Paused=false;PauseReason="";StopInfo=null;}
        EmitPauseState();
        DshOverlay.SetPaused(false);
    }
    public static void EmitPauseState() {
        lock(stopSync) {try { Console.Out.WriteLine(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new { @event="pause-state",paused=Paused,reason=PauseReason,stopInfo=StopInfo,lastStop=LastStop,transportSealed=TransportInterrupted||TransportEnded })); Console.Out.Flush(); } catch {}}
    }

    public static void ReleaseAll()
    {
        lock (heldLock)
        {
            for (int i = heldKeys.Count - 1; i >= 0; i--)
            {
                try { SendKeyRaw(heldKeys[i], false, false); } catch { }
            }
            heldKeys.Clear();
            if (leftDown) { try { SendMouseRaw(MOUSEEVENTF_LEFTUP, 0, 0, 0); } catch { } leftDown = false; }
            if (rightDown) { try { SendMouseRaw(MOUSEEVENTF_RIGHTUP, 0, 0, 0); } catch { } rightDown = false; }
        }
        RestoreCursor();
    }

    static void SaveCursor()
    {
        if (!hasSavedCursor)
        {
            POINT p;
            if (GetCursorPos(out p))
            {
                savedCursor = p;
                hasSavedCursor = true;
            }
        }
    }

    static void RestoreCursor()
    {
        if (hasSavedCursor)
        {
            try { SetCursorPos(savedCursor.X, savedCursor.Y); } catch { }
            hasSavedCursor = false;
        }
    }

    static void CheckReadyForPhysical()
    {
        // 主人和 AI 可以同时操作；只认显式暂停（Ctrl+Alt+Q / pause），
        // 不再因为检测到主人在动鼠标键盘就拒绝 physical。
        if (Paused) throw new Exception("paused: " + PauseReason);
    }

    static void MoveRaw(int x, int y)
    {
        int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int height = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        int nx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1));
        int ny = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1));
        SendMouseRaw(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0);
        Thread.Sleep(12);
    }

    static void SendMouseRaw(uint flags, int dx, int dy, int data)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = (uint)data;
        input.u.mi.dwFlags = flags;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        INPUT[] inputs = new INPUT[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("SendInput mouse failed");
        Interlocked.Exchange(ref lastInjectedTick, (long)(GetTickCount64() & 0xFFFFFFFF));
    }

    static void SendKeyRaw(ushort vk, bool down, bool extended)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = (down ? 0u : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0u);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        INPUT[] inputs = new INPUT[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("SendInput keyboard failed");
        Interlocked.Exchange(ref lastInjectedTick, (long)(GetTickCount64() & 0xFFFFFFFF));
    }

    static void SendUnicodeChar(char ch)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.u.ki.wVk = 0;
        down.u.ki.wScan = (ushort)ch;
        down.u.ki.dwFlags = KEYEVENTF_UNICODE;
        INPUT up = down;
        up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        INPUT[] inputs = new INPUT[] { down, up };
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2)
            throw new Exception("SendInput unicode failed");
        Interlocked.Exchange(ref lastInjectedTick, (long)(GetTickCount64() & 0xFFFFFFFF));
    }

    public static void PhysicalClick(int x, int y, bool right, int count)
    {
        if (!AllowPhysicalMouse) throw new Exception("physical-mouse-forbidden");
        if (count < 1) count = 1;
        CheckReadyForPhysical();
        StartHooks();
        SaveCursor();
        PhysicalActive = true;
        try
        {
            MoveRaw(x, y);
            for (int i = 0; i < count; i++)
            {
                if (Paused) throw new Exception("paused: " + PauseReason);
                if (right)
                {
                    SendMouseRaw(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0);
                    rightDown = true;
                    Thread.Sleep(30);
                    SendMouseRaw(MOUSEEVENTF_RIGHTUP, 0, 0, 0);
                    rightDown = false;
                }
                else
                {
                    SendMouseRaw(MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
                    leftDown = true;
                    Thread.Sleep(30);
                    SendMouseRaw(MOUSEEVENTF_LEFTUP, 0, 0, 0);
                    leftDown = false;
                }
                Thread.Sleep(80);
            }
        }
        finally
        {
            PhysicalActive = false;
            ReleaseAll();
            RestoreCursor();
            StopHooks();
        }
    }

    public static void PhysicalText(string text)
    {
        CheckReadyForPhysical();
        StartHooks();
        PhysicalActive = true;
        try
        {
            int i = 0;
            foreach (char ch in text)
            {
                if (Paused) throw new Exception("paused: " + PauseReason);
                SendUnicodeChar(ch);
                i++;
                if ((i % 24) == 0) Thread.Sleep(4);
            }
        }
        finally
        {
            PhysicalActive = false;
            StopHooks();
        }
    }

    public static void PhysicalKeySequence(ushort[] keys)
    {
        if (keys == null || keys.Length == 0) throw new Exception("keys required");
        CheckReadyForPhysical();
        StartHooks();
        PhysicalActive = true;
        try
        {
            lock (heldLock)
            {
                for (int i = 0; i < keys.Length; i++)
                {
                    if (Paused) throw new Exception("paused: " + PauseReason);
                    SendKeyRaw(keys[i], true, false);
                    heldKeys.Add(keys[i]);
                    Thread.Sleep(15);
                }
            }
            Thread.Sleep(35);
        }
        finally
        {
            PhysicalActive = false;
            ReleaseAll();
            StopHooks();
        }
    }

    public static void PhysicalScroll(int x, int y, int delta)
    {
        if (!AllowPhysicalMouse) throw new Exception("physical-mouse-forbidden");
        CheckReadyForPhysical();
        StartHooks();
        SaveCursor();
        PhysicalActive = true;
        try
        {
            MoveRaw(x, y);
            SendMouseRaw(MOUSEEVENTF_WHEEL, 0, 0, delta);
            Thread.Sleep(90);
        }
        finally
        {
            PhysicalActive = false;
            RestoreCursor();
            StopHooks();
        }
    }

    public static void PhysicalDrag(int x1, int y1, int x2, int y2, int durationMs)
    {
        if (!AllowPhysicalMouse) throw new Exception("physical-mouse-forbidden");
        CheckReadyForPhysical();
        StartHooks();
        SaveCursor();
        PhysicalActive = true;
        try
        {
            MoveRaw(x1, y1);
            SendMouseRaw(MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
            leftDown = true;
            int steps = Math.Max(8, Math.Min(80, durationMs / 16));
            for (int i = 1; i <= steps; i++)
            {
                if (Paused) throw new Exception("paused: " + PauseReason);
                int x = x1 + (x2 - x1) * i / steps;
                int y = y1 + (y2 - y1) * i / steps;
                MoveRaw(x, y);
                Thread.Sleep(16);
            }
            SendMouseRaw(MOUSEEVENTF_LEFTUP, 0, 0, 0);
            leftDown = false;
            Thread.Sleep(60);
        }
        finally
        {
            PhysicalActive = false;
            ReleaseAll();
            RestoreCursor();
            StopHooks();
        }
    }

    public static IntPtr FocusWindow(IntPtr hwnd)
    {
        IntPtr prev = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return prev;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        SendKeyRaw(VK_MENU, true, false);
        try { SetForegroundWindow(hwnd); }
        finally { SendKeyRaw(VK_MENU, false, false); }
        Thread.Sleep(70);
        return prev;
    }

    public static IntPtr GetFocusWindow()
    {
        GUITHREADINFO gti = new GUITHREADINFO();
        gti.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(0, ref gti))
        {
            if (gti.hwndFocus != IntPtr.Zero) return gti.hwndFocus;
            if (gti.hwndActive != IntPtr.Zero) return gti.hwndActive;
        }
        return GetForegroundWindow();
    }

    public static IntPtr WindowAt(int x, int y)
    {
        POINT p;
        p.X = x;
        p.Y = y;
        return WindowFromPoint(p);
    }

    public static IntPtr RootOf(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        IntPtr root = GetAncestor(hwnd, (uint)GA_ROOT);
        return root == IntPtr.Zero ? hwnd : root;
    }

    public static IntPtr ChildAt(IntPtr hwnd, int screenX, int screenY)
    {
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        POINT p;
        p.X = screenX;
        p.Y = screenY;
        if (!ScreenToClient(hwnd, ref p)) return hwnd;
        IntPtr child = ChildWindowFromPointEx(hwnd, p, 0x0001 | 0x0002);
        return child == IntPtr.Zero ? hwnd : child;
    }

    public static string WindowTitle(IntPtr hwnd)
    {
        int length = GetWindowTextLengthW(hwnd);
        if (length <= 0) return "";
        StringBuilder sb = new StringBuilder(length + 2);
        GetWindowTextW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string WindowClass(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetClassNameW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }
    public static bool RevealWindow(IntPtr hwnd)
    {
        CheckNotPaused();
        return SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,0x0213);
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SHELLEXECUTEINFO {
        public int cbSize; public uint fMask; public IntPtr hwnd; public string lpVerb,lpFile,lpParameters,lpDirectory; public int nShow; public IntPtr hInstApp,lpIDList; public string lpClass; public IntPtr hkeyClass; public uint dwHotKey; public IntPtr hMonitor,hProcess;
    }
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);
    [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static long[] ShellOpen(string path,int x,int y) {
        CheckNotPaused();
        var info=new SHELLEXECUTEINFO { cbSize=Marshal.SizeOf(typeof(SHELLEXECUTEINFO)),fMask=0x00200140,lpVerb="open",lpFile=path,nShow=4,hMonitor=MonitorFromPoint(new POINT{X=x,Y=y},2) };
        try { bool ok=ShellExecuteExW(ref info); int error=ok?0:Marshal.GetLastWin32Error(); return new long[]{ok?1:0,error,info.hProcess==IntPtr.Zero?0:GetProcessId(info.hProcess)}; }
        finally {if(info.hProcess!=IntPtr.Zero)CloseHandle(info.hProcess);}
    }

    public static int WindowPid(IntPtr hwnd)
    {
        int pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }

    public static int[] WindowRect(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0)
        {
            if (!GetWindowRect(hwnd, out r)) return new int[] { 0, 0, 0, 0 };
        }
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static long WindowExStyle(IntPtr hwnd)
    {
        return (long)GetWindowLongPtrW(hwnd, -20);
    }

    public static IntPtr[] EnumTopWindows()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
        return list.ToArray();
    }

    public static void PostMouseClick(IntPtr hwnd, int x, int y, bool right, int count)
    {
        CheckNotPaused();
        if (count < 1) count = 1;
        POINT p;
        p.X = x;
        p.Y = y;
        if (!ScreenToClient(hwnd, ref p)) throw new Exception("ScreenToClient failed");
        int lp = (p.Y << 16) | (p.X & 0xFFFF);
        uint down = right ? (uint)WM_RBUTTONDOWN : (uint)WM_LBUTTONDOWN;
        uint up = right ? (uint)WM_RBUTTONUP : (uint)WM_LBUTTONUP;
        uint dbl = right ? (uint)WM_RBUTTONDBLCLK : (uint)WM_LBUTTONDBLCLK;
        int mk = right ? MK_RBUTTON : MK_LBUTTON;
        if(!PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, new IntPtr(lp))) throw new Exception("message-post-failed: mouse move");
        Thread.Sleep(8);
        for (int i = 0; i < count; i++)
        {
            CheckNotPaused();
            uint msg = (i == 1) ? dbl : down;
            if (!PostMessage(hwnd, msg, new IntPtr(mk), new IntPtr(lp))) throw new Exception("PostMessage down failed");
            try { Thread.Sleep(28); CheckNotPaused(); }
            finally { if(!PostMessage(hwnd, up, IntPtr.Zero, new IntPtr(lp))) throw new Exception("message-post-failed-partial: button release"); }
            Thread.Sleep(55);
            CheckNotPaused();
        }
    }

    public static void PostMouseScroll(IntPtr hwnd, int x, int y, int delta)
    {
        CheckNotPaused();
        int lp = (y << 16) | (x & 0xFFFF);
        int wp = (delta << 16);
        if (!PostMessage(hwnd, WM_MOUSEWHEEL, new IntPtr(wp), new IntPtr(lp))) throw new Exception("PostMessage wheel failed");
    }

    public static void PostMouseDrag(IntPtr hwnd, int x1, int y1, int x2, int y2, int steps)
    {
        CheckNotPaused();
        if (steps < 2) steps = 2;
        POINT a;
        a.X = x1;
        a.Y = y1;
        if (!ScreenToClient(hwnd, ref a)) throw new Exception("ScreenToClient failed");
        int lp1 = (a.Y << 16) | (a.X & 0xFFFF);
        if(!PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, new IntPtr(lp1))) throw new Exception("message-post-failed: drag start move");
        CheckNotPaused();
        if(!PostMessage(hwnd, WM_LBUTTONDOWN, new IntPtr(MK_LBUTTON), new IntPtr(lp1))) throw new Exception("message-post-failed: drag down");
        int lastPoint = lp1;
        try { for (int i = 1; i <= steps; i++)
        {
            CheckNotPaused();
            int sx = x1 + (x2 - x1) * i / steps;
            int sy = y1 + (y2 - y1) * i / steps;
            POINT p;
            p.X = sx;
            p.Y = sy;
            if (!ScreenToClient(hwnd, ref p)) throw new Exception("message-partial: drag coordinate conversion failed");
            int lp = (p.Y << 16) | (p.X & 0xFFFF);
            if(!PostMessage(hwnd, WM_MOUSEMOVE, new IntPtr(MK_LBUTTON), new IntPtr(lp))) throw new Exception("message-post-failed-partial: drag step");
            lastPoint = lp;
            Thread.Sleep(16);
        } } finally { if(!PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, new IntPtr(lastPoint))) throw new Exception("message-post-failed-partial: drag release"); }
        CheckNotPaused();
    }

    public static int KeyMessageLParam(int vk,uint scanEx,bool down,bool extended)
    {
        int lParam=1|((int)(scanEx&0xff)<<16);
        // Main navigation VKs remain extended even when the layout maps them
        // to the same low scan byte as their numeric-keypad counterparts.
        bool navigation=(vk>=0x21&&vk<=0x28)||vk==0x2d||vk==0x2e;
        if(extended||navigation||(scanEx&0xff00)==0xe000)lParam|=1<<24;
        if(!down)lParam|=unchecked((int)0xc0000000);
        return lParam;
    }
    public static void PostKey(IntPtr hwnd, int vk, bool down, bool extended, bool sys)
    {
        if (down) CheckNotPaused();
        int lParam = KeyMessageLParam(vk,MapVirtualKey((uint)vk,4),down,extended);
        uint msg = down ? (sys ? (uint)WM_SYSKEYDOWN : (uint)WM_KEYDOWN) : (sys ? (uint)WM_SYSKEYUP : (uint)WM_KEYUP);
        if (!PostMessage(hwnd, msg, new IntPtr(vk), new IntPtr(lParam))) throw new Exception("PostMessage key failed");
    }

    public static void PostText(IntPtr hwnd, string text)
    {
        foreach (char ch in text)
        {
            CheckNotPaused();
            if (!PostMessage(hwnd, WM_CHAR, new IntPtr((int)ch), new IntPtr(1))) throw new Exception("PostMessage char failed");
            Thread.Sleep(2);
        }
        CheckNotPaused();
    }

    static readonly BlockingCollection<string> requestLines = new BlockingCollection<string>();
    static Thread requestReader;
    public static volatile bool TransportEnded = false;
    public static volatile bool TransportInterrupted = false;
    static readonly object captureLock=new object();
    static Process ownedCapture=null;
    public static void RegisterOwnedCapture(Process process) { lock(captureLock) { ownedCapture=process; if(Paused||TransportEnded) {try{if(!process.HasExited)process.Kill();}catch{}} } }
    public static void UnregisterOwnedCapture(Process process) { lock(captureLock) {if(Object.ReferenceEquals(ownedCapture,process))ownedCapture=null;} }
    public static void StopOwnedCapture() { lock(captureLock) {var process=ownedCapture;ownedCapture=null;if(process!=null)try{if(!process.HasExited)process.Kill();}catch{}} }
    static void InterruptTransport(string reason,string originalStop=null) {
        TransportInterrupted=true;
        if(RecordStop(reason,StopSource(reason),null)&&!string.IsNullOrEmpty(originalStop))RestoreStop(originalStop);
        StopOwnedCapture();
        EmitPauseState();
        ThreadPool.QueueUserWorkItem(delegate { try { DshOverlay.SetPaused(true); } catch {} });
    }
    public static string ReadRequestLine() {
        if(requestReader==null) {
            requestReader=new Thread(delegate() {
                try {
                    string line;
                    while((line=Console.In.ReadLine())!=null) {
                        if(line.StartsWith("{\"cmd\":\"__interrupt\",",StringComparison.Ordinal)) {
                            try { var data=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line); InterruptTransport(Convert.ToString(data["reason"]),data.ContainsKey("stopInfo")?new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(data["stopInfo"]):null); } catch { InterruptTransport("host-interrupt"); }
                        } else requestLines.Add(line);
                    }
                } finally { InterruptTransport("transport-eof"); TransportEnded=true; requestLines.CompleteAdding(); }
            });
            requestReader.IsBackground=true; requestReader.Start();
        }
        if(TransportEnded) return null;
        try { string line=requestLines.Take(); return TransportEnded?null:line; } catch(InvalidOperationException) {return null;}
    }

    public static void CheckNotPaused()
    {
        if (Paused || TransportInterrupted || TransportEnded) throw new OperationCanceledException("paused-partial");
    }

    public static string GetWindowText(IntPtr hwnd)
    {
        return WindowTitle(hwnd);
    }

    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SendTextTimeout(IntPtr hwnd,uint msg,IntPtr w,string text,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr ReadTextTimeout(IntPtr hwnd,uint msg,IntPtr w,StringBuilder text,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)] static extern IntPtr ValueTimeout(IntPtr hwnd,uint msg,IntPtr w,IntPtr value,uint flags,uint timeout,out IntPtr result);
    const uint MessageTimeoutMs=600, MessageTimeoutFlags=0x23;
    public static bool SetTextMessage(IntPtr hwnd, string text)
    {
        CheckNotPaused(); IntPtr result;
        if(SendTextTimeout(hwnd,WM_SETTEXT,IntPtr.Zero,text,MessageTimeoutFlags,MessageTimeoutMs,out result)==IntPtr.Zero) throw new Exception("message-result-unknown: WM_SETTEXT failed/timed out; do not resend");
        return result!=IntPtr.Zero;
    }
    public static string GetTextMessage(IntPtr hwnd)
    {
        IntPtr result;
        if(ValueTimeout(hwnd,WM_GETTEXTLENGTH,IntPtr.Zero,IntPtr.Zero,MessageTimeoutFlags,MessageTimeoutMs,out result)==IntPtr.Zero) throw new Exception("message-read-failed: WM_GETTEXTLENGTH failed/timed out");
        long length=result.ToInt64();
        if(length<0||length>1048576) throw new Exception("message-read-failed: text length out of supported bounds");
        var buffer=new StringBuilder((int)length+1);
        if(ReadTextTimeout(hwnd,WM_GETTEXT,new IntPtr(buffer.Capacity),buffer,MessageTimeoutFlags,MessageTimeoutMs,out result)==IntPtr.Zero) throw new Exception("message-read-failed: WM_GETTEXT failed/timed out");
        return buffer.ToString();
    }

    public static string CapturePng(string path, int x, int y, int w, int h)
    {
        if (w <= 0 || h <= 0)
        {
            x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        }
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return path;
    }
}

public static class DshOverlay
{
    public static string TrustedCaption="会话名称暂不可用";
    static Thread thread = null;
    static OverlayForm form = null;
    static ScreenHeader header = null;
    static readonly Dictionary<string,ScreenHeader> sharedHeaders=new Dictionary<string,ScreenHeader>(StringComparer.OrdinalIgnoreCase);
    static bool ExternalHeaders { get { return Environment.GetEnvironmentVariable("DSH_INPUT_EXTERNAL_HEADERS")=="1"; } }
    static bool SharedHeaderAt(int x,int y,bool clear=false) {
        try {
            string endpoint=Environment.GetEnvironmentVariable("DSH_INPUT_COORDINATOR_PIPE"), execution=Environment.GetEnvironmentVariable("DSH_INPUT_EXECUTION_ID");
            const string prefix="\\\\.\\pipe\\";
            if(string.IsNullOrEmpty(endpoint)||!endpoint.StartsWith(prefix)||string.IsNullOrEmpty(execution)) return false;
            var json=new System.Web.Script.Serialization.JavaScriptSerializer();
            using(var pipe=new System.IO.Pipes.NamedPipeClientStream(".",endpoint.Substring(prefix.Length),System.IO.Pipes.PipeDirection.InOut,System.IO.Pipes.PipeOptions.Asynchronous)) {
                pipe.Connect(900);
                using(var writer=new System.IO.StreamWriter(pipe,new System.Text.UTF8Encoding(false),1024,true)) using(var reader=new System.IO.StreamReader(pipe,System.Text.Encoding.UTF8,false,1024,true)) {
                    writer.WriteLine(json.Serialize(new {op="monitor",clientRuntimeVersion=Environment.GetEnvironmentVariable("DSH_INPUT_RUNTIME_VERSION"),identity=new {executionId=execution},device=clear?null:DshInput.MonitorAtPoint(x,y).DeviceName,x=x,y=y}));writer.Flush();
                    var pending=reader.ReadLineAsync();if(!pending.Wait(1200)||pending.Result==null)return false;
                    var result=json.Deserialize<Dictionary<string,object>>(pending.Result);return result.ContainsKey("ok")&&Convert.ToBoolean(result["ok"]);
                }
            }
        }catch{return false;}
    }
    public sealed class SharedHeaderRow {
        public DshInput.MonitorSnapshot Screen;public int X,Y;public bool Paused,Notice;public string Indicator;
        public int Priority {get{return !Paused?3:Notice?0:Indicator=="user-stopped"?2:1;}}
    }
    public static SharedHeaderRow[] NormalizeSharedHeaderRows(object[] records,Func<int,int,DshInput.MonitorSnapshot> resolve) {
        var merged=new Dictionary<string,SharedHeaderRow>(StringComparer.OrdinalIgnoreCase);
        foreach(object value in records){var row=(Dictionary<string,object>)value;int x=Convert.ToInt32(row["x"]),y=Convert.ToInt32(row["y"]);bool paused=Convert.ToBoolean(row["paused"]);var actual=resolve(x,y);SharedHeaderRow item;
            object indicator,notice;
            row.TryGetValue("indicator",out indicator);row.TryGetValue("notice",out notice);
            var candidate=new SharedHeaderRow {Screen=actual,X=x,Y=y,Paused=paused,Notice=Convert.ToBoolean(notice),Indicator=indicator as string};
            if(!merged.TryGetValue(actual.DeviceName,out item)||candidate.Priority>item.Priority)merged[actual.DeviceName]=candidate;
        }
        return new List<SharedHeaderRow>(merged.Values).ToArray();
    }
    public static bool ApplySharedHeaders(string jsonText) {
        var records=NormalizeSharedHeaderRows(new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<object[]>(jsonText),delegate(int x,int y){return DshInput.MonitorAtPoint(x,y);});
        bool active=false;foreach(var row in records)if(!row.Paused)active=true;
        if(active&&DshInput.Paused)DshInput.Resume();
        Start();
        bool rendered=true;bool ran=Run(delegate {
            var wanted=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(var row in records){string device=row.Screen.DeviceName;wanted.Add(device);ScreenHeader item;
                if(!sharedHeaders.TryGetValue(device,out item)){item=new ScreenHeader();sharedHeaders[device]=item;}
                item.DisplayOnMonitor(row.X,row.Y,row.Paused,row.Screen,row.Indicator,row.Notice);
                if(!item.Visible||!item.RenderSucceeded||item.MonitorDevice!=device)rendered=false;
            }
            foreach(var pair in sharedHeaders)if(!wanted.Contains(pair.Key))pair.Value.Hide();
        },1200);
        return ran&&rendered;
    }
    public static object[] SharedHeaderDiagnostics() {
        if(form==null)return new object[0];var result=new List<object>();
        Run(delegate {foreach(var pair in sharedHeaders)result.Add(new {monitor=pair.Key,visible=pair.Value.Visible,hwnd=pair.Value.IsHandleCreated?pair.Value.Handle.ToInt64():0,text=pair.Value.Text,rect=new int[]{pair.Value.Left,pair.Value.Top,pair.Value.Width,pair.Value.Height},renderSucceeded=pair.Value.RenderSucceeded,sampledUtc=DateTime.UtcNow.ToString("o")});},400);
        return result.ToArray();
    }
    static ManualResetEvent ready = new ManualResetEvent(false);
    static bool pausedState = false;
    static readonly Dictionary<string, Image> styleImages = new Dictionary<string, Image>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, PointF> styleHotspots = new Dictionary<string, PointF>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, int> styleIntervals = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    public static bool LastSetWindowPosOk = false;
    public static bool LastShowSucceeded = false;
    public static int LastSetWindowPosError = 0;
    public static int LastX = 0;
    public static int LastY = 0;
    public static bool HasLast = false;
    public static bool HasSessionTarget = false;
    public static void ResetSessionTarget() { ResetSessionTarget(true); }
    public static void ResetSessionTarget(bool releaseShared) { HasSessionTarget=false; if(ExternalHeaders&&releaseShared)SharedHeaderAt(0,0,true); if(form != null) Run(delegate() { header.Hide(); },400); }
    public static bool ReleaseSharedHeader() {return !ExternalHeaders||SharedHeaderAt(0,0,true);}
    static string cursorStyle = "pointer";
    static string cursorMode = "companion";
    static int cursorHoldMs = 2600;
    static int cursorSize = 0;
    static int spriteCellSize = 64;
    static int spriteColumns = 8;

    static readonly string[] StyleNames = {
        "pointer", "work", "unavailiable", "link", "text",
        "cross", "busy", "move", "vert", "horz",
        "help", "handwriting", "dgn1", "dgn2", "alternate"
    };

    public static void ConfigureStyles(string assetDir)
    {
        styleImages.Clear();
        for (int i = 0; i < StyleNames.Length; i++)
        {
            string name = StyleNames[i];
            string path = System.IO.Path.Combine(assetDir, name + ".png");
            if (!System.IO.File.Exists(path)) continue;
            try { styleImages[name] = Image.FromFile(path); } catch { }
        }
    }

    public static void ConfigureStyleMetadata(string style, double x, double y, int intervalMs)
    {
        styleHotspots[style] = new PointF((float)x, (float)y);
        styleIntervals[style] = intervalMs;
    }

    public static void ConfigureSpriteLayout(int cellSize, int columns)
    {
        spriteCellSize = cellSize;
        spriteColumns = columns;
    }

    public static int[] Placement(string style, int x, int y, int size)
    {
        PointF hotspot;
        if (!styleHotspots.TryGetValue(style, out hotspot)) hotspot = PointF.Empty;
        return new int[] { x - (int)Math.Round(hotspot.X * size / spriteCellSize, MidpointRounding.AwayFromZero),
                           y - (int)Math.Round(hotspot.Y * size / spriteCellSize, MidpointRounding.AwayFromZero) };
    }

    public static Bitmap RasterizeFrame(Image image, int frame, int size)
    {
        Rectangle source = new Rectangle((frame % spriteColumns) * spriteCellSize, (frame / spriteColumns) * spriteCellSize, spriteCellSize, spriteCellSize);
        using (Bitmap original = ((Bitmap)image).Clone(source, PixelFormat.Format32bppArgb))
        {
            Bitmap result = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(result))
            using (ImageAttributes attributes = new ImageAttributes())
            {
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(original, new Rectangle(0, 0, size, size), 0, 0, spriteCellSize, spriteCellSize, GraphicsUnit.Pixel, attributes);
            }
            // Retain the existing color-key window: threshold only the final-size
            // raster, never the source artwork or an intermediate 64px image.
            for (int y = 0; y < size; y++) for (int x = 0; x < size; x++)
            {
                Color color = result.GetPixel(x, y);
                result.SetPixel(x, y, color.A >= 128 ? Color.FromArgb(255, color.R, color.G, color.B) : Color.Transparent);
            }
            return result;
        }
    }

    public static void Start()
    {
        if (thread != null) return;
        thread = new Thread(ThreadProc);
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ready.WaitOne(5000);
    }

    static void ThreadProc()
    {
        try
        {
            Application.EnableVisualStyles();
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                try { Console.Error.WriteLine("overlay: " + e.Exception); } catch { }
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                try { Console.Error.WriteLine("overlay fatal: " + e.ExceptionObject); } catch { }
            };
            header = new ScreenHeader();
            form = new OverlayForm();
            form.LoadSprites(styleImages);
            form.ApplyStyle(cursorStyle);
            form.Paused = pausedState;
            form.ApplyMode(cursorMode, cursorHoldMs);
            form.ApplySize(cursorSize == 0 ? DshInput.AutoDisplaySizeAt(0, 0) : cursorSize);
            PrepareHidden(form);
            ready.Set();
            try { Application.Run(); }
            catch (Exception ex) { try { Console.Error.WriteLine("overlay run: " + ex); } catch { } }
        }
        catch { ready.Set(); }
    }

    static bool Run(Action action, int timeoutMs)
    {
        if (form == null) return false;
        try
        {
            using (ManualResetEvent done = new ManualResetEvent(false))
            {
                bool succeeded=true;
                form.BeginInvoke(new Action(delegate() { try { action(); } catch { succeeded=false; } finally { done.Set(); } }));
                return done.WaitOne(timeoutMs) && succeeded;
            }
        }
        catch { return false; }
    }

    static void PrepareHidden(OverlayForm window) { var hiddenHandle=window.Handle; }

    public static void ConfigureForShow(string mode,int holdMs,int size,string style) {
        cursorMode=mode=="clean"?"clean":"companion";
        cursorHoldMs=holdMs>0?holdMs:2600;
        cursorSize=size==0?0:Math.Max(24,Math.Min(192,size));
        foreach(string known in StyleNames)if(known==style){cursorStyle=style;break;}
    }

    public static bool ShowIndicatorAt(int x, int y)
    {
        if (!DshInput.SessionActive || DshInput.Paused) return false;
        LastX=x; LastY=y; HasLast=true; HasSessionTarget=true;
        if(ExternalHeaders)return SharedHeaderAt(x,y)&&!DshInput.Paused;
        Start();
        bool prepared=Run(delegate() { if (DshInput.SessionActive && !DshInput.Paused) header.DisplayAt(x,y,false); }, 900);
        return prepared && header != null && header.Visible && HeaderRenderSucceeded() && !DshInput.Paused;
    }

    public static void ShowStyledAt(int x,int y,string style) {
        foreach(string known in StyleNames) { if(known==style){cursorStyle=style;break;} }
        ShowAt(x,y);
    }

    public static void ShowAt(int x, int y)
    {
        LastShowSucceeded=false;
        LastX = x;
        LastY = y;
        HasLast = true;
        HasSessionTarget = true;
        Start();
        if(ExternalHeaders&&!SharedHeaderAt(x,y))return;
        Run(delegate() { form.ApplyMode(cursorMode,cursorHoldMs); form.DisplayPreparedAt(x,y,cursorSize==0 ? DshInput.AutoDisplaySizeAt(x,y) : cursorSize,cursorStyle); LastShowSucceeded=form.Visible && LastSetWindowPosOk; if (DshInput.SessionActive&&!ExternalHeaders) header.DisplayAt(x, y, pausedState); }, 900);
    }

    public static void SetMode(string mode, int holdMs)
    {
        cursorMode = (mode == "clean") ? "clean" : "companion";
        cursorHoldMs = holdMs > 0 ? holdMs : 2600;
        if (form == null) return;
        Run(delegate() { form.ApplyMode(cursorMode, cursorHoldMs); }, 400);
    }

    public static void SetSize(int size)
    {
        cursorSize = size == 0 ? 0 : Math.Max(24, Math.Min(192, size));
        if (form == null) return;
        Run(delegate() { form.ApplySize(cursorSize == 0 ? DshInput.AutoDisplaySizeAt(LastX, LastY) : cursorSize); }, 900);
    }

    public static void SetStyle(string style)
    {
        string key = string.IsNullOrEmpty(style) ? "pointer" : style.ToLowerInvariant();
        bool known = false;
        for (int i = 0; i < StyleNames.Length; i++) { if (StyleNames[i] == key) { known = true; break; } }
        cursorStyle = known ? key : "pointer";
        if (form == null) return;
        Run(delegate() { form.ApplyStyle(cursorStyle); }, 500);
    }

    public static void SetPaused(bool paused)
    {
        pausedState = paused;
        if (form == null) return;
        Run(delegate() { form.Paused = paused; if(paused) header.CancelInteraction(); if (HasSessionTarget && header.Visible) header.DisplayAt(LastX, LastY, paused); }, 400);
    }

    public static void Hide()
    {
        if (form == null) return;
        Run(delegate() { form.HideNow(); header.Hide(); }, 500);
    }

    public static bool VisibleNow()
    {
        if (form == null) return false;
        try { return form.Visible; } catch { return false; }
    }

    public static int[] Bounds()
    {
        if (form == null) return new int[] { 0, 0, 0, 0 };
        try { return new int[] { form.Left, form.Top, form.Width, form.Height }; } catch { return new int[] { 0, 0, 0, 0 }; }
    }

    public static long HandleId()
    {
        if (form == null) return 0;
        try { return (long)form.Handle; } catch { return 0; }
    }

    public static void Stop()
    {
        if (form == null) return;
        Run(delegate() { form.HideNow(); header.Hide(); header.Dispose(); Application.ExitThread(); }, 800);
    }

    public static int[] HeaderPlacement(int x, int y, int width, int height, int dpi)
    {
        int w = Math.Min(width, (int)Math.Round(236.0 * dpi / 96));
        int h = Math.Min(height, (int)Math.Round(30.0 * dpi / 96));
        int gap = Math.Min(Math.Max(0, height - h), (int)Math.Round(8.0 * dpi / 96));
        return new int[] { x + (width - w) / 2, y + gap, w, h };
    }
    public static string HeaderText(bool paused) { return paused ? "AI 已暂停操作此屏幕" : "AI 正在操作此屏幕"; }
    public static string HeaderText(bool paused,string indicator) {
        if(!paused)return HeaderText(false);
        if(indicator=="finished")return "AI 已结束操控";
        if(indicator=="yielded")return "AI 已暂时让出操控";
        if(indicator=="user-stopped")return "用户已停止 AI 操控";
        return HeaderText(true);
    }
    public static int[] HeaderBounds() { if (header == null) return new int[] {0,0,0,0}; return new int[] {header.Left,header.Top,header.Width,header.Height}; }
    public static long HeaderHandle() { return header == null ? 0 : header.Handle.ToInt64(); }
    public static string HeaderMonitor() { return header == null ? "" : header.MonitorDevice; }
    public static object ActualDiagnostics() {
        if(form==null)return null;
        object snapshot=null;
        bool read=Run(delegate(){ snapshot=form.Diagnostics(); },400);
        return read ? snapshot : null;
    }
    public static bool HeaderVisible() { return header != null && header.Visible; }
    public static int[] ClampHeader(int wx,int wy,int ww,int wh,int x,int y,int width,int height)
    {
        int w=Math.Max(1,Math.Min(ww,width)), h=Math.Max(1,Math.Min(wh,height));
        return new int[]{Math.Max(wx,Math.Min(wx+ww-w,x)),Math.Max(wy,Math.Min(wy+wh-h,y)),w,h};
    }
    public static void SaveHeaderSetting(string path,string device,double[] dip)
    {
        var json=new System.Web.Script.Serialization.JavaScriptSerializer();
        var root=System.IO.File.Exists(path) ? json.Deserialize<Dictionary<string,object>>(System.IO.File.ReadAllText(path)) : new Dictionary<string,object>();
        object old; Dictionary<string,object> map;
        map=root.TryGetValue("screenIndicators",out old) ? old as Dictionary<string,object> : null;
        if(map==null) map=new Dictionary<string,object>();
        if(dip==null) map.Remove(device); else map[device]=dip;
        root["screenIndicators"]=map;
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));
        System.IO.File.WriteAllText(path,json.Serialize(root),new UTF8Encoding(false));
    }
    public static double[] ReadHeaderSetting(string path,string device)
    {
        try {
            var json=new System.Web.Script.Serialization.JavaScriptSerializer();
            var root=json.Deserialize<Dictionary<string,object>>(System.IO.File.ReadAllText(path));
            var map=(Dictionary<string,object>)root["screenIndicators"];
            var values=(System.Collections.IEnumerable)map[device]; var result=new List<double>();
            foreach(object value in values) result.Add(Convert.ToDouble(value));
            return result.Count==4 ? result.ToArray() : null;
        } catch { return null; }
    }
    public static Bitmap DrawHeaderBitmap(int width,int height,int dpi,bool paused,bool hover)
    {
        return DrawHeaderBitmap(width,height,dpi,paused,hover,null,false);
    }
    public static Bitmap DrawHeaderBitmap(int width,int height,int dpi,bool paused,bool hover,string indicator,bool notice)
    {
        var bitmap=new Bitmap(width,height,PixelFormat.Format32bppPArgb);
        float scale=dpi/96f, grip=Math.Max(12,16*scale);
        using(var g=Graphics.FromImage(bitmap)) {
            // Restore the original nearly-solid rectangular purple header.
            Color background=paused ? Color.FromArgb(240,103,66,20) : Color.FromArgb(240,38,32,61);
            if(paused&&(indicator=="finished"||indicator=="yielded"))background=Color.FromArgb(240,23,78,73);
            if(paused&&indicator=="user-stopped")background=Color.FromArgb(240,112,40,45);
            g.Clear(background);
            g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            using(var font=new Font("Microsoft YaHei UI",(float)Math.Max(9,Math.Min(18,height*96.0/dpi*.34))*dpi/72f,FontStyle.Bold,GraphicsUnit.Pixel))
            using(var format=new StringFormat { Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center,Trimming=StringTrimming.EllipsisCharacter,FormatFlags=StringFormatFlags.NoWrap })
            using(var ink=new SolidBrush(Color.White)) {
                g.DrawString(HeaderText(paused,indicator),font,ink,new RectangleF(grip,0,Math.Max(1,width-grip*2),height),format);
            }
            if(!notice)using(var ink=new SolidBrush(Color.FromArgb(255,180,160,220))) {
                g.FillRectangle(ink,3*scale,height/2f-5*scale,Math.Max(3,grip-6*scale),10*scale);
                g.FillPolygon(ink,new PointF[]{new PointF(width-3*scale,height-3*scale),new PointF(width-grip,height-3*scale),new PointF(width-3*scale,height-grip)});
            }
        }
        return bitmap;
    }
    [StructLayout(LayoutKind.Sequential)] struct HeaderPoint { public int X,Y; public HeaderPoint(int x,int y){X=x;Y=y;} }
    [StructLayout(LayoutKind.Sequential)] struct HeaderSize { public int Width,Height; public HeaderSize(int w,int h){Width=w;Height=h;} }
    [StructLayout(LayoutKind.Sequential,Pack=1)] struct HeaderBlend { public byte Op,Flags,Alpha,Format; }
    [DllImport("user32.dll",SetLastError=true)] static extern bool UpdateLayeredWindow(IntPtr hwnd,IntPtr dst,ref HeaderPoint point,ref HeaderSize size,IntPtr src,ref HeaderPoint origin,int key,ref HeaderBlend blend,int flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd,IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    public static bool HeaderRenderSucceeded() { return header!=null && header.RenderSucceeded; }
    public static int HeaderRenderError() { return header==null ? 0 : header.RenderError; }

    sealed class ScreenHeader : Form
    {
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); DshInput.MarkFeedback(Handle); }

        bool hover=false,rendering=false,screenPaused=false,screenNotice=false;int screenX,screenY;string screenIndicator;
        public bool RenderSucceeded=false; public int RenderError=0;
        public string MonitorDevice { get { return device; } }
        bool dragging=false,resizing=false; Point start; Rectangle initial,work; string device=""; int dpi=96;
        string SettingsPath { get { return Environment.GetEnvironmentVariable("DSH_INPUT_SETTINGS_FILE"); } }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var cp=base.CreateParams; cp.ExStyle|=0x08000000|0x00080000|0x00000080; if(screenNotice)cp.ExStyle|=0x20;return cp; } }
        public ScreenHeader()
        {
            Text="Independent Input Screen Status";
            FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true; StartPosition=FormStartPosition.Manual;
            BackColor=Color.Black;
            SetStyle(ControlStyles.AllPaintingInWmPaint|ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer,true);
            var menu=new ContextMenuStrip(); menu.Items.Add("设置宽高…",null,delegate { CustomizeSize(); });
            menu.Items.Add("重置本屏",null,delegate { try { SaveHeaderSetting(SettingsPath,device,null); DisplayOnMonitor(screenX,screenY,screenPaused,DshInput.MonitorAtPoint(screenX,screenY),screenIndicator,screenNotice); } catch(Exception e) { MessageBox.Show(e.Message,"保存失败"); } });
            ContextMenuStrip=menu;
            AccessibleName="屏幕操作提示";
            AccessibleDescription="拖动面板；右下角调整大小；右键设置宽高或重置本屏。";

        }
        int Grip { get { return Math.Max(12,(int)Math.Round(16.0*dpi/96)); } }
        public void DisplayAt(int x,int y,bool paused)
        {
            DisplayOnMonitor(x,y,paused,DshInput.MonitorAtPoint(x,y));
        }
        public void DisplayOnMonitor(int x,int y,bool paused,DshInput.MonitorSnapshot screen,string indicator=null,bool notice=false)
        {
            if(screenPaused!=paused||screenIndicator!=indicator||screenNotice!=notice)CancelInteraction();
            if(screenNotice!=notice){screenNotice=notice;UpdateStyles();}
            screenPaused=paused;screenIndicator=indicator;
            screenX=x;screenY=y;
            if(dragging||resizing) { if(screen.DeviceName==device) return; CancelInteraction(); }
            work=screen.WorkingArea; device=screen.DeviceName; dpi=(int)screen.Dpi;
            int[] b=HeaderPlacement(work.X,work.Y,work.Width,work.Height,dpi);
            var dip=ReadHeaderSetting(SettingsPath,device);
            if(dip!=null) b=ClampHeader(work.X,work.Y,work.Width,work.Height,work.X+(int)Math.Round(dip[0]*dpi/96),work.Y+(int)Math.Round(dip[1]*dpi/96),(int)Math.Round(Math.Max(180,Math.Min(640,dip[2]))*dpi/96),(int)Math.Round(Math.Max(26,Math.Min(100,dip[3]))*dpi/96));
            Bounds=new Rectangle(b[0],b[1],b[2],b[3]); Text=HeaderText(paused,indicator);
            if(!Visible) Show();
            DshInput.SetWindowPos(Handle,new IntPtr(-1),b[0],b[1],b[2],b[3],0x0010); RenderHeader();
        }
        public void CancelInteraction() { if(!dragging&&!resizing)return; Bounds=initial; dragging=resizing=false; Capture=false; Invalidate(); }
        protected override void OnResize(EventArgs e) { base.OnResize(e); RenderHeader(); }
        void Store()
        {
            try { SaveHeaderSetting(SettingsPath,device,new double[]{(Left-work.X)*96.0/dpi,(Top-work.Y)*96.0/dpi,Width*96.0/dpi,Height*96.0/dpi}); }
            catch(Exception e) { MessageBox.Show(e.Message,"提示框设置保存失败"); }
        }
        void CustomizeSize()
        {
            string editingDevice=device; Rectangle editingWork=work,editingBounds=Bounds; int editingDpi=dpi;
            using(var dialog=new Form()) {
                dialog.Text="本屏提示框大小（DIP）"; dialog.ClientSize=new Size(300,140); dialog.FormBorderStyle=FormBorderStyle.FixedDialog; dialog.StartPosition=FormStartPosition.Manual; dialog.MinimizeBox=false; dialog.MaximizeBox=false;
                var w=new NumericUpDown { AccessibleName="提示框宽度DIP", Minimum=180,Maximum=640,Value=(decimal)Math.Max(180,Math.Min(640,editingBounds.Width*96.0/editingDpi)),Location=new Point(20,30),Width=110 };
                var h=new NumericUpDown { AccessibleName="提示框高度DIP", Minimum=26,Maximum=100,Value=(decimal)Math.Max(26,Math.Min(100,editingBounds.Height*96.0/editingDpi)),Location=new Point(160,30),Width=110 };
                dialog.Controls.Add(new Label{Text="宽 / 高（逻辑像素）",Location=new Point(20,8),AutoSize=true}); dialog.Controls.Add(w); dialog.Controls.Add(h);
                var ok=new Button{Text="保存",DialogResult=DialogResult.OK,Location=new Point(180,88)}; dialog.Controls.Add(ok); dialog.AcceptButton=ok;
                dialog.Shown+=delegate { var d=ClampHeader(editingWork.X,editingWork.Y,editingWork.Width,editingWork.Height,editingWork.X+(editingWork.Width-dialog.Width)/2,editingWork.Y+(editingWork.Height-dialog.Height)/2,dialog.Width,dialog.Height); dialog.Bounds=new Rectangle(d[0],d[1],d[2],d[3]); };
                if(dialog.ShowDialog(this)==DialogResult.OK) {
                    var b=ClampHeader(editingWork.X,editingWork.Y,editingWork.Width,editingWork.Height,editingBounds.X,editingBounds.Y,(int)Math.Round((double)w.Value*editingDpi/96),(int)Math.Round((double)h.Value*editingDpi/96));
                    try { SaveHeaderSetting(SettingsPath,editingDevice,new double[]{(b[0]-editingWork.X)*96.0/editingDpi,(b[1]-editingWork.Y)*96.0/editingDpi,b[2]*96.0/editingDpi,b[3]*96.0/editingDpi}); }
                    catch(Exception e) { MessageBox.Show(dialog,e.Message,"提示框设置保存失败"); return; }
                    if(device==editingDevice) { Bounds=new Rectangle(b[0],b[1],b[2],b[3]); Invalidate(); }
                }
            }
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e); if(e.Button!=MouseButtons.Left) return;
            resizing=e.X>=Width-Grip && e.Y>=Height-Grip; dragging=!resizing; start=PointToScreen(e.Location); initial=Bounds; Capture=true;
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e); if(!dragging&&!resizing) return; var p=PointToScreen(e.Location); int dx=p.X-start.X,dy=p.Y-start.Y;
            var b=ClampHeader(work.X,work.Y,work.Width,work.Height,dragging ? initial.X+dx : initial.X,dragging ? initial.Y+dy : initial.Y,resizing ? Math.Max(180*dpi/96,Math.Min(640*dpi/96,initial.Width+dx)) : initial.Width,resizing ? Math.Max(26*dpi/96,Math.Min(100*dpi/96,initial.Height+dy)) : initial.Height);
            Bounds=new Rectangle(b[0],b[1],b[2],b[3]); Invalidate();
        }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); if(!dragging&&!resizing)return; dragging=resizing=false; Capture=false; Store(); }
        protected override void OnMouseCaptureChanged(EventArgs e) { base.OnMouseCaptureChanged(e); if(!Capture) CancelInteraction(); }
        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover=true; RenderHeader(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover=false; RenderHeader(); }
        protected override void OnPaint(PaintEventArgs e) { RenderHeader(); }
        protected override void OnInvalidated(InvalidateEventArgs e) { base.OnInvalidated(e); RenderHeader(); }
        void RenderHeader()
        {
            if(rendering||!IsHandleCreated||Width<1||Height<1) return;
            rendering=true; IntPtr screen=IntPtr.Zero,dc=IntPtr.Zero,hbitmap=IntPtr.Zero,old=IntPtr.Zero;
            RenderSucceeded=false; RenderError=0;
            try {
                using(var bitmap=DrawHeaderBitmap(Width,Height,dpi,screenPaused,hover,screenIndicator,screenNotice)) {
                    screen=GetDC(IntPtr.Zero); dc=CreateCompatibleDC(screen); hbitmap=bitmap.GetHbitmap(Color.FromArgb(0)); old=SelectObject(dc,hbitmap);
                    var point=new HeaderPoint(Left,Top); var size=new HeaderSize(Width,Height); var origin=new HeaderPoint(0,0); var blend=new HeaderBlend { Op=0,Flags=0,Alpha=255,Format=1 };
                    RenderSucceeded=UpdateLayeredWindow(Handle,screen,ref point,ref size,dc,ref origin,0,ref blend,2);
                    if(!RenderSucceeded) RenderError=Marshal.GetLastWin32Error();
                }
            } catch { RenderError=-1; }
            finally { if(old!=IntPtr.Zero)SelectObject(dc,old); if(hbitmap!=IntPtr.Zero)DeleteObject(hbitmap); if(dc!=IntPtr.Zero)DeleteDC(dc); if(screen!=IntPtr.Zero)ReleaseDC(IntPtr.Zero,screen); rendering=false; }
        }
        protected override void WndProc(ref Message m)
        {
            if(m.Msg==0x0084) { m.Result=new IntPtr(screenNotice?-1:1); return; }
            if(m.Msg==0x0021) {m.Result=new IntPtr(3);return;} base.WndProc(ref m);
        }
    }

    sealed class SessionTip : Form {
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); DshInput.MarkFeedback(Handle); }

        string caption="";
        public SessionTip(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;BackColor=Color.FromArgb(38,32,61);ForeColor=Color.White;Opacity=.96;Font=new Font("Segoe UI",9);}
        protected override bool ShowWithoutActivation {get{return true;}}
        protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000020|0x00080000|0x00000080;return p;}}
        Rectangle anchorSprite;
        bool layingOut;
        Size MeasureCaption(){Size size=TextRenderer.MeasureText(caption,Font);return new Size(Math.Min(420,Math.Max(110,size.Width+16)),Math.Max(28,size.Height+8));}
        Rectangle CaptionBounds(Rectangle sprite,Rectangle work){
            Size size=MeasureCaption();int width=size.Width,height=size.Height;
            int x=Math.Max(work.Left,Math.Min(sprite.Left,work.Right-width)),y=sprite.Bottom+4;
            if(y+height>work.Bottom)y=Math.Max(work.Top,sprite.Top-height-4);
            return new Rectangle(x,y,width,height);
        }
        void RelayoutCaption(){
            if(layingOut||string.IsNullOrEmpty(caption))return;
            layingOut=true;
            try {
                Rectangle bounds=CaptionBounds(anchorSprite,DshInput.MonitorAtRectangle(anchorSprite).WorkingArea);
                if(!IsHandleCreated||!Visible){Bounds=bounds;return;}
                DshInput.SetWindowPos(Handle,new IntPtr(-1),bounds.X,bounds.Y,bounds.Width,bounds.Height,0x0010|0x0040);
                Invalidate();
            } finally {layingOut=false;}
        }
        protected override void OnFontChanged(EventArgs e){base.OnFontChanged(e);RelayoutCaption();}
        protected override void OnDpiChanged(DpiChangedEventArgs e){base.OnDpiChanged(e);RelayoutCaption();}
        public void Display(Rectangle sprite,string text){caption=text;anchorSprite=sprite;if(!Visible){RelayoutCaption();Show();}RelayoutCaption();Invalidate();}
        protected override void OnPaint(PaintEventArgs e){TextRenderer.DrawText(e.Graphics,caption,Font,new Rectangle(8,4,Width-16,Height-8),ForeColor,TextFormatFlags.EndEllipsis|TextFormatFlags.SingleLine);}
    }

    sealed class OverlayForm : Form
    {
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); DshInput.MarkFeedback(Handle); }

        int Cell { get { return spriteCellSize; } }
        int Cols { get { return spriteColumns; } }
        readonly System.Windows.Forms.Timer animTimer;
        readonly System.Windows.Forms.Timer hideTimer;
        readonly System.Windows.Forms.Timer motionTimer,hoverTimer;
        readonly SessionTip sessionTip=new SessionTip();
        double visualX,visualY,startX,startY,targetX,targetY;long motionStart;
        bool hasVisual;
        bool deferPosition;
        static double MotionProgress(long elapsed,long frequency){return Math.Max(0,Math.Min(1,elapsed/(frequency*.120)));}
        void StepMotion(){double t=MotionProgress(System.Diagnostics.Stopwatch.GetTimestamp()-motionStart,System.Diagnostics.Stopwatch.Frequency);double ease=t*t*(3-2*t);visualX=startX+(targetX-startX)*ease;visualY=startY+(targetY-startY)*ease;PositionAtAnchor();if(t>=1)motionTimer.Stop();}
        void StopVisualTimers(){motionTimer.Stop();hoverTimer.Stop();sessionTip.Hide();}
        protected override void Dispose(bool disposing){if(disposing){StopVisualTimers();motionTimer.Dispose();hoverTimer.Dispose();animTimer.Dispose();hideTimer.Dispose();sessionTip.Dispose();}base.Dispose(disposing);}

        string mode = "companion";
        int holdMs = 2600;
        Image sprite;
        Dictionary<string, Image> sprites;
        string baseStyle = "pointer";
        int displaySize = 64;
        int lastX = 0;
        int lastY = 0;
        int frame = 0;
        int frameCount = 1;
        bool paused = false;
        readonly Dictionary<int, Bitmap> rasterFrames = new Dictionary<int, Bitmap>();

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(displaySize, displaySize);
            BackColor = Color.Fuchsia;
            TransparencyKey = Color.Fuchsia;
            Visible = false;
            SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            animTimer = new System.Windows.Forms.Timer();
            animTimer.Interval = 60;
            animTimer.Tick += delegate { if (frameCount > 1) { frame = (frame + 1) % frameCount; ApplyFrameRegion(); Invalidate(); } };
            hideTimer = new System.Windows.Forms.Timer();
            motionTimer=new System.Windows.Forms.Timer();motionTimer.Interval=16;motionTimer.Tick+=delegate{if(paused||!Visible){motionTimer.Stop();return;}StepMotion();};
            hoverTimer=new System.Windows.Forms.Timer();hoverTimer.Interval=100;hoverTimer.Tick+=delegate{if(!Visible||paused){sessionTip.Hide();return;}int hx,hy;if(!DshInput.TryCursorPos(out hx,out hy)){sessionTip.Hide();return;}if(Bounds.Contains(hx,hy))sessionTip.Display(Bounds,DshOverlay.TrustedCaption);else sessionTip.Hide();};
            hideTimer.Tick += delegate { hideTimer.Stop(); HideNow(); };
        }

        public object Diagnostics() {return new Dictionary<string,object> {
            {"visible",Visible},{"effectiveStyle",EffectiveStyle},{"selectedStyle",baseStyle},
            {"frameIndex",frame},{"frameCount",frameCount},{"intervalMs",animTimer.Interval},
            {"displaySize",displaySize},{"caption",DshOverlay.TrustedCaption},{"tipVisible",sessionTip.Visible},
            {"headerMonitor",DshOverlay.HeaderMonitor()},{"headerRect",DshOverlay.HeaderBounds()}
        };}
        public void ApplyMode(string m, int h)
        {
            mode = (m == "clean") ? "clean" : "companion";
            holdMs = h > 0 ? h : 2600;
            if (mode == "clean" && Visible)
            {
                hideTimer.Stop();
                hideTimer.Interval = holdMs;
                hideTimer.Start();
            }
            else
            {
                hideTimer.Stop();
            }
        }

        public void LoadSprites(Dictionary<string, Image> images)
        {
            sprites = images != null ? images : new Dictionary<string, Image>();
            if (!sprites.ContainsKey(baseStyle))
            {
                string first = null;
                foreach (string key in sprites.Keys) { first = key; break; }
                baseStyle = first != null ? first : "pointer";
            }
            if (sprites.ContainsKey(baseStyle)) ApplySprite(sprites[baseStyle]);
        }

        public void ApplyStyle(string style)
        {
            if (sprites == null || sprites.Count == 0) return;
            string key = string.IsNullOrEmpty(style) ? "pointer" : style.ToLowerInvariant();
            if (!sprites.ContainsKey(key)) key = sprites.ContainsKey("pointer") ? "pointer" : baseStyle;
            if (baseStyle == key && sprite != null) return;
            baseStyle = key;
            if (!paused && sprites.ContainsKey(key)) ApplySprite(sprites[key]);
        }

        void ApplySprite(Image img)
        {
            if (img == null) return;
            foreach (Bitmap cached in rasterFrames.Values) cached.Dispose();
            rasterFrames.Clear();
            sprite = img;
            frame = 0;
            frameCount = Math.Max(1, (img.Width / Cell) * (img.Height / Cell));
            int interval;
            animTimer.Interval = styleIntervals.TryGetValue(EffectiveStyle, out interval) ? interval : 60;
            if (Visible && !deferPosition) PositionAtAnchor();
            Invalidate();
        }

        string EffectiveStyle { get { return paused && sprites != null && sprites.ContainsKey("unavailiable") ? "unavailiable" : baseStyle; } }

        bool PositionAtAnchor()
        {
            int[] position = Placement(EffectiveStyle, (int)Math.Round(visualX), (int)Math.Round(visualY), displaySize);
            bool ok = DshInput.SetWindowPos(Handle, DshInput.HWND_TOPMOST, position[0], position[1], displaySize, displaySize,
                (uint)DshInput.SWP_NOACTIVATE);
            DshOverlay.LastSetWindowPosOk = ok;
            DshOverlay.LastSetWindowPosError = Marshal.GetLastWin32Error();
            return ok;
        }

        public void ApplySize(int size)
        {
            size = Math.Max(24, Math.Min(192, size));
            if (size == displaySize && Width == size && Height == size) return;
            displaySize = size;
            ApplySprite(sprite);
            // ApplySprite performs at most one native layout; no managed Size write.
            if (sprite == null && Visible && !deferPosition) PositionAtAnchor();
        }

        void ApplyFrameRegion()
        {
            // color-key 透明方案不需要 Region；保留空方法避免大改调用点。
        }

        public bool Paused
        {
            get { return paused; }
            set
            {
                if (paused == value) return;
                paused = value;
                if(paused)StopVisualTimers();
                if (sprites == null) return;
                if (paused && sprites.ContainsKey("unavailiable")) ApplySprite(sprites["unavailiable"]);
                else if (sprites.ContainsKey(baseStyle)) ApplySprite(sprites[baseStyle]);
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                return cp;
            }
        }

        public void DisplayPreparedAt(int x,int y,int size,string style) {
            deferPosition=true;
            try { ApplySize(size); ApplyStyle(style); }
            finally { deferPosition=false; }
            DisplayAt(x,y);
        }

        public void DisplayAt(int x, int y)
        {
            // Keep the author's scaled hotspot at the action coordinate.
            lastX = x;
            lastY = y;
            bool first=!Visible||!hasVisual;
            targetX=x;targetY=y;
            if(first){visualX=x;visualY=y;hasVisual=true;motionTimer.Stop();}
            else {startX=visualX;startY=visualY;motionStart=System.Diagnostics.Stopwatch.GetTimestamp();if(!paused)motionTimer.Start();}
            bool positioned=PositionAtAnchor();
            if (!Visible && !positioned) { motionTimer.Stop();hoverTimer.Stop();return; }
            if (!Visible) Show();
            if(!paused)hoverTimer.Start();
            if (first) frame = 0;
            ApplyFrameRegion();
            animTimer.Start();
            hideTimer.Stop();
            if (mode == "clean")
            {
                hideTimer.Interval = holdMs;
                hideTimer.Start();
            }
            Invalidate();
            Update();
        }

        public void HideNow()
        {
            hideTimer.Stop();
            animTimer.Stop();
            StopVisualTimers();hasVisual=false;
            Hide();
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(BackColor);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (sprite != null)
            {
                int col = frame % Cols;
                int row = frame / Cols;
                if (row * Cell + Cell <= sprite.Height)
                {
                    Bitmap raster;
                    if (!rasterFrames.TryGetValue(frame, out raster))
                    {
                        raster = RasterizeFrame(sprite, frame, displaySize);
                        rasterFrames[frame] = raster;
                    }
                    e.Graphics.DrawImageUnscaled(raster, 0, 0);
                    return;
                }
            }
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color ring = Paused ? Color.Orange : Color.DeepSkyBlue;
            using (Pen pen = new Pen(ring, 3))
            {
                e.Graphics.DrawEllipse(pen, 8, 8, Width - 17, Height - 17);
            }
            using (SolidBrush dot = new SolidBrush(Color.White))
            {
                e.Graphics.FillEllipse(dot, Width / 2 - 3, Height / 2 - 3, 6, 6);
            }
        }
    }
}

'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies $refs
if($env:DSH_INPUT_OWNER_JSON){[DshInput]::SetStopOwner($env:DSH_INPUT_OWNER_JSON)}
if($env:DSH_INPUT_INITIAL_STOP_JSON){[DshInput]::RestoreStop($env:DSH_INPUT_INITIAL_STOP_JSON)}
if($env:DSH_INPUT_INITIAL_PAUSE_REASON) { [DshInput]::PauseReason=$env:DSH_INPUT_INITIAL_PAUSE_REASON; [DshInput]::Paused=$true }

# ---------------------------------------------------------------- UIA helpers

function Get-UiaElementAt([int]$x, [int]$y) {
  if (-not $script:uia) { return $null }
  try {
    $pt = [System.Windows.Point]::new([double]$x, [double]$y)
    return [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  } catch { return $null }
}

function Get-UiaName($el) {
  try { return [string]$el.Current.Name } catch { return '' }
}

function Get-UiaType($el) {
  try { return [string]$el.Current.ControlType.ProgrammaticName } catch { return '' }
}

function Invoke-UiaClick([int]$x, [int]$y) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cur = $el
  for ($i = 0; $i -lt 6 -and $null -ne $cur; $i++) {
    $n = Get-UiaName $cur
    $t = Get-UiaType $cur
    try {
      $p = $cur.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      Commit-InputSource $req; Show-InputIndicator $x $y; $p.Invoke()
      return @{ ok = $true; via = 'uia'; pattern = 'Invoke'; name = $n; type = $t }
    } catch { }
    try {
      $p = $cur.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      Commit-InputSource $req; Show-InputIndicator $x $y; $p.Toggle()
      return @{ ok = $true; via = 'uia'; pattern = 'Toggle'; name = $n; type = $t }
    } catch { }
    try {
      $p = $cur.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      Commit-InputSource $req; Show-InputIndicator $x $y; $p.Select()
      return @{ ok = $true; via = 'uia'; pattern = 'Select'; name = $n; type = $t }
    } catch { }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
  }
  return @{ ok = $false; reason = 'uia-no-pattern'; name = $name; type = $type }
}

function Invoke-UiaClickInWindow([IntPtr]$hwnd, [int]$x, [int]$y) {
  if (-not $script:uia -or $hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; reason = 'uia-no-window' } }
  $attempted = $false
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) { return @{ ok = $false; reason = 'uia-no-window' } }
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $limit = [Math]::Min($all.Count, 4000)
    for ($i = 0; $i -lt $limit; $i++) {
      $cur = $all.Item($i)
      try {
        $r = $cur.Current.BoundingRectangle
        if ($r.IsEmpty) { continue }
        if ($x -lt $r.Left -or $x -gt $r.Right -or $y -lt $r.Top -or $y -gt $r.Bottom) { continue }
      } catch { continue }
      $n = Get-UiaName $cur
      $t = Get-UiaType $cur
      try {
        $p = $cur.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        [DshInput]::CheckNotPaused()
        Commit-InputSource $req
        Show-InputIndicator $x $y
        $attempted = $true
        $p.Invoke()
        return @{ ok = $true; via = 'uia-hwnd'; mayActivate = $true; pattern = 'Invoke'; name = $n; type = $t }
      } catch { if ($attempted -or [DshInput]::Paused) { return @{ ok = $false; reason = 'uia-action-uncertain-or-paused'; attempted = $attempted; paused = [DshInput]::Paused } } }
      try {
        $p = $cur.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        [DshInput]::CheckNotPaused()
        Commit-InputSource $req
        Show-InputIndicator $x $y
        $attempted = $true
        $p.Toggle()
        return @{ ok = $true; via = 'uia-hwnd'; mayActivate = $true; pattern = 'Toggle'; name = $n; type = $t }
      } catch { if ($attempted -or [DshInput]::Paused) { return @{ ok = $false; reason = 'uia-action-uncertain-or-paused'; attempted = $attempted; paused = [DshInput]::Paused } } }
      try {
        $p = $cur.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        [DshInput]::CheckNotPaused()
        Commit-InputSource $req
        Show-InputIndicator $x $y
        $attempted = $true
        $p.Select()
        return @{ ok = $true; via = 'uia-hwnd'; mayActivate = $true; pattern = 'Select'; name = $n; type = $t }
      } catch { if ($attempted -or [DshInput]::Paused) { return @{ ok = $false; reason = 'uia-action-uncertain-or-paused'; attempted = $attempted; paused = [DshInput]::Paused } } }
    }
  } catch { if ($attempted -or [DshInput]::Paused) { return @{ ok = $false; reason = 'uia-action-uncertain-or-paused'; attempted = $attempted; paused = [DshInput]::Paused } } }
  return @{ ok = $false; reason = 'uia-no-element' }
}

function Set-UiaTextInWindow([IntPtr]$hwnd, [string]$text, [bool]$replace) {
  if (-not $script:uia -or $hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; reason = 'uia-no-window' } }
  $attempted = $false
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $attempted = $true
    $want = if ($replace) { $text } else { [string]$vp.Current.Value + $text }
    [DshInput]::CheckNotPaused()
    Commit-InputSource $req; $ir=[DshInput]::WindowRect($hwnd); Show-InputIndicator ([int]($ir[0]+$ir[2]/2)) ([int]($ir[1]+$ir[3]/2)); $vp.SetValue($want)
    if ([string]$vp.Current.Value -cne $want) { return @{ ok = $false; reason = 'uia-readback-mismatch'; attempted = $true } }
    return @{ ok = $true; via = 'uia-hwnd'; mayActivate = $true; pattern = 'Value'; verified = $true; name = (Get-UiaName $el); type = (Get-UiaType $el) }
  } catch {
    return @{ ok = $false; reason = 'uia-no-value'; attempted = $attempted }
  }
}

function Set-UiaText([int]$x, [int]$y, [string]$text, [bool]$replace) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($replace) { Commit-InputSource $req; Show-InputIndicator $x $y; $vp.SetValue($text) }
    else { Commit-InputSource $req; Show-InputIndicator $x $y; $vp.SetValue([string]$vp.Current.Value + $text) }
    return @{ ok = $true; via = 'uia'; pattern = 'Value'; name = $name; type = $type }
  } catch { }
  try {
    $legacy = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    Commit-InputSource $req; Show-InputIndicator $x $y; $legacy.SetValue($text)
    return @{ ok = $true; via = 'uia'; pattern = 'LegacyValue'; name = $name; type = $type }
  } catch { }
  return @{ ok = $false; reason = 'uia-no-value'; name = $name; type = $type }
}

function Set-UiaFocus([int]$x, [int]$y) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  try {
    $el.SetFocus()
    return @{ ok = $true; via = 'uia'; pattern = 'Focus'; name = $name; type = $type }
  } catch {
    return @{ ok = $false; reason = 'uia-no-focus'; name = $name; type = $type }
  }
}

function Invoke-UiaScroll([int]$x, [int]$y, [int]$delta) {
  $el = Get-UiaElementAt $x $y
  if ($null -eq $el) { return @{ ok = $false; reason = 'uia-no-element' } }
  $name = Get-UiaName $el
  $type = Get-UiaType $el
  $amount = if ($delta -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
  try {
    $sp = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $amount)
    return @{ ok = $true; via = 'uia'; pattern = 'Scroll'; name = $name; type = $type }
  } catch { }
  try {
    $si = $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
    $si.ScrollIntoView()
    return @{ ok = $true; via = 'uia'; pattern = 'ScrollItem'; name = $name; type = $type }
  } catch { }
  return @{ ok = $false; reason = 'uia-no-scroll'; name = $name; type = $type }
}

# ---------------------------------------------------------------- window list

function Get-WindowsList {
  $result = @()
  $foreground = [long][DshInput]::GetForegroundWindow()
  foreach ($h in [DshInput]::EnumTopWindows()) {
    try {
      if (-not [DshInput]::IsWindowVisible($h)) { continue }
      $title = [DshInput]::WindowTitle($h)
      if ([string]::IsNullOrWhiteSpace($title)) { continue }
      $pid2 = [DshInput]::WindowPid($h)
      $procName = ''
      try { $procName = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { }
      $rect = [DshInput]::WindowRect($h)
      $result += @{
        hwnd = [long]$h
        title = $title
        className = [DshInput]::WindowClass($h)
        process = $procName
        pid = $pid2
        rect = @{ x = $rect[0]; y = $rect[1]; w = $rect[2]; h = $rect[3] }
        foreground = ([long]$h -eq $foreground)
        iconic = [DshInput]::IsIconic($h)
      }
    } catch { }
  }
  return ,$result
}

# ---------------------------------------------------------------- keyboard map

function Get-Vk([string]$name) {
  $n = $name.Trim().ToLower()
  switch ($n) {
    'ctrl' { return 0x11 }
    'control' { return 0x11 }
    'shift' { return 0x10 }
    'alt' { return 0x12 }
    'menu' { return 0x12 }
    'win' { return 0x5B }
    'lwin' { return 0x5B }
    'rwin' { return 0x5C }
    'enter' { return 0x0D }
    'return' { return 0x0D }
    'esc' { return 0x1B }
    'escape' { return 0x1B }
    'tab' { return 0x09 }
    'space' { return 0x20 }
    'backspace' { return 0x08 }
    'delete' { return 0x2E }
    'del' { return 0x2E }
    'insert' { return 0x2D }
    'ins' { return 0x2D }
    'home' { return 0x24 }
    'end' { return 0x23 }
    'pageup' { return 0x21 }
    'pagedown' { return 0x22 }
    'up' { return 0x26 }
    'down' { return 0x28 }
    'left' { return 0x25 }
    'right' { return 0x27 }
    'capslock' { return 0x14 }
    'numlock' { return 0x90 }
    'printscreen' { return 0x2C }
    'scrolllock' { return 0x91 }
    'pause' { return 0x13 }
    'apps' { return 0x5D }
    default {
      if ($n.Length -eq 1) { return [int][char]$n.ToUpper() }
      if ($n -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
      throw "unknown key: $name"
    }
  }
}

# ---------------------------------------------------------------- status

function Get-MonitorInfo {
  $result = @()
  foreach ($screen in [DshInput]::EnumerateMonitors()) {
    $b = $screen.Bounds; $w = $screen.WorkingArea
    $result += @{ device = $screen.DeviceName; primary = $screen.Primary; dpi = $screen.Dpi; bounds = @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }; workArea = @{ x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height } }
  }
  return @($result)
}

function Get-StatusResult {
  $cursor = [DshInput]::CursorPos()
  $fg = [DshInput]::GetForegroundWindow()
  $fgTitle = ''
  try { $fgTitle = [DshInput]::WindowTitle($fg) } catch { }
  return @{
    paused = [DshInput]::Paused
    pauseReason = [DshInput]::PauseReason
    stopInfo = [DshInput]::StopInfo
    lastStop = [DshInput]::LastStop
    lastUserInputAgeMs = [DshInput]::LastUserInputAgeMs()
    cursor = @{ x = $cursor[0]; y = $cursor[1] }
    foreground = @{
      hwnd = [long]$fg
      title = $fgTitle
      className = [DshInput]::WindowClass($fg)
      pid = [DshInput]::WindowPid($fg)
    }
    overlay = [DshOverlay]::VisibleNow()
    overlayRect = [DshOverlay]::Bounds()
    overlayHwnd = [DshOverlay]::HandleId()
    screenIndicator = @{ visible = [DshOverlay]::HeaderVisible(); rect = [DshOverlay]::HeaderBounds(); text = [DshOverlay]::HeaderText([DshInput]::Paused); hwnd = [DshOverlay]::HeaderHandle(); monitor = [DshOverlay]::HeaderMonitor(); renderBackend = 'update-layered-window'; renderSucceeded = [DshOverlay]::HeaderRenderSucceeded(); renderError = [DshOverlay]::HeaderRenderError() }
    hotkey = 'Ctrl+Esc（active时）或Ctrl+Alt+Q'
    hotkeyRegistered = [DshInput]::HotkeyRegistered
    escapeHookRegistered = [DshInput]::EscapeHookRegistered
    sessionState = if ($script:SessionFinished) { 'finished' } elseif ([DshInput]::SessionActive) { 'active' } else { 'idle' }
    monitors = @(Get-MonitorInfo)
    focusPolicy = $script:focusPolicy
    uia = $script:uia
    uiaProxyRegistered = $script:uiaProxyRegistered
    uiaProxyError = $script:uiaProxyError
    cursorMode = $script:cursorMode
    cursorHoldMs = $script:cursorHoldMs
    cursorSize = $script:cursorSize
    cursorSizeMode = if ($script:cursorSize -eq 0) { 'system' } else { 'manual' }
    displaySize = if ([DshOverlay]::VisibleNow()) { ([DshOverlay]::Bounds())[2] } elseif ($script:cursorSize -eq 0) { [DshInput]::AutoDisplaySizeAt($cursor[0], $cursor[1]) } else { $script:cursorSize }
    cursorStyle = $script:cursorStyle
    cursorState = if ([DshInput]::Paused) { 'unavailiable' } else { $script:cursorStyle }
    userActiveMs = [DshInput]::UserActiveMs
  }
}

function Get-PausedResult {
  if (-not [DshInput]::Paused) { return $null }
  return @{
    ok = $false
    paused = $true
    reason = 'paused'
    note = '主人已经暂停/接管输入。不要继续操作；等主人说继续，再调用 action:"resume"。'
  }
}

function Show-StateAt([string]$state, [int]$x, [int]$y) {
  # Actions keep the explicitly selected asset; only overlay configuration changes style.
  [DshOverlay]::ShowStyledAt($x, $y, $script:cursorStyle)
}

function Capture-TargetWindow([long]$hwnd, [string]$path) {
  if ([DshInput]::IsFeedbackWindow([IntPtr]$hwnd)) { return @{ok=$false;reason='feedback-window-capture-unsupported';note='请截取目标应用窗口；不对本插件反馈窗启动系统WGC捕获。'} }
  $helper = Join-Path $PSScriptRoot 'native/window-capture/bin/win-x64/dsh-window-capture.exe'
  if (-not (Test-Path -LiteralPath $helper)) { return @{ ok = $false; reason = 'capture-helper-missing'; method = 'wgc-window'; occlusionSafe = $true } }
  if (-not [IO.Path]::IsPathRooted($path) -or $path.Contains('"')) { return @{ ok = $false; reason = 'invalid-capture-path' } }
  $dir = [IO.Path]::GetDirectoryName($path)
  if (-not [string]::IsNullOrWhiteSpace($dir)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $helper
  $info.Arguments = '--hwnd ' + $hwnd + ' --path "' + $path + '" --timeout-ms 5000'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
  $process = [Diagnostics.Process]::Start($info)
  [DshInput]::RegisterOwnedCapture($process)
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(9000)) {
      $process.Kill()
      return @{ ok = $false; reason = 'capture-helper-timeout'; method = 'wgc-window'; occlusionSafe = $true }
    }
    $captured = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
    if (-not $captured.ok -or $process.ExitCode -ne 0) { return @{ ok = $false; reason = $captured.reason; hresult = $captured.hresult; method = 'wgc-window'; refresh = 'observe'; occlusionSafe = $true } }
    $rect = $null
    if ($captured.mappingVerified -and $null -ne $captured.screenRect) {
      $r = $captured.screenRect
      $rect = @{ x = $r.x; y = $r.y; width = $r.width; height = $r.height; scale = 1 }
    }
    return @{ ok = $true; path = $captured.path; method = 'wgc-window'; sourceHwnd = $captured.sourceHwnd; occlusionSafe = $true; mappingVerified = [bool]$captured.mappingVerified; mappingSource = $captured.mappingSource; rect = $rect; imageSize = @{ width = $captured.width; height = $captured.height }; note = if ($captured.mappingVerified) { '窗口捕获；坐标映射已核对，动作前仍须新鲜观察。' } else { '图像仅供视觉查看：没有已验证屏幕原点，不得从本图派发坐标输入。' } }
  } catch { return @{ ok = $false; reason = 'capture-helper-protocol-failed'; error = $_.Exception.Message; method = 'wgc-window'; occlusionSafe = $true } }
  finally { [DshInput]::UnregisterOwnedCapture($process); $process.Dispose() }
}

# ---------------------------------------------------------------- requests

function Commit-InputSource($request) {
  [DshInput]::CheckNotPaused()
  [DshOverlay]::TrustedCaption=if($request.trustedCaption){[string]$request.trustedCaption}else{'会话名称暂不可用'}
}

function Write-LaunchPreparationStage($request,[string]$stage){
  $process=[Diagnostics.Process]::GetCurrentProcess()
  $event=@{event='launch-preparation';id=$request.id;stage=$stage;utc=[DateTime]::UtcNow.ToString('o');ticks=[Diagnostics.Stopwatch]::GetTimestamp();frequency=[Diagnostics.Stopwatch]::Frequency;callerPid=$PID;callerBirth=$process.StartTime.ToUniversalTime().Ticks.ToString();callerThreadId=[DshInput]::GetCurrentThreadId();apartment=[Threading.Thread]::CurrentThread.GetApartmentState().ToString()}
  [Console]::Out.WriteLine(($event|ConvertTo-Json -Compress));[Console]::Out.Flush()
  return $event
}

function Invoke-Request($req) {
  $cmd = [string]$req.cmd
  if($env:DSH_INPUT_HEADER_HOST -eq '1' -and $cmd -notin @('sharedHeaders','status','shutdown','__globalPause')){return @{ok=$false;reason='header-host-not-input-executor';inputSent=$false}}
  if($env:DSH_INPUT_READONLY -eq '1' -and $cmd -notin @('ping','status','windows','observe','checkObservation','capture','winInfo','windowAt','uiaInfo','debug','shutdown')){return @{ok=$false;reason='readonly-executor-cannot-promote';inputSent=$false}}
  $keyboardRoot = $null
  if($req.mode -eq 'invoke'){
    $invokeCount=1
    if($req -is [System.Collections.IDictionary]){if($req.Contains('count')){$invokeCount=[int]$req['count']}}elseif($req.PSObject.Properties['count']){$invokeCount=[int]$req.count}
    if($cmd -ne 'click' -or -not $req.observationId -or -not $req.elementId -or [long]$req.hwnd -le 0 -or $null -ne $req.x -or $null -ne $req.y -or $req.windowObservationId -or ($req.button -and $req.button -ne 'left') -or $invokeCount -ne 1){return @{ok=$false;reason='invoke-requires-fresh-element';routeScope='element-invoke';attempted=$false;inputSent=$false;providerCalled=$false;verified=$false}}
  }
  if($req.mode -eq 'value' -and ($cmd -ne 'type' -or -not $req.observationId -or -not $req.elementId -or [long]$req.hwnd -le 0 -or $null -ne $req.x -or $null -ne $req.y -or $req.windowObservationId)){return @{ok=$false;reason='value-requires-fresh-element';attempted=$false;verified=$false}}
  if($cmd -eq 'key' -and (($null -ne $req.x) -ne ($null -ne $req.y))){return @{ok=$false;reason='key-coordinate-pair-required';attempted=$false}}
  if($req.trustedOwnerJson){[DshInput]::SetStopOwner([string]$req.trustedOwnerJson)}
  $controlled = $cmd -in @('click','type','key','scroll','drag','move','bounds','reveal','shellOpen','prepareLaunch') -or ($cmd -eq 'overlay' -and $req.show -ne $false)
  if ($controlled) {
    if ($script:SessionFinished) { return @{ ok = $false; reason = 'session-finished'; note = '本次操作已finish；需要显式begin，begin不会清除暂停。' } }
    $paused = Get-PausedResult
    if ($null -ne $paused) { return $paused }
    $focusBlock=Get-FocusPolicyBlock $req
    if($null -ne $focusBlock){return $focusBlock}
    if ($req.mode -eq 'physical') { return @{ ok = $false; reason = 'physical-forbidden' } }
    $rawKeyboard = $cmd -eq 'key' -or ($cmd -eq 'type' -and -not $req.observationId -and -not $req.elementId)
    $windowGuardId = $req.windowObservationId
    if($rawKeyboard -and $null -eq $windowGuardId) {
      if($null -eq $script:CurrentObservation -or -not $script:CurrentObservation.id){return @{ok=$false;reason='observation-required';refresh='observe';attempted=$false;inputSent=$false}}
      $windowGuardId = $script:CurrentObservation.id
    }
    if($null -ne $windowGuardId) {
      if($cmd -notin @('click','type','key','scroll','drag') -or $req.observationId -or $req.elementId){return @{ok=$false;reason='invalid-window-observation-guard'}}
      if($rawKeyboard -and $script:CurrentObservation -and [long][DshInput]::RootOf([IntPtr]$script:CurrentObservation.hwnd) -ne [long]$script:CurrentObservation.hwnd){$script:CurrentObservation=$null;return @{ok=$false;reason='root-window-observation-required';refresh='observe-root';attempted=$false;inputSent=$false}}
      $guardHwnd=[long]$req.hwnd
      if($cmd -in @('type','key') -and $script:CurrentObservation -and $script:CurrentObservation.hwnd -ne $guardHwnd){$guardHwnd=[long][DshInput]::RootOf([IntPtr]$guardHwnd)}
      $guard=Get-InputObservationStatus ([string]$windowGuardId) $guardHwnd
      $script:CurrentObservation=$null
      if(-not $guard.ok){return $guard}
      if($rawKeyboard){$keyboardRoot=$guardHwnd}
    }
    [DshInput]::SessionActive = $true
    if ($cmd -in @('click','type') -and ($req.elementId -or $req.observationId)) {
      $semantic = Invoke-ObservedElement $req
      if($req.mode -eq 'value'){$semantic.verified=($semantic.ok -eq $true)}
      if ($semantic.ok -and -not [DshInput]::Paused -and $semantic.targetRect.width -gt 0 -and $semantic.targetRect.height -gt 0) {
        try { $style = if ($cmd -eq 'type') { 'text' } else { 'link' }; Show-StateAt $style $semantic.x $semantic.y; $semantic.overlayFeedback = 'shown' }
        catch { $semantic.overlayFeedback = 'failed'; $semantic.overlayError = $_.Exception.Message }
      }
      return $semantic
    }
    $script:CurrentObservation = $null
  }

  switch ($cmd) {
    'sharedHeaders' {
      if($env:DSH_INPUT_HEADER_HOST -ne '1'){return @{ok=$false;reason='header-host-required'}}
      [DshInput]::SessionActive=($req.activeLane -eq $true)
      if($req.anyRunningLane -eq $true -and [DshInput]::Paused){[DshInput]::Resume()}
      $rendered=[DshOverlay]::ApplySharedHeaders((ConvertTo-Json -InputObject @($req.screens) -Compress -Depth 8))
      return @{ok=$rendered;sharedHeaders=[DshOverlay]::SharedHeaderDiagnostics()}
    }
    'ping' { return @{ pong = $true } }
    'status' { $state=Get-StatusResult; if($req.details){$state.actualUI=[DshOverlay]::ActualDiagnostics()}; return $state }
    'begin' {
      [DshOverlay]::ResetSessionTarget()
      $script:SessionFinished = $false
      [DshInput]::SessionActive = $true
      Clear-InputObservation 'begin'
      return Get-StatusResult
    }
    'finish' {
      [DshOverlay]::ResetSessionTarget($false)
      [DshInput]::SessionActive = $false
      $script:SessionFinished = $true
      $script:CurrentObservation = $null
      [DshOverlay]::Hide()
      return Get-StatusResult
    }
    'observe' {
      $limit = if ($req.maxElements) { [int]$req.maxElements } else { 150 }
      return New-InputObservation ([long]$req.hwnd) $limit
    }
    'checkObservation' { return Get-InputObservationStatus ([string]$req.observationId) ([long]$req.hwnd) }
    'setCursorMode' {
      $m = [string]$req.mode
      if ($m -eq 'clean' -or $m -eq 'companion') { $script:cursorMode = $m }
      if ($null -ne $req.holdMs) { $script:cursorHoldMs = [int]$req.holdMs }
      [DshOverlay]::SetMode($script:cursorMode, $script:cursorHoldMs)
      return @{ ok = $true; cursorMode = $script:cursorMode; cursorHoldMs = $script:cursorHoldMs }
    }
    'setCursorSize' {
      $s = [int]$req.size
      if ($s -eq 0 -or ($s -ge 24 -and $s -le 192)) { $script:cursorSize = $s }
      [DshOverlay]::SetSize($script:cursorSize)
      return @{ ok = $true; cursorSize = $script:cursorSize; cursorSizeMode = if ($script:cursorSize -eq 0) { 'system' } else { 'manual' }; displaySize = ([DshOverlay]::Bounds())[2] }
    }
    'setCursorStyle' {
      $s = ([string]$req.style).ToLower()
      if ($script:styleNames -contains $s) { $script:cursorStyle = $s }
      [DshOverlay]::SetStyle($script:cursorStyle)
      return @{ ok = $true; cursorStyle = $script:cursorStyle; styles = $script:styleNames }
    }
    'simulateUserInput' {
      [DshInput]::SimulateUserInput()
      return Get-StatusResult
    }
    'debug' {
      $h = [DshOverlay]::HandleId()
      $hr = @(0, 0, 0, 0)
      $vis = $false
      $ex = 0
      if ($h -ne 0) {
        $hr = [DshInput]::WindowRect([IntPtr]$h)
        $vis = [DshInput]::IsWindowVisible([IntPtr]$h)
        $ex = [DshInput]::WindowExStyle([IntPtr]$h)
      }
      return @{
        hwnd = $h
        visible = $vis
        rect = $hr
        bounds = [DshOverlay]::Bounds()
        exStyle = ('0x{0:X}' -f $ex)
        style = if ($h -ne 0) { '0x{0:X}' -f ([long][DshInput]::GetWindowLongPtrW([IntPtr]$h, -16)) } else { '0x0' }
        parent = if ($h -ne 0) { [long][DshInput]::GetParent([IntPtr]$h) } else { 0 }
        root = if ($h -ne 0) { [long][DshInput]::RootOf([IntPtr]$h) } else { 0 }
        topmost = (($ex -band 0x8) -ne 0)
        transparent = (($ex -band 0x20) -ne 0)
        noactivate = (($ex -band 0x08000000) -ne 0)
        toolwindow = (($ex -band 0x80) -ne 0)
        setWindowPosOk = [DshOverlay]::LastSetWindowPosOk
        setWindowPosError = [DshOverlay]::LastSetWindowPosError
      }
    }
    'prepareLaunch' {
      $path=[string]$req.path
      if($path -notmatch '^[A-Za-z]:[\\/]' -or (-not [IO.File]::Exists($path) -and -not [IO.Directory]::Exists($path))){return @{ok=$false;reason='local-path-required'}}
      $null=Write-LaunchPreparationStage $req 'indicator-enter'
      Commit-InputSource $req;Show-InputIndicator ([int]$req.x) ([int]$req.y)
      $null=Write-LaunchPreparationStage $req 'shortcut-prepare'
      $prepared=Prepare-ManagedChromeLaunch $path
      $preparation=Write-LaunchPreparationStage $req 'prepared'
      return @{ok=$true;launch=$prepared;preparation=$preparation}
    }
    'shellOpen' {
      return @{ok=$false;opened=$false;reason='async-launch-required';inputSent=$false}
    }
    'reveal' {
      $h=[IntPtr][long]$req.hwnd
      if(-not[DshInput]::IsWindow($h)-or[DshInput]::RootOf($h)-ne$h-or-not[DshInput]::IsWindowVisible($h)-or[DshInput]::IsIconic($h)){return @{ok=$false;reason='visible-nonminimized-top-level-required';inputSent=$false}}
      $r=[DshInput]::WindowRect($h)
      Commit-InputSource $req
      Show-InputIndicator ([int]($r[0]+$r[2]/2)) ([int]($r[1]+$r[3]/2))
      $before=[long][DshInput]::GetForegroundWindow()
      $ok=[DshInput]::RevealWindow($h)
      $after=[long][DshInput]::GetForegroundWindow()
      return @{ok=$ok;hwnd=[long]$h;via='SetWindowPos-HWND_TOP';flags=0x0213;focusRequested=$false;foregroundBeforeSample=$before;foregroundAfterSample=$after;foregroundSampleChanged=($before-ne$after);backgroundReadiness='unverified';note='仅显式请求普通Z序置顶，不移动/缩放/永久置顶或主动激活；可能覆盖同屏其它窗。前后前台仅端点采样，不保证应用不自行激活；随后fresh观察renderer归属与页面响应。'}
    }
    'windows' { return @{ windows = (Get-WindowsList); monitors = @(Get-MonitorInfo) } }
    'bounds' {
      $h = [IntPtr][long]$req.hwnd
      if($req.expectedPid -and [DshInput]::WindowPid($h) -ne [int]$req.expectedPid) {return @{ok=$false;reason='new-window-owner-changed'}}
      if (-not [DshInput]::IsWindow($h) -or [DshInput]::RootOf($h) -ne $h) { return @{ ok = $false; reason = 'top-level-window-required' } }
      if ([DshInput]::IsIconic($h) -or [DshInput]::IsZoomed($h)) { return @{ ok = $false; reason = 'window-state-not-movable'; note = '最小化/最大化窗口不自动恢复或激活。' } }
      if ([int]$req.width -lt 1 -or [int]$req.height -lt 1) { return @{ ok = $false; reason = 'invalid-window-bounds' } }
      [DshInput]::CheckNotPaused()
      Commit-InputSource $req
      Show-InputIndicator ([int]($req.x+$req.width/2)) ([int]($req.y+$req.height/2))
      if (-not [DshInput]::SetWindowPos($h, [IntPtr]::Zero, [int]$req.x, [int]$req.y, [int]$req.width, [int]$req.height, 0x0014)) { return @{ ok = $false; reason = 'set-window-bounds-failed' } }
      $outer = New-Object DshInput+RECT
      if (-not [DshInput]::GetWindowRect($h, [ref]$outer)) { return @{ ok = $false; reason = 'window-bounds-readback-failed' } }
      $actual = [DshInput]::WindowRect($h)
      Show-StateAt 'move' ([int]($actual[0]+$actual[2]/2)) ([int]($actual[1]+$actual[3]/2))
      return @{ ok = $true; hwnd = [long]$h; requested = @{ x = $req.x; y = $req.y; width = $req.width; height = $req.height }; outerBounds = @{ x = $outer.Left; y = $outer.Top; width = ($outer.Right - $outer.Left); height = ($outer.Bottom - $outer.Top) }; rect = @{ x = $actual[0]; y = $actual[1]; width = $actual[2]; height = $actual[3] }; dpi = [DshInput]::GetDpiForWindow($h); note = '仅改指定窗口bounds，不激活/不改zorder；DWM可见边框与Win32外框可能不同，后续fresh observe。' }
    }
    'windowAt' {
      $h = [DshInput]::WindowAt([int]$req.x, [int]$req.y)
      return @{
        hwnd = [long]$h
        title = [DshInput]::WindowTitle($h)
        className = [DshInput]::WindowClass($h)
        root = [long][DshInput]::RootOf($h)
      }
    }
    'uiaInfo' {
      $el = Get-UiaElementAt ([int]$req.x) ([int]$req.y)
      if ($null -eq $el) { return @{ ok = $false; reason = 'null' } }
      $r = $el.Current.BoundingRectangle
      return @{
        ok = $true
        name = (Get-UiaName $el)
        type = (Get-UiaType $el)
        className = [string]$el.Current.ClassName
        rect = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
      }
    }
    'winInfo' {
      $h = [IntPtr][long]$req.hwnd
      $r = [DshInput]::WindowRect($h)
      $outer=New-Object DshInput+RECT; $outerOk=[DshInput]::GetWindowRect($h,[ref]$outer)
      return @{
        outerBounds = if($outerOk){@{x=$outer.Left;y=$outer.Top;width=($outer.Right-$outer.Left);height=($outer.Bottom-$outer.Top)}}else{$null}
        pid = [DshInput]::WindowPid($h)
        topLevel = ([DshInput]::RootOf($h) -eq $h)
        maximized = [DshInput]::IsZoomed($h)
        hwnd = [long]$h
        title = [DshInput]::WindowTitle($h)
        className = [DshInput]::WindowClass($h)
        visible = [DshInput]::IsWindowVisible($h)
        iconic = [DshInput]::IsIconic($h)
        rect = @{ x = $r[0]; y = $r[1]; w = $r[2]; h = $r[3] }
        foreground = ([long][DshInput]::GetForegroundWindow() -eq [long]$h)
      }
    }
    'setUserActiveMs' {
      [DshInput]::SetUserActiveMs([int]$req.ms)
      return Get-StatusResult
    }
    'move' {
      $x = [int]$req.x
      $y = [int]$req.y
      Commit-InputSource $req
      Show-InputIndicator $x $y
      Show-StateAt $script:cursorStyle $x $y
      return @{ ok = $true; via = 'overlay'; x = $x; y = $y; note = '只移动 AI 光标，没有移动主人的真实光标' }
    }
    'overlay' {
      if ($req.show -eq $false) { [DshOverlay]::Hide(); $headerReleased=[DshOverlay]::ReleaseSharedHeader(); return @{ ok = $headerReleased; visible = $false; sharedHeaderReleased=$headerReleased; cursorMode = $script:cursorMode; cursorState = $script:cursorStyle } }
      $preference=if($req.preferredMonitor){[string]$req.preferredMonitor}else{'secondary'}
      $preferred=[DshInput]::PreferredMonitor($preference)
      $x = if ($null -ne $req.x) { [int]$req.x } elseif ([DshOverlay]::HasLast) { [DshOverlay]::LastX } else { [int]($preferred.WorkingArea.X+$preferred.WorkingArea.Width/2) }
      $y = if ($null -ne $req.y) { [int]$req.y } elseif ([DshOverlay]::HasLast) { [DshOverlay]::LastY } else { [int]($preferred.WorkingArea.Y+$preferred.WorkingArea.Height/2) }
      if($null -ne $req.cursorSize){$script:cursorSize=if([int]$req.cursorSize -eq 0){0}else{[Math]::Max(24,[Math]::Min(192,[int]$req.cursorSize))}}
      if($req.cursorMode -in @('companion','clean')){$script:cursorMode=[string]$req.cursorMode}
      if($req.cursorState -and $script:styleNames -contains $req.cursorState){$script:cursorStyle=[string]$req.cursorState}
      [DshOverlay]::ConfigureForShow($script:cursorMode,$script:cursorHoldMs,$script:cursorSize,$script:cursorStyle)
      Commit-InputSource $req
      Show-InputIndicator $x $y
      [DshOverlay]::ShowStyledAt($x,$y,$script:cursorStyle)
      return @{ ok = [DshOverlay]::LastShowSucceeded; visible = [DshOverlay]::VisibleNow(); reason = if([DshOverlay]::LastShowSucceeded){$null}else{'overlay-position-failed'}; x = $x; y = $y; cursorMode = $script:cursorMode; cursorSize = $script:cursorSize; cursorSizeMode = if ($script:cursorSize -eq 0) { 'system' } else { 'manual' }; displaySize = ([DshOverlay]::Bounds())[2]; cursorState = $script:cursorStyle }
    }
    'pause' {
      $script:CurrentObservation = $null
      [DshInput]::Pause('api')
      if ([DshOverlay]::HasSessionTarget) { [DshOverlay]::ShowAt([DshOverlay]::LastX, [DshOverlay]::LastY) }
      return Get-StatusResult
    }
    'resume' {
      $script:CurrentObservation = $null
      [DshInput]::Resume()
      [DshOverlay]::SetStyle($script:cursorStyle)
      if ([DshOverlay]::HasSessionTarget) { [DshOverlay]::ShowAt([DshOverlay]::LastX, [DshOverlay]::LastY) }
      return Get-StatusResult
    }
    'click' {
      $x = [int]$req.x
      $y = [int]$req.y
      $button = if ($req.button) { [string]$req.button } else { 'left' }
      $count = if ($req.count) { [int]$req.count } else { 1 }
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      # Keep the existing hint until this validated action prepares its target.

      if ($mode -eq 'physical') {
        return @{
          ok = $false; reason = 'physical-mouse-forbidden'; strictNoRealMouse = $true
          note = '严格禁止动用真实鼠标；请改用 mode:"auto"（UIA / 窗口消息），不会移动主人的鼠标'
        }
      }

      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoRealMouse = $true
          note = '必须提供目标窗口 hwnd（先用 windows 拿 hwnd）；只按坐标点会点到主人正在用的窗口'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [DshInput]::IsWindow($target)) {
        return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd }
      }
      $root = [DshInput]::RootOf($target)
      $h = [DshInput]::ChildAt($root, $x, $y)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      $cls0 = [DshInput]::WindowClass($h)
      if ($button -eq 'left' -and $count -eq 1 -and $cls0 -match 'BUTTON|Button') {
        # BM_CLICK 直接让按钮发命令，不经过鼠标消息，也不抢焦点。
        Commit-InputSource $req
        Show-InputIndicator $x $y
        if(-not [DshInput]::PostMessage($h, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { return @{ok=$false;reason='message-post-failed';note='BM_CLICK未成功投递，不自动重发。'} }
        Show-StateAt 'link' $x $y
        return @{ ok = $true; via = 'bm_click'; hwnd = [long]$h; target = [long]$root; verified = $false; note = '按钮 BM_CLICK；不移动鼠标、不抢焦点' }
      }
      $r = @{ ok = $false }
      if ($mode -eq 'uia' -and $button -eq 'left' -and $count -eq 1) {
        $r = Invoke-UiaClickInWindow $root $x $y
      }
      if ($r.ok) {
        $state = if ($r.pattern -and ([string]$r.type -match 'Edit|Document|Text')) { 'text' } elseif ($r.pattern) { 'link' } else { 'pointer' }
        Show-StateAt $state $x $y
        $r['x'] = $x
        $r['y'] = $y
        $r['hwnd'] = [long]$root
        $r['button'] = $button
        $r['count'] = $count
        return $r
      }
      if ($r.attempted -or $r.paused) { return $r }
      $h = [DshInput]::ChildAt($root, $x, $y)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      Commit-InputSource $req
      Show-InputIndicator $x $y
      [DshInput]::PostMouseClick($h, $x, $y, ($button -eq 'right'), $count)
      $cls = [DshInput]::WindowClass($h)
      $state2 = 'pointer'
      if ($cls -match 'BUTTON|Button|SysLink|Toolbar|Menu') { $state2 = 'link' }
      elseif ($cls -match 'EDIT|Edit|TextBox') { $state2 = 'text' }
      Show-StateAt $state2 $x $y
      return @{
        ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root
        className = $cls; verified = $false
        note = '已投递给指定窗口；不移动真实鼠标，也不经过别的窗口'
      }

    }

    'type' {
      $text = [string]$req.text
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $replace = $false
      if ($null -ne $req.replace) { $replace = [bool]$req.replace }
      $hasPoint = ($null -ne $req.x -and $null -ne $req.y)
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      # Keep the existing hint until this validated action prepares its target.

      if ($mode -eq 'physical') {
        return @{
          ok = $false; reason = 'physical-keyboard-forbidden'; strictNoFocusSteal = $true
          note = '严格禁止抢输入焦点；physical 键盘会切前台，已禁用。请用 type 的 auto（UIA Value / 窗口消息）'
        }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoFocusSteal = $true
          note = '必须提供目标窗口 hwnd；不会把文字打进主人当前聚焦的输入框'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [DshInput]::IsWindow($target)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root = [DshInput]::RootOf($target)
      $h = $target
      if ($hasPoint) {
        $child = [DshInput]::ChildAt($root, [int]$req.x, [int]$req.y)
        if ($child -ne [IntPtr]::Zero) { $h = $child }
      }

      if($null -ne $keyboardRoot -and (-not [DshInput]::IsWindow($h) -or [long][DshInput]::RootOf($h) -ne $keyboardRoot)){return @{ok=$false;reason='keyboard-recipient-changed';refresh='observe';attempted=$false;inputSent=$false}}
      $cls = [DshInput]::WindowClass($h)
      if ($cls -match 'EDIT|Edit|TextBox') {
        $cur = [DshInput]::GetTextMessage($h)
        $want = if ($replace) { $text } else { $cur + $text }
        Commit-InputSource $req
      if ($hasPoint) { Show-InputIndicator ([int]$req.x) ([int]$req.y) } else { $ir=[DshInput]::WindowRect($h); Show-InputIndicator ([int]($ir[0]+$ir[2]/2)) ([int]($ir[1]+$ir[3]/2)) }
        $accepted = [DshInput]::SetTextMessage($h, $want)
        Start-Sleep -Milliseconds 60
        $now = [DshInput]::GetTextMessage($h)
        if ($accepted -and $now -ceq $want) {
          if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) } else { $tr = [DshInput]::WindowRect($h); Show-StateAt 'text' ([int]($tr[0]+$tr[2]/2)) ([int]($tr[1]+$tr[3]/2)) }
          return @{ ok = $true; via = 'wm_settext'; hwnd = [long]$h; target = [long]$root; verified = $true; note = '直接写入目标 Edit 控件，未抢焦点、未移动鼠标' }
        }
        # WM_SETTEXT may already have changed the control. Never send it again.
        return @{ ok = $false; reason = 'text-verification-failed'; hwnd = [long]$h; verified = $false; note = '已尝试写入但回读不一致；停止，重新观察，禁止自动重发' }
      }

      $r = @{ ok = $false }
      if ($mode -eq 'uia') { $r = Set-UiaTextInWindow $h $text $replace }
      if ($r.ok) {
        if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) } else { $tr = [DshInput]::WindowRect($h); Show-StateAt 'text' ([int]($tr[0]+$tr[2]/2)) ([int]($tr[1]+$tr[3]/2)) }
        $r['hwnd'] = [long]$h
        $r['target'] = [long]$root
        return $r
      }

      if ($r.attempted) {
        return @{ ok = $false; reason = 'uia-write-outcome-unknown'; hwnd = [long]$h; verified = $false; note = 'UIA 写入结果不确定；停止并重新观察，不再发送第二份文字' }
      }
      if ($replace) {
        return @{ ok = $false; reason = 'replace-unsupported'; hwnd = [long]$h; verified = $false; note = '此控件不支持已验证的覆盖写入；不会改为追加' }
      }

      Commit-InputSource $req
      if ($hasPoint) { Show-InputIndicator ([int]$req.x) ([int]$req.y) } else { $ir=[DshInput]::WindowRect($h); Show-InputIndicator ([int]($ir[0]+$ir[2]/2)) ([int]($ir[1]+$ir[3]/2)) }
      [DshInput]::PostText($h, $text)
      if ($hasPoint) { Show-StateAt 'text' ([int]$req.x) ([int]$req.y) } else { $tr = [DshInput]::WindowRect($h); Show-StateAt 'text' ([int]($tr[0]+$tr[2]/2)) ([int]($tr[1]+$tr[3]/2)) }
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root; verified = $false; note = '已向目标窗口投递文字；不抢焦点' }
    }
    'key' {
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      $raw = [string]$req.keys
      if ([string]::IsNullOrWhiteSpace($raw)) { return @{ ok = $false; reason = 'keys required' } }
      $names = $raw -split '\+'
      $vks = @()
      foreach ($n in $names) { $vks += (Get-Vk $n) }

      if ($mode -eq 'physical') {
        return @{
          ok = $false; reason = 'physical-keyboard-forbidden'; strictNoFocusSteal = $true
          note = '严格禁止抢输入焦点；physical 键盘会切前台，已禁用。请用 key 的 auto（窗口消息）'
        }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoFocusSteal = $true
          note = '必须提供目标窗口 hwnd；不会把按键打到主人当前聚焦的窗口'
        }
      }
      $h = [IntPtr]$targetHwnd
      if (-not [DshInput]::IsWindow($h)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root=[DshInput]::RootOf($h)
      if($null -ne $req.x -and $null -ne $req.y){$h=[DshInput]::ChildAt($root,[int]$req.x,[int]$req.y)}
      if($null -ne $keyboardRoot -and (-not [DshInput]::IsWindow($h) -or [long][DshInput]::RootOf($h) -ne $keyboardRoot)){return @{ok=$false;reason='keyboard-recipient-changed';refresh='observe';attempted=$false;inputSent=$false}}
      Commit-InputSource $req
      $ir=[DshInput]::WindowRect($h); Show-InputIndicator ([int]($ir[0]+$ir[2]/2)) ([int]($ir[1]+$ir[3]/2))
      $postedKeys = New-Object 'System.Collections.Generic.List[int]'
      try {
        foreach ($vk in $vks) { [DshInput]::PostKey($h, [int]$vk, $true, $false, $false); $postedKeys.Add([int]$vk) }
      } finally {
        $release = $postedKeys.ToArray()
        [Array]::Reverse($release)
        $releaseError=$null
        foreach ($vk in $release) { try { [DshInput]::PostKey($h, [int]$vk, $false, $false, $false) } catch { if($null -eq $releaseError){$releaseError=$_} } }
        if($null -ne $releaseError){throw ('message-post-failed-partial: key release '+$releaseError.Exception.Message)}
      }
      [DshInput]::CheckNotPaused()
      $script:cursorStyle = 'text'
      $kr = [DshInput]::WindowRect($h)
      Show-StateAt 'text' ([int]($kr[0]+$kr[2]/2)) ([int]($kr[1]+$kr[3]/2))
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target=[long]$root; className=[DshInput]::WindowClass($h); keys = $raw; verified = $false; note = '已向指定recipient投递按键；未主动请求激活，应用可能自行激活；尚未确认响应。' }
    }
    'scroll' {
      $x = [int]$req.x
      $y = [int]$req.y
      $delta = if ($req.delta) { [int]$req.delta } else { -120 }
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      # Keep the existing hint until this validated action prepares its target.

      if ($mode -eq 'physical') {
        return @{
          ok = $false; reason = 'physical-mouse-forbidden'; strictNoRealMouse = $true
          note = '严格禁止动用真实鼠标；滚轮请用 mode:"auto"（窗口消息）'
        }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoRealMouse = $true
          note = '必须提供目标窗口 hwnd；只按坐标滚动会滚到主人正在用的窗口'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [DshInput]::IsWindow($target)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root = [DshInput]::RootOf($target)
      $h = [DshInput]::ChildAt($root, $x, $y)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      Commit-InputSource $req
      Show-InputIndicator $x $y
      [DshInput]::PostMouseScroll($h, $x, $y, $delta)
      Show-StateAt 'vert' $x $y
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root; delta = $delta; verified = $false; note = '已投递给指定窗口；不移动真实鼠标' }
    }
    'drag' {
      $x1 = [int]$req.x
      $y1 = [int]$req.y
      $x2 = [int]$req.toX
      $y2 = [int]$req.toY
      $mode = if ($req.mode) { [string]$req.mode } else { 'auto' }
      $duration = if ($req.durationMs) { [int]$req.durationMs } else { 400 }
      $dx = $x2 - $x1
      $dy = $y2 - $y1
      $dragState = if ([Math]::Abs($dx) -gt [Math]::Abs($dy) * 1.6) { 'horz' }
                   elseif ([Math]::Abs($dy) -gt [Math]::Abs($dx) * 1.6) { 'vert' }
                   elseif ($dx * $dy -gt 0) { 'dgn1' }
                   elseif ($dx * $dy -lt 0) { 'dgn2' }
                   else { 'move' }
      $paused = Get-PausedResult
      if ($null -ne $paused) { return $paused }
      # Keep the existing hint until this validated action prepares its target.

      if ($mode -eq 'physical') {
        return @{
          ok = $false; reason = 'physical-mouse-forbidden'; strictNoRealMouse = $true
          note = '严格禁止动用真实鼠标；拖拽请用 mode:"auto"（窗口消息）'
        }
      }
      $targetHwnd = [long]$req.hwnd
      if ($targetHwnd -eq 0) {
        return @{
          ok = $false; reason = 'need-target-hwnd'; strictNoRealMouse = $true
          note = '必须提供目标窗口 hwnd；只按坐标拖拽会拖到主人正在用的窗口'
        }
      }
      $target = [IntPtr]$targetHwnd
      if (-not [DshInput]::IsWindow($target)) { return @{ ok = $false; reason = 'target-hwnd-invalid'; hwnd = $targetHwnd } }
      $root = [DshInput]::RootOf($target)
      $h = [DshInput]::ChildAt($root, $x1, $y1)
      if ($h -eq [IntPtr]::Zero) { $h = $root }
      Commit-InputSource $req
      Show-InputIndicator $x1 $y1
      [DshInput]::PostMouseDrag($h, $x1, $y1, $x2, $y2, [Math]::Max(8, [int]($duration / 20)))
      Show-StateAt $dragState $x2 $y2
      return @{ ok = $true; via = 'message-hwnd'; hwnd = [long]$h; target = [long]$root; verified = $false; note = '已投递给指定窗口；不移动真实鼠标' }
    }
    'capture' {
      $privacyHwnd=if($req.hwnd){[long]$req.hwnd}else{[long][DshInput]::GetForegroundWindow()}
      $privacy=Get-CaptureAuthPrivacy $privacyHwnd
      if($privacy.sensitive){return @{ok=$false;reason='authentication-url-screenshot-suppressed';privacy=$privacy}}
      $path = [string]$req.path
      if ([string]::IsNullOrWhiteSpace($path)) { throw 'path required' }
      if ($req.hwnd -and $req.screenCopy -ne $true) { return Capture-TargetWindow ([long]$req.hwnd) $path }
      $wasVisible = [DshOverlay]::VisibleNow()
      if ($wasVisible) { [DshOverlay]::Hide() }
      try {
        $dir = [System.IO.Path]::GetDirectoryName($path)
        if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
        if ($req.rect) {
          $parts = ([string]$req.rect) -split ','
          $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
        } else {
          $x = 0; $y = 0; $w = 0; $h = 0
        }
        if ($w -le 0 -or $h -le 0) {
          $screen = [DshInput]::VirtualBounds()
          $x = $screen.X; $y = $screen.Y; $w = $screen.Width; $h = $screen.Height
        }
        [DshInput]::CapturePng($path, $x, $y, $w, $h) | Out-Null
      } finally {
        if ($wasVisible -and [DshOverlay]::HasLast) {
          [DshOverlay]::ShowAt([DshOverlay]::LastX, [DshOverlay]::LastY)
        }
      }
      return @{ ok = $true; path = $path; method = 'screen-copy'; occlusionSafe = $false; mappingVerified = $true; rect = @{ x = $x; y = $y; width = $w; height = $h; scale = 1 }; imageSize = @{ width = $w; height = $h }; note = '显式屏幕区域采样，遮挡物会进入图像；不是隐藏窗口内容。' }
    }
    'overlayShot' {
      $path = [string]$req.path
      if ([string]::IsNullOrWhiteSpace($path)) { throw 'path required' }
      $dir = [System.IO.Path]::GetDirectoryName($path)
      if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
      $s = 0
      if ($null -ne $req.size) { $s = [int]$req.size }
      if ($s -le 0) { $s = $script:cursorSize }
      $bounds = [DshOverlay]::Bounds()
      [DshInput]::CapturePng($path, $bounds[0], $bounds[1], $s, $s) | Out-Null
      return @{ ok = $true; path = $path; x = $bounds[0]; y = $bounds[1]; size = $s }
    }
    'shutdown' {
      [DshOverlay]::Stop()
      [DshInput]::StopHooks()
      [DshInput]::StopHotkey()
      return @{ ok = $true }
    }
    default { throw "unknown command: $cmd" }
  }
}

# ---------------------------------------------------------------- main

$script:SessionFinished = ($env:DSH_INPUT_INITIAL_FINISHED -eq '1')
. (Join-Path $PSScriptRoot 'lib/observation.ps1')
. (Join-Path $PSScriptRoot 'lib/managed-chrome-launch.ps1')

$assetDir = Join-Path $PSScriptRoot 'assets/cursors'
if (-not (Test-Path -LiteralPath (Join-Path $assetDir 'pointer.png'))) {
  $assetDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../assets/cursors'))
}
try {
  [DshOverlay]::ConfigureStyles($assetDir)
  $metadataFile = Join-Path $assetDir 'cursor-metadata.json'
  if (Test-Path -LiteralPath $metadataFile) {
    $metadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $metadataFile | ConvertFrom-Json
    foreach ($property in $metadata.PSObject.Properties) {
      $value = $property.Value
      if ($value.cellSize) { [DshOverlay]::ConfigureSpriteLayout([int]$value.cellSize, [int]$value.columns) }
      [DshOverlay]::ConfigureStyleMetadata($property.Name, [double]$value.hotspot[0], [double]$value.hotspot[1], [int]$value.frameIntervalMs)
    }
  }
  [DshOverlay]::SetStyle($script:cursorStyle)
  [DshOverlay]::SetMode($script:cursorMode, $script:cursorHoldMs)
  [DshOverlay]::SetSize($script:cursorSize)
} catch { }

[DshInput]::StartHotkey()
[DshInput]::StartSharedPause()
$ready = @{
  event = 'ready'
  pid = $PID
  uia = $script:uia
  hotkey = 'Ctrl+Esc（active时）或Ctrl+Alt+Q'
  version = '0.7.6'
}
[Console]::Out.WriteLine((ConvertTo-Json $ready -Compress))
[Console]::Out.Flush()

try { while ($true) {
  $line = [DshInput]::ReadRequestLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Invoke-Request $req
    if ([DshInput]::Paused -and [string]$req.cmd -in @('click','type','key','scroll','drag','bounds','reveal') -and $result.ok -ne $false) {
      $result = @{ ok = $false; paused = $true; reason = 'paused-partial'; partial = 'possible'; pauseReason = [DshInput]::PauseReason; note = '已暂停；本条动作可能已部分完成，先观察，不自动重发。' }
    }
    if ($result -is [hashtable]) {
      $result['cursorState'] = if ([DshInput]::Paused) { 'unavailiable' } else { $script:cursorStyle }
    }
    $resp = @{ id = $id; ok = $true; result = $result }
  } catch {
    if ([DshInput]::Paused -and [string]$req.cmd -in @('click','type','key','scroll','drag','bounds','reveal')) {
      $resp = @{ id = $id; ok = $true; result = @{ ok = $false; paused = $true; reason = 'paused-partial'; partial = 'possible'; pauseReason = [DshInput]::PauseReason; note = '已停止后续投递；可能部分完成，仅清理同目标已按下的键/按钮，不自动重发。' } }
    } else { $resp = @{ id = $id; ok = $false; error = $_.Exception.Message } }
  }
  [Console]::Out.WriteLine((ConvertTo-Json $resp -Compress -Depth 16))
  [Console]::Out.Flush()
  if ($req.cmd -eq 'shutdown') { break }
} } finally {
  [DshInput]::SessionActive = $false
  $script:CurrentObservation = $null
  [DshInput]::StopOwnedCapture()
  [DshInput]::EmitPauseState()
  [DshOverlay]::Stop()
  [DshInput]::StopHooks()
  [DshInput]::StopHotkey()
}
