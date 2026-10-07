param(
    [Parameter(Mandatory = $true)][string]$PortPath,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$StopPath,
    [Parameter(Mandatory = $true)][string]$PlanPath
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)

function Read-HttpRequest([System.Net.Sockets.NetworkStream]$Stream) {
    $memory = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 4096
    $headerEnd = -1
    while ($headerEnd -lt 0) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { $memory.Dispose(); return $null }
        $memory.Write($buffer, 0, $read)
        $bytes = $memory.ToArray()
        for ($index = 0; $index -le $bytes.Length - 4; $index++) {
            if ($bytes[$index] -eq 13 -and $bytes[$index + 1] -eq 10 -and
                $bytes[$index + 2] -eq 13 -and $bytes[$index + 3] -eq 10) {
                $headerEnd = $index
                break
            }
        }
    }

    $data = $memory.ToArray()
    $headerText = [System.Text.Encoding]::ASCII.GetString($data, 0, $headerEnd)
    $lines = $headerText -split "`r`n"
    $requestParts = $lines[0] -split ' ', 3
    if ($requestParts.Count -lt 2) { $memory.Dispose(); throw 'Malformed HTTP request line.' }
    $headers = [ordered]@{}
    foreach ($line in @($lines | Select-Object -Skip 1)) {
        $separator = $line.IndexOf(':')
        if ($separator -gt 0) { $headers[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim() }
    }
    $contentLength = 0
    if ($headers.Contains('Content-Length')) { $contentLength = [int]$headers['Content-Length'] }
    if ($contentLength -lt 0 -or $contentLength -gt 2097152) { $memory.Dispose(); throw 'Invalid HTTP content length.' }
    if ($headers.Contains('Expect') -and $headers['Expect'] -match '100-continue') {
        $continue = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 100 Continue`r`n`r`n")
        $Stream.Write($continue, 0, $continue.Length)
    }
    while (($memory.Length - ($headerEnd + 4)) -lt $contentLength) {
        $read = $Stream.Read($buffer, 0, [Math]::Min($buffer.Length, $contentLength - [int]($memory.Length - ($headerEnd + 4))))
        if ($read -le 0) { $memory.Dispose(); throw 'Incomplete HTTP request body.' }
        $memory.Write($buffer, 0, $read)
    }
    $data = $memory.ToArray()
    $body = if ($contentLength -gt 0) { $utf8.GetString($data, $headerEnd + 4, $contentLength) } else { '' }
    $memory.Dispose()
    return [pscustomobject]@{
        Method = $requestParts[0]
        Target = $requestParts[1]
        Path = ([System.Uri]::new('http://127.0.0.1' + $requestParts[1])).AbsolutePath
        Headers = $headers
        Body = $body
    }
}

function Write-HttpResponse([System.Net.Sockets.NetworkStream]$Stream, [int]$StatusCode, [string]$Body, [string]$ContentType, [string]$ExtraHeaders = '') {
    $reason = switch ($StatusCode) {
        200 { 'OK' }
        201 { 'Created' }
        204 { 'No Content' }
        400 { 'Bad Request' }
        403 { 'Forbidden' }
        404 { 'Not Found' }
        409 { 'Conflict' }
        410 { 'Gone' }
        default { 'Test Response' }
    }
    $bodyBytes = $utf8.GetBytes($Body)
    $headerText = "HTTP/1.1 $StatusCode $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n" + $ExtraHeaders + "`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($bodyBytes.Length -gt 0) { $Stream.Write($bodyBytes, 0, $bodyBytes.Length) }
    $Stream.Flush()
}

try {
    $listener.Start()
    [System.IO.File]::WriteAllText($PortPath, [string]$listener.LocalEndpoint.Port, [System.Text.Encoding]::ASCII)
    $routeIndexes = @{}
    while (-not (Test-Path -LiteralPath $StopPath)) {
        if (-not $listener.Pending()) {
            Start-Sleep -Milliseconds 20
            continue
        }
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $request = Read-HttpRequest $stream
            if ($null -eq $request) { continue }
            $record = ConvertTo-Json -InputObject $request -Depth 20 -Compress
            [System.IO.File]::AppendAllText($LogPath, $record + [Environment]::NewLine, $utf8)

            $plans = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($PlanPath, [System.Text.Encoding]::UTF8))
            $routeProperty = $plans.Routes.PSObject.Properties[$request.Path]
            $selected = $null
            if ($null -ne $routeProperty -and $routeProperty.Value) {
                $items = @($routeProperty.Value)
                $index = 0
                if ($routeIndexes.ContainsKey($request.Path)) { $index = $routeIndexes[$request.Path] }
                $selected = $items[[Math]::Min($index, $items.Count - 1)]
                $routeIndexes[$request.Path] = $index + 1
            }
            if ($null -eq $selected) {
                if ($request.Path -eq '/reply/wait/claude') {
                    $selected = [pscustomobject]@{ StatusCode = 204; Body = ''; ContentType = 'text/plain'; DelayMilliseconds = 0 }
                }
                else {
                    $selected = [pscustomobject]@{ StatusCode = 200; Body = '{}'; ContentType = 'application/json'; DelayMilliseconds = 0 }
                }
            }
            if ([int]$selected.DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds ([int]$selected.DelayMilliseconds) }
            $extraHeaders = ''
            if ($selected.ResponseHeaders) {
                foreach ($header in $selected.ResponseHeaders.PSObject.Properties) {
                    $extraHeaders += $header.Name + ': ' + [string]$header.Value + "`r`n"
                }
            }
            Write-HttpResponse $stream ([int]$selected.StatusCode) ([string]$selected.Body) ([string]$selected.ContentType) $extraHeaders
        }
        catch {
            # A client closing after its bounded request timeout is expected in timeout tests.
        }
        finally {
            $client.Close()
        }
    }
}
finally {
    $listener.Stop()
}
