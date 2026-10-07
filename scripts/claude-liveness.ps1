param([string]$ConfigPath = (Join-Path $PSScriptRoot 'client-config.json'))

. (Join-Path $PSScriptRoot 'windows-client-common.ps1')

try {
    $config = Read-DashWindowsConfig -Path $ConfigPath
    $claudePath = [string]$config.ClaudePath
    if ([string]::IsNullOrWhiteSpace($claudePath) -or -not [System.IO.Path]::IsPathRooted($claudePath)) { exit 0 }

    [System.Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $global:LASTEXITCODE = 0
    $rawOutput = (& $claudePath agents --json 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { exit 0 }
    $rawOutput = $rawOutput.Trim()
    if ([string]::IsNullOrWhiteSpace($rawOutput)) { exit 0 }

    try {
        $agentsDocument = ConvertFrom-Json -InputObject $rawOutput -ErrorAction Stop
    }
    catch {
        exit 0
    }

    $trimmedOutput = $rawOutput.TrimStart()
    if ($trimmedOutput -match '^\[\s*\]$' -and $null -eq $agentsDocument) {
        $agents = @()
    }
    elseif ($trimmedOutput.StartsWith('[')) {
        if ($null -eq $agentsDocument) { exit 0 }
        $agents = @($agentsDocument)
    }
    else {
        $agentsProperty = $null
        if ($null -ne $agentsDocument) {
            foreach ($property in $agentsDocument.PSObject.Properties) {
                if ($property.Name -ceq 'agents') { $agentsProperty = $property; break }
            }
        }
        if ($null -eq $agentsProperty -or $agentsProperty.Value -isnot [System.Array]) { exit 0 }
        $agents = @($agentsProperty.Value)
    }

    foreach ($agent in $agents) {
        if ($null -eq $agent -or $agent -is [System.Array]) { exit 0 }
        $sessionProperty = $null
        foreach ($property in $agent.PSObject.Properties) {
            if ($property.Name -ceq 'sessionId') { $sessionProperty = $property; break }
        }
        if ($null -eq $sessionProperty -or $sessionProperty.Value -isnot [string] -or
            [string]::IsNullOrWhiteSpace($sessionProperty.Value)) { exit 0 }
    }

    $null = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/ingest/liveness/claude') `
        -HostLabel $config.HostLabel -Method POST -TimeoutMilliseconds 5000 `
        -Body $rawOutput -HasBody
}
catch {
    # A failed CLI or transport is unknown liveness, never an empty-session report.
}
exit 0
