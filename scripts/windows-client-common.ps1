function Read-DashWindowsConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $json = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    $config = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    if ($null -eq $config -or $config -is [System.Array] -or $config -is [string]) {
        throw 'Invalid Oh My Dash Windows client configuration.'
    }
    if ($config.ManagedBy -ne 'oh-my-dash-claude-windows' -or $config.SchemaVersion -ne 1) {
        throw 'Unsupported Oh My Dash Windows client configuration.'
    }
    if ($config.HostLabel -notmatch '^[A-Za-z0-9_-]{1,64}$') {
        throw 'Invalid configured host label.'
    }
    $hub = $null
    if (-not [System.Uri]::TryCreate([string]$config.HubBase, [System.UriKind]::Absolute, [ref]$hub) -or
        $hub.UserInfo -or $hub.Query -or $hub.Fragment -or $hub.AbsolutePath -ne '/') {
        throw 'Invalid configured hub URL.'
    }
    if ($hub.Scheme -ne 'https' -and -not ($hub.Scheme -eq 'http' -and $hub.IsLoopback)) {
        throw 'The hub must use HTTPS except for local-loopback QA.'
    }
    if ($null -eq $config.ReplyWaitSeconds -or [int]$config.ReplyWaitSeconds -lt 1 -or [int]$config.ReplyWaitSeconds -gt 21600) {
        throw 'Invalid configured reply wait duration.'
    }
    return $config
}

function Read-DashWindowsStdin {
    $stream = [System.Console]::OpenStandardInput()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true)
    try {
        return $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
}

function Wait-DashWindowsHttpTask {
    param(
        [System.Threading.Tasks.Task]$Task,
        [System.Diagnostics.Stopwatch]$Clock,
        [int]$TimeoutMilliseconds,
        [System.Net.HttpWebRequest]$Request
    )
    $remaining = $TimeoutMilliseconds - [int][Math]::Ceiling($Clock.Elapsed.TotalMilliseconds)
    if ($remaining -gt 0) {
        try {
            if ($Task.Wait($remaining)) { return $Task.GetAwaiter().GetResult() }
        }
        catch [System.AggregateException] {
            throw $_.Exception.GetBaseException()
        }
    }
    $Request.Abort()
    throw [System.TimeoutException]::new('The HTTP exchange exceeded its total deadline.')
}

function Invoke-DashWindowsHttp {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$HostLabel,
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
        [System.Collections.IDictionary]$Headers = @{},
        [AllowEmptyString()][string]$Body,
        [switch]$HasBody
    )

    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = $Method
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.AllowAutoRedirect = $false
    $request.Headers['X-Dash-Host'] = $HostLabel
    foreach ($name in $Headers.Keys) {
        if ([string]$name -ieq 'X-Dash-Host') {
            throw 'X-Dash-Host is controlled by the configured host label.'
        }
        if ($null -ne $Headers[$name]) {
            $request.Headers[[string]$name] = [string]$Headers[$name]
        }
    }
    if ($HasBody) {
        $request.ContentType = 'application/json'
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Body)
        $request.ContentLength = $bytes.Length
        $requestStream = Wait-DashWindowsHttpTask ($request.GetRequestStreamAsync()) $clock $TimeoutMilliseconds $request
        try {
            Wait-DashWindowsHttpTask ($requestStream.WriteAsync($bytes, 0, $bytes.Length)) $clock $TimeoutMilliseconds $request
        }
        finally {
            $requestStream.Dispose()
        }
    }

    $response = $null
    try {
        try {
            $response = [System.Net.HttpWebResponse](Wait-DashWindowsHttpTask ($request.GetResponseAsync()) $clock $TimeoutMilliseconds $request)
        }
        catch [System.Net.WebException] {
            if ($null -eq $_.Exception.Response) { throw }
            $response = [System.Net.HttpWebResponse]$_.Exception.Response
        }
        $responseStream = $response.GetResponseStream()
        $responseBody = ''
        if ($null -ne $responseStream) {
            $responseReader = [System.IO.StreamReader]::new($responseStream, [System.Text.Encoding]::UTF8, $true)
            try {
                $responseBody = Wait-DashWindowsHttpTask ($responseReader.ReadToEndAsync()) $clock $TimeoutMilliseconds $request
            }
            finally {
                $responseReader.Dispose()
            }
        }
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Body = $responseBody
        }
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
    }
}
