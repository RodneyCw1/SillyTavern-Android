param()
$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$SigningRoot=Join-Path (Split-Path -Parent $ProjectRoot) 'SillyTavern-Android-Signing'
if (-not $env:ST_ANDROID_KEYSTORE) { $env:ST_ANDROID_KEYSTORE=Join-Path $SigningRoot 'sillytavern-release.p12' }
if (-not (Test-Path -LiteralPath $env:ST_ANDROID_KEYSTORE -PathType Leaf)) { throw 'Original signing certificate missing. Import it privately; never generate a replacement release key.' }
if (-not $env:ST_ANDROID_STORE_PASSWORD) {
    $PasswordPath=if ($env:ST_ANDROID_PASSWORD_FILE) { $env:ST_ANDROID_PASSWORD_FILE } else { Join-Path (Split-Path -Parent $env:ST_ANDROID_KEYSTORE) 'password.dpapi' }
    if (-not (Test-Path -LiteralPath $PasswordPath)) { throw 'Signing password missing. Run scripts/import-signing.ps1 on this Windows account.' }
    $SecurePassword=(Get-Content -LiteralPath $PasswordPath -Raw).Trim() | ConvertTo-SecureString
    $Pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
    try { $env:ST_ANDROID_STORE_PASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
}
if (-not $env:ST_ANDROID_KEY_PASSWORD) { $env:ST_ANDROID_KEY_PASSWORD=$env:ST_ANDROID_STORE_PASSWORD }
$Jdk=if ($env:ST_ANDROID_JAVA_HOME) { $env:ST_ANDROID_JAVA_HOME } else { $env:JAVA_HOME }
$CertOutput=& "$Jdk/bin/keytool.exe" -list -v -storetype PKCS12 -keystore $env:ST_ANDROID_KEYSTORE -storepass:env ST_ANDROID_STORE_PASSWORD -alias sillytavern 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Cannot open original signing key; check credentials.' }
$Expected=(Get-Content -LiteralPath (Join-Path $ProjectRoot 'release-config.json') -Raw | ConvertFrom-Json).signingSha256
$Normalized=$CertOutput -replace ':',''
if ($Normalized -notmatch [regex]::Escape($Expected)) { throw 'Signing certificate differs from installed releases; refusing to build.' }
Write-Output 'Original release certificate verified.'
