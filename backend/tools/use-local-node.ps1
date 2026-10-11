# Dot-source from backend\ in PowerShell:  . tools\use-local-node.ps1
# Puts the project-local Node (installed by tools/setup-local-node.mjs) first on PATH.
$nodeDir = Join-Path $PSScriptRoot '..\.tools\node'
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  Write-Error 'Local Node not installed. Run: node tools/setup-local-node.mjs'
} else {
  $env:PATH = (Resolve-Path $nodeDir).Path + ';' + $env:PATH
  Write-Host "Using $(node --version) from $nodeDir"
}
