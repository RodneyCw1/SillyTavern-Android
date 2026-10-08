param()
$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$InstalledLibraries=@()
$SourceInfo=Get-Content (Join-Path $ProjectRoot 'docs/node-source.json') -Raw | ConvertFrom-Json
foreach ($Abi in @('arm64-v8a','x86_64')) {
    $Built=Join-Path $ProjectRoot ".local/runtime22/$Abi"
    if (-not (Test-Path -LiteralPath "$Built/libnode.so")) { throw "Build Node $($SourceInfo.version) for $Abi first" }
    $Loads=@(Get-Content "$Built/elf-program-headers.txt" | Where-Object { $_ -match '^\s*LOAD\s' })
    if ($Loads.Count -eq 0) { throw "No ELF LOAD segments for $Abi" }
    foreach ($Line in $Loads) {
        $Alignment=($Line.Trim() -split '\s+')[-1]
        if ([Convert]::ToInt64($Alignment.Substring(2),16) -lt 16384) { throw "ELF alignment failed for $Abi" }
    }
    $InstalledLibraries+=@{abi=$Abi;sha256=(Get-FileHash -LiteralPath "$Built/libnode.so" -Algorithm SHA256).Hash.ToLowerInvariant()}
    $Native=Join-Path $ProjectRoot "android/app/src/main/jniLibs/$Abi"
    $Evidence=Join-Path $ProjectRoot "vendor/runtime/$Abi"
    New-Item -ItemType Directory $Native,$Evidence -Force | Out-Null
    Copy-Item -LiteralPath "$Built/libnode.so" -Destination "$Native/libnode.so" -Force
    Copy-Item -LiteralPath "$Built/libnode.so","$Built/elf-program-headers.txt","$Built/elf-dynamic.txt" -Destination $Evidence -Force
}
$HeaderCache=Join-Path $ProjectRoot '.local/node22-headers'
$Headers=Join-Path $HeaderCache 'include/node'
$Receipt=Join-Path $HeaderCache 'source-sha256.txt'
if (-not (Test-Path -LiteralPath $Receipt) -or ([IO.File]::ReadAllText($Receipt).Trim() -ne $SourceInfo.sourceSha256)) {
    $LinuxProject=(& wsl.exe -d SillyTavernAndroidBuild -- wslpath -u $ProjectRoot).Trim()
    & wsl.exe -d SillyTavernAndroidBuild -- python3 /opt/st-android-build/node22-arm64/tools/install.py install --headers-only --root-dir /opt/st-android-build/node22-arm64 --dest-dir "$LinuxProject/.local/node22-headers" --prefix / --silent
    if ($LASTEXITCODE -ne 0) { throw 'Node header export failed' }
    [IO.File]::WriteAllText($Receipt,$SourceInfo.sourceSha256,[Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath "$Headers/node.h")) { throw 'Export Node 22 headers with tools/install.py --headers-only first' }
$Target=[IO.Path]::GetFullPath((Join-Path $ProjectRoot 'android/app/src/main/cpp/node-include'))
$Allowed=[IO.Path]::GetFullPath((Join-Path $ProjectRoot 'android/app/src/main/cpp'))
if ($Target -ne (Join-Path $Allowed 'node-include')) { throw 'Unexpected header target' }
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
Copy-Item -LiteralPath $Headers -Destination $Target -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'docs/node-source.json') -Destination (Join-Path $ProjectRoot 'vendor/runtime/node-source.json') -Force
$Installed=@{version=$SourceInfo.version;sourceSha256=$SourceInfo.sourceSha256;libraries=$InstalledLibraries}
[IO.File]::WriteAllText((Join-Path $ProjectRoot 'vendor/runtime/installed.json'),($Installed | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Write-Output "Installed Node $($SourceInfo.version) libraries and headers"
