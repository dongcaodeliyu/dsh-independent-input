# Shortcut metadata adaptation only. Never edits original shortcut/profile or
# inspects running browser command lines; never logs arguments/profile/URLs.
if(-not('ManagedChromeArguments' -as [type])){Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;
public static class ManagedChromeArguments {
 public static string[] Parse(string text){
  var words=new List<string>();int i=0;
  while(i<text.Length){while(i<text.Length&&char.IsWhiteSpace(text[i]))i++;if(i==text.Length)break;var word=new StringBuilder();bool quoted=false;
   while(i<text.Length&&(quoted||!char.IsWhiteSpace(text[i]))){
    int slash=0;while(i<text.Length&&text[i]=='\\'){slash++;i++;}
    if(i<text.Length&&text[i]=='"'){word.Append('\\',slash/2);if(slash%2!=0){word.Append('"');i++;}else if(quoted&&i+1<text.Length&&text[i+1]=='"'){word.Append('"');i+=2;}else{quoted=!quoted;i++;}}
    else{word.Append('\\',slash);if(i<text.Length&&(quoted||!char.IsWhiteSpace(text[i])))word.Append(text[i++]);}
   }
   if(quoted)throw new ArgumentException("unclosed argument quote");words.Add(word.ToString());
  }
  return words.ToArray();
 }
}
'@}
function Prepare-ManagedChromeLaunch([string]$Path,[string]$TemporaryRoot=(Join-Path ([IO.Path]::GetTempPath()) 'dsh-independent-input-launch')) {
 $temporary=$null
 $result=@{path=$Path;temporaryPath=$null;adaptation=@{eligible=$false;flagRequested=$false;effect='unverified';reason='not-managed-chrome-shortcut'}}
 if([IO.Path]::GetExtension($Path)-ine'.lnk'){return $result}
 try {
  $shell=New-Object -ComObject WScript.Shell;$original=$shell.CreateShortcut($Path)
  if([IO.Path]::GetFileName([string]$original.TargetPath)-ine'chrome.exe'-or-not[IO.File]::Exists([string]$original.TargetPath)){return $result}
  if([Diagnostics.FileVersionInfo]::GetVersionInfo([string]$original.TargetPath).ProductName-ine'Google Chrome'){return $result}
  $arguments=[ManagedChromeArguments]::Parse([string]$original.Arguments);$profiles=@()
  for($i=0;$i-lt$arguments.Count;$i++){
   if($arguments[$i]-ceq'--user-data-dir'){if($i+1-ge$arguments.Count){return $result};$profiles+=,$arguments[++$i]}
   elseif($arguments[$i].StartsWith('--user-data-dir=',[StringComparison]::Ordinal)){$profiles+=,$arguments[$i].Substring(16)}
  }
  if($profiles.Count-ne1-or$profiles[0]-notmatch'^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)'){return $result}
  $profile=[IO.Path]::GetFullPath($profiles[0]);$default=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Google/Chrome/User Data'
  if($profile.TrimEnd('\','/').Equals($default.TrimEnd('\','/'),[StringComparison]::OrdinalIgnoreCase)-or$profile.StartsWith($default.TrimEnd('\','/')+'\',[StringComparison]::OrdinalIgnoreCase)){return $result}
  $result.adaptation=@{eligible=$true;flagRequested=$true;effect='unverified';existingProfileProcess='not-checked';reason='managed-chrome-occlusion-request';newFlag=$false}
  if(@($arguments|Where-Object {$_-ceq'--disable-backgrounding-occluded-windows'-or$_.StartsWith('--disable-backgrounding-occluded-windows=',[StringComparison]::Ordinal)}).Count){return $result}
  [IO.Directory]::CreateDirectory($TemporaryRoot)|Out-Null
  $temporary=Join-Path $TemporaryRoot ([Guid]::NewGuid().ToString('N')+'.lnk');$copy=$shell.CreateShortcut($temporary)
  $copy.TargetPath=$original.TargetPath;$copy.Arguments=([string]$original.Arguments)+' --disable-backgrounding-occluded-windows';$copy.WorkingDirectory=$original.WorkingDirectory;$copy.WindowStyle=$original.WindowStyle;$copy.IconLocation=$original.IconLocation;$copy.Save()
  $check=$shell.CreateShortcut($temporary)
  if($check.TargetPath-cne$copy.TargetPath-or$check.Arguments-cne$copy.Arguments-or$check.WorkingDirectory-cne$original.WorkingDirectory){throw 'shortcut-copy-readback-mismatch'}
  $result.path=$temporary;$result.temporaryPath=$temporary;$result.adaptation.newFlag=$true;return $result
 }catch{
  if($temporary-and[IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}
  return @{path=$Path;temporaryPath=$null;adaptation=@{eligible=$false;flagRequested=$false;effect='unverified';reason='shortcut-inspection-unavailable'}}
 }
}
