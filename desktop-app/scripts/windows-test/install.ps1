param([string]$Installer, [string]$Architecture, [string]$UpdateInstaller, [string]$UpdateVersion)
$ErrorActionPreference = 'Stop'
$install = Join-Path $env:RUNNER_TEMP "Handwork install 日本語 $Architecture"
$output = Join-Path $PWD "windows-test-results-$Architecture"
New-Item -ItemType Directory -Force $output | Out-Null
Get-FileHash $Installer -Algorithm SHA256 | Format-List | Out-File "$output/installer-sha256.txt"
$process = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList @('/S', "/D=$install") -PassThru
if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Installer timed out' }
if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
$executable = Join-Path $install 'Handwork.exe'
$deadline = (Get-Date).AddSeconds(45)
while (-not (Test-Path $executable) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like '*Handwork*' } | Format-List DisplayName, InstallLocation, UninstallString | Out-File "$output/installation.txt"
Get-Process | Where-Object { $_.ProcessName -like '*Handwork*' } | Format-List Id, ProcessName, Path | Out-File "$output/processes.txt"
if (-not (Test-Path $executable)) {
  Get-ChildItem $env:RUNNER_TEMP, "$env:LOCALAPPDATA/Programs" -Filter Handwork.exe -Recurse -ErrorAction SilentlyContinue | Select-Object FullName | Out-File "$output/found-executables.txt"
  throw "Installed app is missing: $executable"
}
if (-not (Test-Path "$install/resources/handwork/bin/handwork.exe")) { throw 'Bundled engine missing' }
$node = (Get-Command node).Source
try {
  if ($UpdateInstaller) {
    & $node scripts/windows-test/update-app.mjs $executable (Resolve-Path $UpdateInstaller) $UpdateVersion $output
  } else {
    & $node scripts/windows-test/installed-app.mjs $executable $output
  }
  $testExit = $LASTEXITCODE
} finally {
  $uninstaller = Get-ChildItem $install -Filter '*Uninstall*.exe' | Select-Object -First 1
  if ($uninstaller) {
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru
    if (-not $uninstall.WaitForExit(60000)) { $uninstall.Kill(); throw 'Uninstaller timed out' }
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
    # NSIS copies its uninstaller to a separate process before removing files.
    # The original process can exit while that cleanup is still running.
    $deadline = (Get-Date).AddSeconds(60)
    while ((Test-Path $executable) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (Test-Path $executable) {
      Get-Process | Where-Object { $_.ProcessName -like '*Handwork*' -or $_.ProcessName -like '*Uninstall*' } | Format-List Id, ProcessName, Path | Out-File "$output/uninstall-processes.txt"
      throw 'Uninstall left the app executable behind after 60 seconds'
    }
    'Uninstall passed' | Out-File "$output/uninstall.txt"
  } else { throw 'No uninstaller found' }
}
if ($testExit -ne 0) { throw 'Installed app checks failed; see uploaded evidence' }
