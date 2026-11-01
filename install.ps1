<#
  agent-memory installer (Windows PowerShell 5.1+)
  1) check Node.js >= 18
  2) copy the skill into %USERPROFILE%\.dsh\skills\agent-memory
  3) run a read-only `doctor` against the existing memory store

  Usage:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkillHome D:\skills

  NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less
  UTF-8 scripts as ANSI and would break on non-ASCII text).
#>
param(
    [string]$SkillHome = (Join-Path $env:USERPROFILE ".dsh\skills"),
    [switch]$NoDoctor
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js not found. Install Node.js >= 18 first: https://nodejs.org/" -ForegroundColor Red
    exit 2
}
$versionText = (& node -v).Trim()
$major = [int]($versionText.TrimStart('v').Split('.')[0])
Write-Host ("Node.js: {0}" -f $versionText)
if ($major -lt 18) {
    Write-Host "Node.js >= 18 is required." -ForegroundColor Red
    exit 2
}

$target = Join-Path $SkillHome "agent-memory"
if (Test-Path $target) {
    Write-Host ("Updating existing skill dir: {0}" -f $target)
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
$skip = @(".git", "__pycache__", ".pytest_cache", "verify", "node_modules")
Get-ChildItem $root -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName -Destination $target -Recurse -Force
}
Write-Host ("Installed to: {0}" -f $target)

if (-not $NoDoctor) {
    Write-Host ""
    Write-Host "Read-only doctor (default store = the DSH personal-agent memory):"
    & node (Join-Path $target "memory.mjs") doctor
}

Write-Host ""
Write-Host "Next:"
Write-Host ("  node `"" + (Join-Path $target "memory.mjs") + "`" inject `"user request summary`"")
Write-Host ("  node `"" + (Join-Path $target "memory.mjs") + "`" remember `"a stable fact`" --kind fact --tags demo")
Write-Host "Point it at another store with --root DIR or the PA_MEMORY_ROOT environment variable."
Write-Host "The skill catalog is scanned when a new session starts."
