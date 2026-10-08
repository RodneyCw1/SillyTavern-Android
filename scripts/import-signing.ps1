param([Parameter(Mandatory)][string]$Certificate, [string]$Destination)
$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination=Join-Path (Split-Path -Parent $ProjectRoot) 'SillyTavern-Android-Signing' }
$Source=[IO.Path]::GetFullPath($Certificate)
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw 'Certificate file not found' }
$Secret=Read-Host 'Original certificate password (not saved as plain text)' -AsSecureString
$Pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
try {
    $env:ST_ANDROID_STORE_PASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    $env:ST_ANDROID_KEY_PASSWORD=$env:ST_ANDROID_STORE_PASSWORD
    $env:ST_ANDROID_KEYSTORE=$Source
    . (Join-Path $PSScriptRoot 'environment.ps1')
    . (Join-Path $PSScriptRoot 'signing.ps1')
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $Target=Join-Path $Destination 'sillytavern-release.p12'
    if ([IO.Path]::GetFullPath($Target) -ne $Source) { Copy-Item -LiteralPath $Source -Destination $Target -Force }
    $Secret | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $Destination 'password.dpapi')
    Write-Output 'Certificate imported. Keep this directory private and back up the original certificate/password separately.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
    Remove-Item Env:ST_ANDROID_STORE_PASSWORD,Env:ST_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
}
