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
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'DELETE')][string]$Method,
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
function Get-DashWindowsFenceCachePath {
    param([string]$HostLabel, [string]$SessionId)
    if ($HostLabel -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $SessionId -notmatch '^[A-Za-z0-9_-]{1,128}$') {
        throw 'Invalid fence cache identity.'
    }
    $identity = [System.Text.Encoding]::UTF8.GetBytes($HostLabel + "`n" + $SessionId)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $name = ([BitConverter]::ToString($sha.ComputeHash($identity))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $root = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'OhMyDash\autopilot-fence'
    return Join-Path $root ($name + '.json')
}

function Write-DashWindowsFenceCache {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$HostLabel,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][bool]$Active,
        [long]$GoalId = 0,
        [long]$ExpiresAt = 0,
        [long]$RemainingTtlMs = 0,
        [switch]$InvalidActive
    )
    $path = Get-DashWindowsFenceCachePath $HostLabel $SessionId
    $directory = Split-Path -Parent $path
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, $systemSid)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
            [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
        $null = $acl.AddAccessRule($rule)
    }
    if (-not [System.IO.Directory]::Exists($directory)) {
        $null = [System.IO.Directory]::CreateDirectory($directory, $acl)
    }
    [System.IO.Directory]::SetAccessControl($directory, $acl)
    $cache = [ordered]@{
        SchemaVersion = 1
        IdentityHash = [System.IO.Path]::GetFileNameWithoutExtension($path)
        Active = $Active
        GoalId = $null
        ExpiresAt = $null
        RemainingTtlMs = 0
        SeedTick = 0
        DeadlineTick = 0
    }
    if ($Active -and $InvalidActive) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $nowTick = [System.Diagnostics.Stopwatch]::GetTimestamp()
        $remaining = if ($RemainingTtlMs -gt 0) { [Math]::Min($RemainingTtlMs, 86400000) } else { 86400000 }
        $delta = [decimal]$remaining * [decimal][System.Diagnostics.Stopwatch]::Frequency / 1000
        $deadline = [decimal]$nowTick + [decimal][Math]::Floor($delta)
        if ($deadline -gt [long]::MaxValue) { throw 'Invalid conservative fence deadline.' }
        $cache.GoalId = 0
        $cache.ExpiresAt = $nowMs + $remaining
        $cache.RemainingTtlMs = $remaining
        $cache.SeedTick = $nowTick
        $cache.DeadlineTick = [long]$deadline
    }
    elseif ($Active) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $nowTick = [System.Diagnostics.Stopwatch]::GetTimestamp()
        if ($GoalId -lt 1 -or $ExpiresAt -le $nowMs -or $RemainingTtlMs -lt 1 -or $RemainingTtlMs -gt 86400000) {
            throw 'Invalid active fence metadata.'
        }
        $remaining = [Math]::Min($RemainingTtlMs, $ExpiresAt - $nowMs)
        if ($remaining -lt 1) { throw 'Expired active fence metadata.' }
        $delta = [decimal]$remaining * [decimal][System.Diagnostics.Stopwatch]::Frequency / 1000
        $deadline = [decimal]$nowTick + [decimal][Math]::Floor($delta)
        if ($deadline -gt [long]::MaxValue) { throw 'Invalid active fence deadline.' }
        $cache.GoalId = $GoalId
        $cache.ExpiresAt = $ExpiresAt
        $cache.RemainingTtlMs = $remaining
        $cache.SeedTick = $nowTick
        $cache.DeadlineTick = [long]$deadline
    }
    Add-Type -AssemblyName System.Web.Extensions
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = 8192
    $temp = Join-Path $directory ('.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temp, $json.Serialize($cache), [System.Text.UTF8Encoding]::new($false))
        if ([System.IO.File]::Exists($path)) { [System.IO.File]::Replace($temp, $path, $null) }
        else { [System.IO.File]::Move($temp, $path) }
    }
    finally {
        if ([System.IO.File]::Exists($temp)) { [System.IO.File]::Delete($temp) }
    }
}

function Get-DashWindowsFenceState {
    param([string]$HostLabel, [string]$SessionId)
    $path = Get-DashWindowsFenceCachePath $HostLabel $SessionId
    if (-not [System.IO.File]::Exists($path)) { return 'inactive' }
    try {
        if ((Get-Item -LiteralPath $path).Length -gt 8192) { return 'invalid' }
        $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $json.MaxJsonLength = 8192
        $cache = $json.DeserializeObject([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8))
        if ($cache -isnot [System.Collections.IDictionary] -or $cache['SchemaVersion'] -ne 1 -or
            $cache['IdentityHash'] -cne [System.IO.Path]::GetFileNameWithoutExtension($path) -or
            $cache['Active'] -isnot [bool]) { return 'invalid' }
        if (-not $cache['Active']) { return 'inactive' }
        foreach ($name in @('GoalId','ExpiresAt','RemainingTtlMs','SeedTick','DeadlineTick')) {
            if ($cache[$name] -isnot [long] -and $cache[$name] -isnot [int]) { return 'invalid' }
        }
        $nowTick = [System.Diagnostics.Stopwatch]::GetTimestamp()
        if ($cache['GoalId'] -lt 0 -or $cache['ExpiresAt'] -lt 1 -or
            $cache['RemainingTtlMs'] -lt 1 -or $cache['RemainingTtlMs'] -gt 86400000 -or
            $cache['SeedTick'] -lt 0 -or $cache['DeadlineTick'] -le $cache['SeedTick'] -or
            ($cache['DeadlineTick'] - $cache['SeedTick']) -gt ([decimal]$cache['RemainingTtlMs'] * [decimal][System.Diagnostics.Stopwatch]::Frequency / 1000)) {
            return 'invalid'
        }
        if ($nowTick -lt $cache['SeedTick']) {
            Write-DashWindowsFenceCache -HostLabel $HostLabel -SessionId $SessionId -Active:$true -InvalidActive `
                -RemainingTtlMs ([long]$cache['RemainingTtlMs'])
            return 'active'
        }
        if ($nowTick -ge $cache['DeadlineTick']) {
            Write-DashWindowsFenceCache -HostLabel $HostLabel -SessionId $SessionId -Active:$false
            return 'inactive'
        }
        return 'active'
    }
    catch { return 'invalid' }
}

function Emit-DashWindowsFenceDeny {
    param([string]$Reason)
    if ([string]::IsNullOrWhiteSpace($Reason) -or $Reason.Length -gt 512 -or $Reason -match '[\x00-\x1F\x7F]') {
        $Reason = 'dash hub unreachable; autopilot paused, ask the owner'
    }
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = 8192
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::Out.WriteLine($json.Serialize(@{ hookSpecificOutput = @{
        hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $Reason
    } }))
}
