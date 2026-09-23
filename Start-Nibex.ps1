param()
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:ADMIN_PASSWORD) {
    $nibexSecret = Read-Host 'Choose the admin password for this server session' -AsSecureString
    $env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $nibexSecret).Password
    if (-not $env:ADMIN_PASSWORD) { throw 'An admin password is required.' }
}
Write-Host 'Starting Nibex. Keep this terminal open. Press Ctrl+C to stop.'
while ($true) {
    & node server.js
    if ($LASTEXITCODE -eq 0) { break }
    Write-Warning 'Nibex exited unexpectedly. Restarting in 3 seconds; committed state is saved.'
    Start-Sleep -Seconds 3
}

