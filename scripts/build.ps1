param([ValidateSet('Debug','Release')][string]$Variant='Release', [switch]$SkipAssets)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'environment.ps1')
if ($Variant -eq 'Release' -and (-not $env:ST_ANDROID_VERSION_NAME -or -not $env:ST_ANDROID_VERSION_CODE)) { throw 'Release version parameters required. Use the published update.json values; CI allocates new versions.' }
Push-Location $ProjectRoot
try {
    $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not $SkipAssets) {
        & $NodeExe scripts/prepare-runtime.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Runtime preparation failed' }
    }
    $CurrentSourceHash = & $NodeExe --input-type=module -e 'import { getSourceHash } from "./scripts/source-inventory.mjs"; console.log(await getSourceHash(process.cwd()));'
    if ($LASTEXITCODE -ne 0) { throw 'Source identity calculation failed' }
    $RuntimeMetadata = Get-Content -LiteralPath 'android/app/src/main/assets/runtime.json' -Raw | ConvertFrom-Json
    if ($RuntimeMetadata.sourceHash -ne $CurrentSourceHash -or $RuntimeMetadata.runtimeSha256 -ne (Get-FileHash -LiteralPath 'android/app/src/main/assets/runtime.zip' -Algorithm SHA256).Hash) { throw 'Runtime assets do not match the current source. Rebuild without -SkipAssets.' }
    $ExpectedRuntime=Get-Content docs/node-source.json -Raw | ConvertFrom-Json
    $InstalledRuntime=Get-Content vendor/runtime/installed.json -Raw | ConvertFrom-Json
    if ($InstalledRuntime.version -ne $ExpectedRuntime.version -or $InstalledRuntime.sourceSha256 -ne $ExpectedRuntime.sourceSha256) { throw 'Install the pinned Node runtime before building' }
    foreach ($Library in $InstalledRuntime.libraries) {
        $CurrentHash=(Get-FileHash -Algorithm SHA256 -LiteralPath "android/app/src/main/jniLibs/$($Library.abi)/libnode.so").Hash
        if ($CurrentHash -ne $Library.sha256) { throw "Native runtime checksum mismatch: $($Library.abi)" }
    }
    if ($Variant -eq 'Release') {
        . (Join-Path $PSScriptRoot 'signing.ps1')
        foreach ($Abi in @('arm64-v8a','x86_64')) {
            if (-not (Test-Path -LiteralPath "vendor/runtime/$Abi/elf-program-headers.txt")) { throw "Source-built 16 KB runtime is missing for $Abi" }
        }
    }
    & "$ProjectRoot/.local/gradle-8.13/bin/gradle.bat" -p android "assemble$Variant" --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
    $BuiltSourceHash = & $NodeExe --input-type=module -e 'import { getSourceHash } from "./scripts/source-inventory.mjs"; console.log(await getSourceHash(process.cwd()));'
    if ($LASTEXITCODE -ne 0 -or $BuiltSourceHash -ne $CurrentSourceHash) { throw 'Source changed during APK compilation. Rebuild before publishing artifacts.' }
    New-Item -ItemType Directory releases -Force | Out-Null
    $Lower = $Variant.ToLowerInvariant()
    $Apk = "android/app/build/outputs/apk/$Lower/app-$Lower.apk"
    $AppVersion = $RuntimeMetadata.appVersion
    $Deliverable = "releases/SillyTavern-Android-$AppVersion-$Lower.apk"
    Copy-Item -LiteralPath $Apk -Destination $Deliverable -Force
    & "$env:ANDROID_HOME/build-tools/36.0.0/apksigner.bat" verify --verbose --print-certs $Deliverable
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
    if ($Variant -eq 'Release') {
        $CertificateOutput=& "$env:ANDROID_HOME/build-tools/36.0.0/apksigner.bat" verify --print-certs $Deliverable | Out-String
        $ExpectedCertificate=(Get-Content -LiteralPath 'release-config.json' -Raw | ConvertFrom-Json).signingSha256
        if ($CertificateOutput -notmatch [regex]::Escape($ExpectedCertificate)) { throw 'Release APK does not use the original certificate' }
    }
    & "$env:ANDROID_HOME/build-tools/36.0.0/zipalign.exe" -c -P 16 -v 4 $Deliverable | Select-Object -Last 2
    if ($LASTEXITCODE -ne 0) { throw 'APK 16 KB ZIP alignment verification failed' }
    Get-FileHash -Algorithm SHA256 -LiteralPath $Deliverable
} finally {
    Remove-Item Env:ST_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ST_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
    Pop-Location
}
