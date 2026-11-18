# Offline regression: executes the actual type request branch against an in-memory
# target. No Win32 calls, UI Automation providers, windows, or input are used.
$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../sidecar.ps1')
$start = $source.IndexOf("    'type' {")
$end = $source.IndexOf("    'key' {", $start)
$branch = $source.Substring($start, $end - $start)
Add-Type -TypeDefinition @'
using System;
public static class DshOverlay { public static void Hide() {} }
public static class DshInput {
  public static string Text = "";
  public static string ClassName = "WindowsForms10.EDIT.app.fixture";
  public static int Writes = 0;
  public static int Posts = 0;
  public static bool CorruptSet = false;
  public static bool IsWindow(IntPtr h) { return true; }
  public static IntPtr RootOf(IntPtr h) { return h; }
  public static IntPtr ChildAt(IntPtr h, int x, int y) { return new IntPtr(2); }
  public static string WindowClass(IntPtr h) { return ClassName; }
  // Cross-process GetWindowText cannot read another application's Edit text.
  public static string GetWindowText(IntPtr h) { return ""; }
  public static string GetTextMessage(IntPtr h) { return Text; }
  public static bool SetTextMessage(IntPtr h, string text) { Text=CorruptSet ? "wrong" : text; Writes++; return true; }
  public static void PostText(IntPtr h, string text) { Text+=text; Posts++; }
}
'@
function Get-PausedResult { return $null }
function Show-StateAt { }
function Show-InputIndicator { }
$script:uiaAttempted = $false; $script:uiaCalls=0
function Set-UiaTextInWindow { $script:uiaCalls++; return @{ ok=$false; attempted=$script:uiaAttempted; reason='fixture-provider-unavailable' } }
Invoke-Expression ('function Invoke-TestType($req) { switch ($req.cmd) {' + $branch + '} }')
$text = 'Codex' + [char]0x4e3b + [char]0x5c4f + ' Test A'
$req = @{ cmd='type'; hwnd=1; x=10; y=10; text=$text; replace=$true; mode='auto' }
$result = Invoke-TestType $req
if ([DshInput]::Text -cne $text -or [DshInput]::Writes -ne 1 -or [DshInput]::Posts -ne 0 -or -not $result.verified) {
  throw ('Unicode replacement must write exactly once and verify. writes={0} posts={1} text={2}' -f [DshInput]::Writes,[DshInput]::Posts,[DshInput]::Text)
}
$req.replace=$false; $req.text=' +append'
$result=Invoke-TestType $req
if ([DshInput]::Text -cne ($text+' +append')) { throw 'append lost existing Edit text' }
[DshInput]::CorruptSet=$true; $req.replace=$true
$before=[DshInput]::Posts; $result=Invoke-TestType $req
if ($result.ok -or [DshInput]::Posts -ne $before) { throw 'unverified native write must not fall through and send text again' }
[DshInput]::ClassName='OtherControl'; [DshInput]::CorruptSet=$false
$result=Invoke-TestType $req
if ($result.ok -or [DshInput]::Posts -ne $before) { throw 'unsupported replace must not silently append' }
if($script:uiaCalls -ne 0){throw 'legacy auto must not call provider'}
$req.mode='uia'; $script:uiaAttempted=$true; $req.replace=$false
$result=Invoke-TestType $req
if ($result.ok -or [DshInput]::Posts -ne $before) { throw 'UIA may have written before failure; no second delivery is permitted' }
if ($source -notmatch 'EntryPoint\s*=\s*"PostMessageW"') { throw 'WM_CHAR must use explicit Unicode PostMessageW' }
Write-Output 'PASS: actual type branch Unicode replace/append, no duplicate fallback, unsupported replace, UIA ambiguous failure, Unicode WM_CHAR declaration'
