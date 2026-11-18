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
