# Called before sidecar imports/compilation, WinForms or keyboard hooks.
# Only internal v3 clients set the launch permit environment; model tool args
# never supply it. Legacy v2 does not enable this branch.
function Wait-ExecutorPermit {
  if(-not $env:DSH_INPUT_STARTUP_PERMIT){return}
  [Console]::Out.WriteLine('{"event":"bootstrap-waiting"}')
  [Console]::Out.Flush()
  $line=[Console]::ReadLine()
  if($null-eq$line){exit 73}
  try{$permit=$line|ConvertFrom-Json}catch{exit 73}
  if($permit.cmd-cne'__launch'-or$permit.permit-cne$env:DSH_INPUT_STARTUP_PERMIT){exit 73}
  # Do not let a later request inherit/reuse the startup capability.
  $env:DSH_INPUT_STARTUP_PERMIT=$null
}
