$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'environment.ps1')
$Distro='SillyTavernAndroidBuild'
$Distros=(& wsl.exe --list --quiet) -replace [char]0,''
if ($Distros -notcontains $Distro) {
    $Image=Join-Path $ProjectRoot '.local/downloads/ubuntu-24.04.4-wsl-amd64.wsl'
    New-Item -ItemType Directory (Split-Path -Parent $Image) -Force | Out-Null
    if (-not (Test-Path -LiteralPath $Image)) {
        & curl.exe -fL --retry 3 -o $Image 'https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-wsl-amd64.wsl'
        if ($LASTEXITCODE -ne 0) { throw 'Ubuntu image download failed' }
    }
    if ((Get-FileHash -LiteralPath $Image -Algorithm SHA256).Hash -ne '9B2F7730DC68227DD04A9F3E5EAB86AD85CAF556B8606AD94F1F29FF5C4FD3F5') { throw 'Ubuntu image checksum mismatch' }
    & wsl.exe --import $Distro "$ProjectRoot/.local/wsl-build" $Image --version 2
    if ($LASTEXITCODE -ne 0) { throw 'WSL import failed; enable Windows WSL 2 first' }
}
$LinuxProject=(& wsl.exe -d $Distro -- wslpath -u $ProjectRoot).Trim()
& wsl.exe -d $Distro -u root -- bash "$LinuxProject/scripts/setup-linux.sh"
if ($LASTEXITCODE -ne 0) { throw 'Linux build environment setup failed' }
