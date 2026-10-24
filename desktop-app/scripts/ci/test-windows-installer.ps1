$ErrorActionPreference = 'Stop'
$installRoot = Join-Path $env:RUNNER_TEMP 'handwork-installer-test'
$installer = @(Get-ChildItem './release-assets/*.exe')
if ($installer.Count -ne 1) { throw 'Expected exactly one release installer.' }
$installed = Start-Process -FilePath $installer[0].FullName -ArgumentList '/S', "/D=$installRoot" -Wait -PassThru
if ($installed.ExitCode -ne 0) { throw "Installer exited with $($installed.ExitCode)." }
$app = Join-Path $installRoot 'handwork.exe'
$engine = Join-Path $installRoot 'handwork-engine/bin/handwork.exe'
$runtime = Join-Path $installRoot 'handwork-engine/lib/handwork/cli.mjs'
foreach ($file in @($app, $engine, $runtime)) {
  if (!(Test-Path $file)) { throw "Installer is missing $file" }
}
& $engine --version
if ($LASTEXITCODE -ne 0) { throw 'The bundled Handwork engine could not run.' }
$process = Start-Process -FilePath $app -WorkingDirectory $installRoot -PassThru
try {
  Start-Sleep -Seconds 10
  $process.Refresh()
  if ($process.HasExited) { throw "The installed app exited during startup: $($process.ExitCode)." }
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
}
