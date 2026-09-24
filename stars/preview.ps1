# Preview the starfield on a Windows PC: two side-by-side browser windows standing in for the two TVs.
# Usage:  .\stars\preview.ps1              (parallax cruise, default)
#         .\stars\preview.ps1 -Mode warp
#         .\stars\preview.ps1 -Speed 2 -Gap 150 -Direction right
#         .\stars\preview.ps1 -Single       (one window; press F11 for fullscreen)
param(
    [ValidateSet('left','right','forward','backward')] [string]$Direction = 'left',
    [double]$Speed = 1,
    [int]$Gap = 0,
    [double]$Scale = 1,
    [double]$Size = 1,
    [int]$Fps = 60,
    [int]$Width = 960,
    [int]$Height = 540,
    [switch]$Single
)
$page = 'file:///' + (Join-Path $PSScriptRoot 'index.html').Replace([char]92, '/')
$browser = @(
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Start-Process "${page}?dir=$Direction&speed=$Speed&scale=$Scale&size=$Size&fps=$Fps"; return }

if ($Single) {
    & $browser --new-window --app="${page}?dir=$Direction&speed=$Speed&scale=$Scale&size=$Size&fps=$Fps" --user-data-dir="$env:TEMP\nibex-stars-preview"
    return
}
$tw = $Width * 2 + $Gap
$common = @('--new-window', '--no-first-run', "--window-size=$Width,$($Height + 40)")
& $browser @common --window-position=20,80 --user-data-dir="$env:TEMP\nibex-stars-preview0" `
    --app="${page}?x=0&y=0&w=$Width&h=$Height&tw=$tw&th=$Height&dir=$Direction&speed=$Speed&scale=$Scale&size=$Size&fps=$Fps"
& $browser @common --window-position=$($Width + 40),80 --user-data-dir="$env:TEMP\nibex-stars-preview1" `
    --app="${page}?x=$($Width + $Gap)&y=0&w=$Width&h=$Height&tw=$tw&th=$Height&dir=$Direction&speed=$Speed&scale=$Scale&size=$Size&fps=$Fps"
Write-Host "Two windows opened as the left and right TVs. Close them when done."
