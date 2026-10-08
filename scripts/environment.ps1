$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
function Find-AndroidJdk21 {
    param(
        [string[]]$Candidates,
        [scriptblock]$ReadVersion = {
            param($Candidate)
            $version = & (Join-Path $Candidate 'bin/javac.exe') -version 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw 'Unable to run the JDK compiler' }
            $version
        }
    )
    foreach ($Candidate in ($Candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $missing = @('java.exe', 'javac.exe', 'jlink.exe') | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Candidate "bin/$_") -PathType Leaf) }
        if (@($missing).Count) { continue }
        try { $version = & $ReadVersion $Candidate } catch { continue }
        if ($version -match '(?m)^javac 21\.') { return $Candidate }
    }
    throw 'A complete JDK 21 (java, javac, jlink) is required. Set ST_ANDROID_JAVA_HOME or install .local/jdk-21.'
}
$JavaCandidates = @($env:ST_ANDROID_JAVA_HOME, $env:JAVA_HOME, (Join-Path $ProjectRoot '.local/jdk-21'))
$JavaHome = Find-AndroidJdk21 -Candidates $JavaCandidates
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = Join-Path $ProjectRoot '.local\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = Join-Path $ProjectRoot '.local\gradle-cache'
$env:ANDROID_AVD_HOME = Join-Path $ProjectRoot '.local\avd'
$env:ANDROID_USER_HOME = Join-Path $ProjectRoot '.local\android-user-home'
$env:ANDROID_EMULATOR_HOME = Join-Path $ProjectRoot '.local\android-user-home'
$JavaSocketTemp = Join-Path $ProjectRoot '.local\javatmp'
New-Item -ItemType Directory -Path $JavaSocketTemp,$env:ANDROID_USER_HOME -Force | Out-Null
# This JDK's Windows selector fails with the account's default Unix-socket temp directory.
# JAVA_TOOL_OPTIONS applies to both the Gradle client and its forked JVMs.
if ($env:JAVA_TOOL_OPTIONS -notmatch 'jdk\.net\.unixdomain\.tmpdir=') {
    $env:JAVA_TOOL_OPTIONS = "$env:JAVA_TOOL_OPTIONS -Djdk.net.unixdomain.tmpdir=`"$JavaSocketTemp`"".Trim()
}
$env:npm_config_cache = Join-Path $ProjectRoot '.local\npm-cache'
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin;$ProjectRoot\.local\gradle-8.13\bin;$env:Path"
