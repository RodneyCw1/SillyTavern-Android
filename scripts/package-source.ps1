$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot
try {
    New-Item -ItemType Directory releases -Force | Out-Null
    & node scripts/package-source.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Source archive creation failed' }
    & node scripts/write-checksums.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Checksum inventory failed' }
} finally { Pop-Location }
