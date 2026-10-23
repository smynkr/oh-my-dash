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
                $replyText = $result.Body
                $replyJson = New-Object System.Web.Script.Serialization.JavaScriptSerializer
                $replyJson.MaxJsonLength = 8192
                try { $envelope = $replyJson.DeserializeObject($result.Body) }
                catch { $envelope = $null }
                if ($envelope -is [System.Collections.IDictionary] -and $envelope.Contains('kind') -and
                    $envelope['kind'] -ceq 'dash.autopilot.reply.v1') {
                    $metadata = $envelope['autopilot']
                    $requiredKeys = @('kind', 'source', 'text', 'autopilot')
                    if ($envelope.Count -ne $requiredKeys.Count -or
                        @($envelope.Keys | Where-Object { $requiredKeys -cnotcontains [string]$_ }).Count -gt 0 -or
                        $envelope['source'] -cne 'autopilot' -or
                        $envelope['text'] -isnot [string] -or
                        $metadata -isnot [System.Collections.IDictionary] -or
                        $metadata.Count -ne 3 -or
                        @($metadata.Keys | Where-Object { @('goal_id', 'expires_at', 'remaining_ttl_ms') -cnotcontains [string]$_ }).Count -gt 0) {
                        exit 0
                    }
                    foreach ($name in @('goal_id', 'expires_at', 'remaining_ttl_ms')) {
                        if ($metadata[$name] -isnot [long] -and $metadata[$name] -isnot [int]) { exit 0 }
                    }
                    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                    if ($metadata.goal_id -lt 1 -or $metadata.expires_at -le $nowMs -or
                        $metadata.remaining_ttl_ms -lt 1 -or $metadata.remaining_ttl_ms -gt 86400000) { exit 0 }
                    $remaining = [Math]::Min([long]$metadata.remaining_ttl_ms, [long]($metadata.expires_at - $nowMs))
                    if ($remaining -lt 1) { exit 0 }
                    try {
                        Write-DashWindowsFenceCache -HostLabel $config.HostLabel -SessionId $sessionId -Active:$true `
                            -GoalId ([long]$metadata.goal_id) -ExpiresAt ([long]$metadata.expires_at) -RemainingTtlMs $remaining
                    }
                    catch {
                        [System.Console]::Error.WriteLine('dash autopilot fence cache unavailable; reply withheld')
                        exit 0
                    }
                    $replyText = $envelope['text']
                }
                $replyBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($replyText)
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
