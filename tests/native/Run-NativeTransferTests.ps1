param([string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$gradleLib = Join-Path $projectRoot '.local/gradle-8.13/lib'
$testOutput = Join-Path $projectRoot '.local/fix-1.1.3/native-test-classes'
New-Item -ItemType Directory -Path $testOutput -Force | Out-Null
$compileClasspath = @('kotlin-stdlib-2.0.21.jar','junit-4.13.2.jar','annotations-24.0.1.jar') | ForEach-Object { Join-Path $gradleLib $_ }
$sourceFile = Join-Path $SourceRoot 'android/app/src/main/java/io/sillytavern/standalone/RuntimeTransfers.kt'
$httpFile = Join-Path $SourceRoot 'android/app/src/main/java/io/sillytavern/standalone/RuntimeHttp.kt'
$restartFile = Join-Path $SourceRoot 'android/app/src/main/java/io/sillytavern/standalone/RuntimeRestart.kt'
& java -cp "$gradleLib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath ($compileClasspath -join ';') -d $testOutput $sourceFile $httpFile $restartFile (Join-Path $PSScriptRoot 'NativeTransfersTest.kt') (Join-Path $PSScriptRoot 'RuntimeRestartTest.kt')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& java -cp "$testOutput;$gradleLib/*" org.junit.runner.JUnitCore io.sillytavern.standalone.NativeTransfersTest io.sillytavern.standalone.RuntimeRestartTest
exit $LASTEXITCODE
