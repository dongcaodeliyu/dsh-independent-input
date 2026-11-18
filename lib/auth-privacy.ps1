# Public copy only: full observation signatures stay process-local for guards.
function Protect-AuthUrlText([string]$text) {
  return [regex]::Replace($text, 'https?://[^\s<>"'']+', {
    param($match)
    $uri=$null
    if(-not [Uri]::TryCreate($match.Value,[UriKind]::Absolute,[ref]$uri)){return $match.Value}
    $auth=$uri.AbsolutePath -match '(?:^|[/_.-])(?:auth|oauth2?|login|signin|sign-in|callback|verify|verification|magic-link)(?:[/_.-]|$)'
    return [regex]::Replace($match.Value,'([?&#])([^=&#]+)=([^&#]*)',{
      param($parameter)
      try {$key=[Uri]::UnescapeDataString($parameter.Groups[2].Value)} catch {return $parameter.Value}
      $pattern=if($auth){'^(key|code|token|ticket|secret|access_token|id_token|refresh_token|auth_token)$'}else{'^(access_token|id_token|refresh_token|auth_token)$'}
      if($key -match $pattern){return $parameter.Groups[1].Value+$parameter.Groups[2].Value+'=[REDACTED]'}
      return $parameter.Value
    })
  },[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Protect-PublicObservation($observation) {
  $detected=$false
  foreach($node in $observation.elements){foreach($key in @('name','value','automationId')){if($null -ne $node[$key]){$before=[string]$node[$key];$node[$key]=Protect-AuthUrlText $before;if($before -cne $node[$key]){$detected=$true}}}}
  $title=[string]$observation.window.title;$observation.window.title=Protect-AuthUrlText $title
  if($title -cne $observation.window.title){$detected=$true}
  if($detected){$observation.authUrlSecretsDetected=$true}
  return $observation
}
function Get-CaptureAuthPrivacy([long]$hwnd) {
  $title=[DshInput]::WindowTitle([IntPtr]$hwnd)
  if((Protect-AuthUrlText $title) -cne $title){return @{checked=$true;sensitive=$true}}
  if(-not $script:uia){return @{checked=$false;reason='uia-unavailable'}}
  try {
    $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if($null -eq $root){return @{checked=$false;reason='uia-no-window'}}
    $pending=New-Object 'System.Collections.Generic.Queue[object]';$pending.Enqueue($root);$count=0;$truncated=$false
    while($pending.Count -gt 0 -and $count -lt 500){
      $el=$pending.Dequeue();$count++;$texts=@([string]$el.Current.Name,[string]$el.Current.AutomationId)
      if(-not $el.Current.IsPassword){try{$vp=$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$texts+=[string]$vp.Current.Value}catch{}}
      foreach($text in $texts){if((Protect-AuthUrlText $text) -cne $text){return @{checked=$true;sensitive=$true}}}
      $child=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($el)
      while($null -ne $child -and $pending.Count+$count -lt 500){$pending.Enqueue($child);$child=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)}
      if($null -ne $child){$truncated=$true}
    }
    return @{checked=($pending.Count -eq 0 -and -not $truncated);sensitive=$false}
  }catch{return @{checked=$false;reason='uia-unavailable'}}
}
