$ErrorActionPreference='Stop'
. "$PSScriptRoot/../lib/auth-privacy.ps1"
$secret='fixture-credential-123'
$url="https://qa.example.test/auth/login?key=$secret&lang=zh"
$o=@{window=@{title=$url};elements=@(@{elementId='e1';name=$url;value=$url;automationId='link';rect=@{x=1}})}
$out=Protect-PublicObservation $o
if(($out|ConvertTo-Json -Depth 8) -match $secret){throw 'public observation leaks fixture credential'}
if(-not $out.authUrlSecretsDetected -or $out.elements[0].elementId -ne 'e1' -or $out.elements[0].rect.x -ne 1){throw 'metadata/locator contract broken'}
$plain='https://shop.test/products?key=sku&code=item'
if((Protect-AuthUrlText $plain) -cne $plain){throw 'ordinary URL altered'}
Write-Output 'PASS public PowerShell projection redacts auth URL and preserves ordinary URL, IDs and geometry'
