$ErrorActionPreference = 'Stop'
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    Write-Host "Running: $Program $($Arguments -join ' ')"
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
Invoke-Checked -Program zig -Arguments @('build', '-Doptimize=ReleaseSafe')
Invoke-Checked -Program zig -Arguments @('build', 'test-platform', '-Doptimize=ReleaseSafe')
Invoke-Checked -Program zig -Arguments @('build', 'test-platform-integration', '-Doptimize=ReleaseSafe')
Invoke-Checked -Program node -Arguments @('--test', 'scripts/tests/npm-launcher.test.cjs')
Invoke-Checked -Program node -Arguments @('scripts/windows-smoke.mjs')

# Exercise npm's actual Windows command shim in an isolated global prefix.
# This temporary package tests only this runner's architecture; release packing
# separately requires every supported architecture through prepack.
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('handwork-npm-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    Invoke-Checked -Program npm.cmd -Arguments @('pack', '--ignore-scripts', '--pack-destination', $scratch)
    $tarball = (Get-ChildItem $scratch -Filter '*.tgz' | Select-Object -First 1).FullName
    $prefix = Join-Path $scratch 'install'
    Invoke-Checked -Program npm.cmd -Arguments @('install', '--global', '--prefix', $prefix, '--no-audit', '--no-fund', $tarball)
    Invoke-Checked -Program (Join-Path $prefix 'handwork.cmd') -Arguments @('--version')
    $launcher = Join-Path $prefix 'node_modules/handwork/bin/handwork.cjs'
    Invoke-Checked -Program node -Arguments @('scripts/windows-smoke.mjs', $launcher)
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
