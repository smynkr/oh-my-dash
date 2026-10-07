param([string]$ConfigPath = (Join-Path $PSScriptRoot 'client-config.json'), [string]$DashHookMarker = '')

. (Join-Path $PSScriptRoot 'windows-client-common.ps1')

try {
    $config = Read-DashWindowsConfig -Path $ConfigPath
    $payload = Read-DashWindowsStdin
    if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
    $null = ConvertFrom-Json -InputObject $payload -ErrorAction Stop

    $headers = @{
        'X-Dash-Entrypoint' = [string]$env:CLAUDE_CODE_ENTRYPOINT
        'X-Dash-Attended' = [string]$env:CLAUDE_CODE_SESSION_ATTENDED
        'X-Dash-Kind' = [string]$env:CLAUDE_CODE_SESSION_KIND
    }
    $null = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/ingest/claude') `
        -HostLabel $config.HostLabel -Method POST -TimeoutMilliseconds 3000 `
        -Headers $headers -Body $payload -HasBody
}
catch {
    # Event delivery is best-effort; a local hub outage must not fail a Claude turn.
}
exit 0
