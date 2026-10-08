param([string]$Bundle)
$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$Pin=Get-Content -LiteralPath (Join-Path $ProjectRoot 'docs/runtime-bundle.json') -Raw | ConvertFrom-Json
$Source=Get-Content -LiteralPath (Join-Path $ProjectRoot 'docs/node-source.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath (Join-Path $ProjectRoot 'scripts/patch-node22.py') -Algorithm SHA256).Hash -ne $Pin.patchSha256) { throw 'Runtime patch source differs from pinned bundle' }
if ($Pin.sourceSha256 -ne $Source.sourceSha256 -or $Pin.nodeVersion -ne $Source.version) { throw 'Runtime pin does not match Node source' }
$Downloads=Join-Path $ProjectRoot '.local/downloads'
New-Item -ItemType Directory -Path $Downloads -Force | Out-Null
if (-not $Bundle) {
    $Bundle=Join-Path $Downloads $Pin.fileName
    if (-not (Test-Path -LiteralPath $Bundle)) {
        curl.exe --silent --show-error --fail --location --retry 3 --output $Bundle $Pin.url
        if ($LASTEXITCODE -ne 0) { throw 'Runtime bundle download failed' }
    }
}
if ((Get-FileHash -LiteralPath $Bundle -Algorithm SHA256).Hash -ne $Pin.sha256) { throw 'Runtime bundle checksum mismatch' }
$Stage=Join-Path $ProjectRoot ".local/runtime-import-$($Pin.sha256.Substring(0,12))"
New-Item -ItemType Directory -Path $Stage -Force | Out-Null
Expand-Archive -LiteralPath $Bundle -DestinationPath $Stage -Force
$Installed=Get-Content -LiteralPath (Join-Path $Stage 'libraries/installed.json') -Raw | ConvertFrom-Json
if ($Installed.sourceSha256 -ne $Source.sourceSha256 -or $Installed.version -ne $Source.version) { throw 'Runtime receipt does not match pinned source' }
if (-not (Test-Path -LiteralPath "$Stage/headers/node.h")) { throw 'Runtime headers missing' }
foreach ($Abi in @('arm64-v8a','x86_64')) {
    $Library=Join-Path $Stage "libraries/$Abi/libnode.so"
    $Record=$Installed.libraries | Where-Object { $_.abi -eq $Abi }
    if (-not $Record -or (Get-FileHash -LiteralPath $Library -Algorithm SHA256).Hash -ne $Record.sha256) { throw "Runtime library checksum mismatch: $Abi" }
    $Loads=@(Get-Content -LiteralPath "$Stage/libraries/$Abi/elf-program-headers.txt" | Where-Object { $_ -match '^\s*LOAD\s' })
    if (-not $Loads.Count) { throw "Runtime ELF evidence missing: $Abi" }
    foreach ($Line in $Loads) {
        $Alignment=($Line.Trim() -split '\s+')[-1]
        if ([Convert]::ToInt64($Alignment.Substring(2),16) -lt 16384) { throw "Runtime ELF alignment invalid: $Abi" }
    }
    $Target=Join-Path $ProjectRoot "android/app/src/main/jniLibs/$Abi"
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Copy-Item -LiteralPath $Library -Destination "$Target/libnode.so" -Force
}
$Vendor=Join-Path $ProjectRoot 'vendor/runtime'
New-Item -ItemType Directory -Path $Vendor -Force | Out-Null
Copy-Item -Path "$Stage/libraries/*" -Destination $Vendor -Recurse -Force
$Headers=Join-Path $ProjectRoot 'android/app/src/main/cpp/node-include'
New-Item -ItemType Directory -Path $Headers -Force | Out-Null
Copy-Item -Path "$Stage/headers/*" -Destination $Headers -Recurse -Force
Write-Output "Installed verified Node $($Source.version), ARM64 + x86_64, 16 KB."
