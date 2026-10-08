param([switch]$Emulators, [switch]$SkipDependencies)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'environment.ps1')
$Downloads=Join-Path $ProjectRoot '.local/downloads'
New-Item -ItemType Directory $Downloads -Force | Out-Null
function Get-VerifiedFile($Url,$File,$Sha256) {
    if (-not (Test-Path -LiteralPath $File)) {
        & curl.exe --fail --location --retry 3 --output $File $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    }
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Sha256) { throw "Checksum mismatch: $File" }
}
if (-not (Test-Path -LiteralPath "$env:ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat")) {
    $Zip=Join-Path $Downloads 'commandlinetools-win.zip'
    Get-VerifiedFile 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip' $Zip '98B565CB657B012DAE6794CEFC0F66AE1EFB4690C699B78A614B4A6A3505B003'
    $Stage=Join-Path $ProjectRoot '.local/sdk-stage'
    Expand-Archive -LiteralPath $Zip -DestinationPath $Stage -Force
    New-Item -ItemType Directory "$env:ANDROID_HOME/cmdline-tools/latest" -Force | Out-Null
    Copy-Item -LiteralPath "$Stage/cmdline-tools/bin","$Stage/cmdline-tools/lib","$Stage/cmdline-tools/NOTICE.txt","$Stage/cmdline-tools/source.properties" -Destination "$env:ANDROID_HOME/cmdline-tools/latest" -Recurse -Force
}
if (-not (Test-Path -LiteralPath "$ProjectRoot/.local/gradle-8.13/bin/gradle.bat")) {
    $Zip=Join-Path $Downloads 'gradle-8.13-bin.zip'
    Get-VerifiedFile 'https://services.gradle.org/distributions/gradle-8.13-bin.zip' $Zip '20F1B1176237254A6FC204D8434196FA11A4CFB387567519C61556E8710AED78'
    Expand-Archive -LiteralPath $Zip -DestinationPath "$ProjectRoot/.local" -Force
}
# SDK license text is presented by sdkmanager. The accepted licenses stay project-local.
1..30 | ForEach-Object { 'y' } | & "$env:ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" --licenses
$Packages=@('platform-tools','platforms;android-36','build-tools;36.0.0','build-tools;35.0.0','ndk;28.2.13676358','cmake;3.22.1')
if ($Emulators) { $Packages+=@('emulator','system-images;android-29;google_apis;x86_64','system-images;android-35;google_apis_ps16k;x86_64') }
& "$env:ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" @Packages
if ($LASTEXITCODE -ne 0) { throw 'SDK installation failed' }
if ($SkipDependencies) { return }
Push-Location $ProjectRoot
try {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Build dependency installation failed' }
    & npm.cmd --prefix server ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Server dependency installation failed' }
} finally { Pop-Location }
