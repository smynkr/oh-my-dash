param([string]$ConfigPath = (Join-Path $PSScriptRoot 'client-config.json'), [string]$DashHookMarker = '')

. (Join-Path $PSScriptRoot 'windows-client-common.ps1')

try {
    $config = Read-DashWindowsConfig -Path $ConfigPath
    $payload = Read-DashWindowsStdin
    if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
    $event = ConvertFrom-Json -InputObject $payload -ErrorAction Stop
    $sessionId = [string]$event.session_id
    if ([string]::IsNullOrEmpty($sessionId) -or $sessionId -notmatch '^[A-Za-z0-9_-]{1,128}$') { exit 0 }

    $waitSeconds = [int]$config.ReplyWaitSeconds
    if ($env:DASH_REPLY_WAIT_S -match '^\d+$') {
        $override = 0
        if ([int]::TryParse($env:DASH_REPLY_WAIT_S, [ref]$override) -and $override -ge 1 -and $override -le 21600) {
            $waitSeconds = $override
        }
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($waitSeconds).UtcDateTime
    $started = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $waiter = [Guid]::NewGuid().ToString('N')
    $encodedSession = [Uri]::EscapeDataString($sessionId)
    $failures = 0

    while ([DateTime]::UtcNow -lt $deadline) {
        $remainingMilliseconds = [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if ($remainingMilliseconds -le 0) { break }
        $requestTimeout = [int][Math]::Min(60000, $remainingMilliseconds)
        $url = $config.HubBase + '/reply/wait/claude?session=' + $encodedSession +
            '&waiter=' + $waiter + '&started=' + $started + '&wait=50'
        $result = $null
        try {
            $result = Invoke-DashWindowsHttp -Uri $url -HostLabel $config.HostLabel `
                -Method GET -TimeoutMilliseconds $requestTimeout
        }
        catch {
            # Network errors are retried with bounded backoff until the deadline.
        }

        if ($null -ne $result -and $result.StatusCode -eq 200) {
            if (-not [string]::IsNullOrEmpty($result.Body)) {
                $replyBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($result.Body)
                $stderr = [System.Console]::OpenStandardError()
                $stderr.Write($replyBytes, 0, $replyBytes.Length)
                $stderr.Flush()
                exit 2
            }
            exit 0
        }
        if ($null -ne $result -and $result.StatusCode -eq 204) {
            $failures = 0
            continue
        }
        if ($null -ne $result -and $result.StatusCode -in @(400, 403, 404, 409, 410)) { exit 0 }

        $failures++
        $delay = [Math]::Min(30, 5 * $failures)
        $remaining = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($remaining -le 0) { break }
        Start-Sleep -Seconds ([int][Math]::Min($delay, $remaining))
    }
}
catch {
    # Malformed hook input, configuration or transport failures are terminal and harmless.
}
exit 0
