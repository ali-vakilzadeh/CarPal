# Dot-source from pwa\ in PowerShell:  . tools\use-local-node.ps1
# Puts the project-local Node that backend\ installed (backend\.tools\node) first on PATH (GD-02).
# When it is missing, runs backend\tools\setup-local-node.mjs with the system Node first.
$backendDir = Join-Path $PSScriptRoot '..\..\backend'
$nodeDir = Join-Path $backendDir '.tools\node'
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  Write-Host 'Local Node not installed; running backend\tools\setup-local-node.mjs'
  Push-Location $backendDir
  try { node tools/setup-local-node.mjs } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  Write-Error 'Local Node is still missing. Run: cd backend; node tools/setup-local-node.mjs'
} else {
  $env:PATH = (Resolve-Path $nodeDir).Path + ';' + $env:PATH
  Write-Host "Using $(node --version) from $nodeDir"
}
