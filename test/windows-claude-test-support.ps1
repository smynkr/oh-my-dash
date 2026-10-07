function ConvertTo-WindowsCommandLineArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (2 * $slashes + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Start-WindowsClaudeProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        [hashtable]$Environment = @{},
        [switch]$Capture
    )
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $allArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $powershellExe
    $info.Arguments = (($allArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' ')
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    if ($Capture) {
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $info.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    }
    foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[[string]$name] = [string]$Environment[$name] }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw "Could not start PowerShell helper: $ScriptPath" }
    return $process
}

function Invoke-WindowsClaudeScript {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [AllowEmptyString()][string]$Stdin = '',
        [int]$TimeoutSeconds = 30,
        [string]$WorkingDirectory = (Get-Location).Path,
        [hashtable]$Environment = @{}
    )
    $process = Start-WindowsClaudeProcess -ScriptPath $ScriptPath -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory -Environment $Environment -Capture
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $inputBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Stdin)
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill()
        $process.WaitForExit()
        throw "PowerShell helper timed out after $TimeoutSeconds seconds: $ScriptPath"
    }
    $process.WaitForExit()
    $result = [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.Result
        Stderr = $stderrTask.Result
    }
    $process.Dispose()
    return $result
}

function New-WindowsClaudeFixture {
    [CmdletBinding()]
    param([string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot))
    $umlaut = [string][char]0x00FC
    $spaceCharacter = [string][char]0x7A7A
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('Oh My Dash Windows QA ' + $umlaut + ' ' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $installPath = Join-Path $root ('installed helpers ' + $spaceCharacter + ' with spaces')
    $settingsPath = Join-Path $root ('Claude settings ' + $umlaut + '.json')
    $claudePath = Join-Path $root ('Claude CLI ' + $spaceCharacter + ' with spaces.cmd')
    return [pscustomobject]@{
        Root = $root
        RepositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
        InstallPath = $installPath
        SettingsPath = $settingsPath
        ClaudePath = $claudePath
        TaskName = 'OhMyDash-Claude-Test-' + [Guid]::NewGuid().ToString('N')
        ManagedTaskDescription = 'Oh My Dash managed Claude liveness task (oh-my-dash-claude-windows)'
        CollisionTaskDescription = 'synthetic unowned Windows Claude task ' + [Guid]::NewGuid().ToString('N')
        CollisionTaskArguments = '-NoLogo -NoProfile -NonInteractive -Command "exit 0"'
        PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        HostLabel = 'synthetic-windows-host'
        Server = $null
        RedirectServer = $null
    }

}


function Start-WindowsClaudeHttpFixture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [hashtable]$Plans = @{}
    )
    $serverScript = Join-Path $PSScriptRoot 'windows-claude-test-http-server.ps1'
    $portPath = Join-Path $Directory 'http-server.port'
    $logPath = Join-Path $Directory 'http-server.requests.jsonl'
    $stopPath = Join-Path $Directory 'http-server.stop'
    $planPath = Join-Path $Directory 'http-server.plans.json'
    $planJson = ConvertTo-Json -InputObject ([ordered]@{ Routes = $Plans }) -Depth 100
    [System.IO.File]::WriteAllText($planPath, $planJson, [System.Text.UTF8Encoding]::new($false))
    $process = Start-WindowsClaudeProcess -ScriptPath $serverScript -Arguments @(
        '-PortPath', $portPath, '-LogPath', $logPath, '-StopPath', $stopPath, '-PlanPath', $planPath
    ) -WorkingDirectory $Directory
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $portPath)) {
        if ($process.HasExited) { throw "Loopback HTTP fixture exited with $($process.ExitCode)." }
        Start-Sleep -Milliseconds 50
    }
    if (-not (Test-Path -LiteralPath $portPath)) {
        $process.Kill()
        throw 'Loopback HTTP fixture did not publish its port.'
    }
    $port = [int][System.IO.File]::ReadAllText($portPath).Trim()
    return [pscustomobject]@{
        Process = $process
        Port = $port
        HubBase = "http://127.0.0.1:$port"
        Directory = $Directory
        LogPath = $logPath
        StopPath = $stopPath
        PlanPath = $planPath
    }
}

function Get-WindowsClaudeRequests($Fixture) {
    if (-not (Test-Path -LiteralPath $Fixture.LogPath -PathType Leaf)) { return @() }
    $lines = [System.IO.File]::ReadAllLines($Fixture.LogPath, [System.Text.Encoding]::UTF8)
    $requests = New-Object 'System.Collections.Generic.List[object]'
    foreach ($line in $lines) {
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $requests.Add((ConvertFrom-Json -InputObject $line -ErrorAction Stop))
        }
    }
    return $requests.ToArray()
}

function Set-WindowsClaudePlans($Fixture, [hashtable]$Plans) {
    $planJson = ConvertTo-Json -InputObject ([ordered]@{ Routes = $Plans }) -Depth 100
    [System.IO.File]::WriteAllText($Fixture.PlanPath, $planJson, [System.Text.UTF8Encoding]::new($false))
}

function Get-WindowsClaudeQueryValue([string]$Query, [string]$Name) {
    foreach ($pair in $Query.TrimStart('?').Split('&')) {
        $parts = $pair.Split('=', 2)
        if ($parts.Count -eq 2 -and [System.Uri]::UnescapeDataString($parts[0]) -ceq $Name) {
            return [System.Uri]::UnescapeDataString($parts[1].Replace('+', ' '))
        }
    }
    return $null
}

function Stop-WindowsClaudeHttpFixture($Fixture) {
    if ($null -eq $Fixture) { return }
    [System.IO.File]::WriteAllText($Fixture.StopPath, 'stop', [System.Text.Encoding]::ASCII)
    if (-not $Fixture.Process.WaitForExit(5000)) {
        $Fixture.Process.Kill()
        $Fixture.Process.WaitForExit()
    }
    $Fixture.Process.Dispose()
}

function Get-WindowsClaudeAccountSid([string]$UserId) {
    if ($UserId.StartsWith('S-1-')) {
        return [System.Security.Principal.SecurityIdentifier]::new($UserId).Value
    }
    return [System.Security.Principal.NTAccount]::new($UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Remove-WindowsClaudeFixture($Fixture) {
    if ($null -eq $Fixture) { return }

    $task = Get-ScheduledTask -TaskName $Fixture.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $task -and (Get-WindowsClaudeAccountSid $task.Principal.UserId) -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
        $actions = @($task.Actions)
        if ($actions.Count -eq 1) {
            try {
                $actualExecutable = [System.IO.Path]::GetFullPath([string]$actions[0].Execute)
                $actualWorkingDirectory = [System.IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory)
                $collisionOwned = $task.Description -ceq $Fixture.CollisionTaskDescription -and
                    $actualExecutable -ieq [System.IO.Path]::GetFullPath($Fixture.PowerShellExe) -and
                    [string]$actions[0].Arguments -ieq $Fixture.CollisionTaskArguments -and
                    $actualWorkingDirectory -ieq [System.IO.Path]::GetFullPath($Fixture.Root)
                $livenessPath = [System.IO.Path]::GetFullPath((Join-Path $Fixture.InstallPath 'claude-liveness.ps1'))
                $managedArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $livenessPath + '"'
                $managedOwned = $task.Description -ceq $Fixture.ManagedTaskDescription -and
                    $actualExecutable -ieq [System.IO.Path]::GetFullPath($Fixture.PowerShellExe) -and
                    [string]$actions[0].Arguments -ieq $managedArguments -and
                    $actualWorkingDirectory -ieq [System.IO.Path]::GetFullPath($Fixture.InstallPath)
                if ($collisionOwned -or $managedOwned) {
                    Stop-ScheduledTask -TaskName $Fixture.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
                    Unregister-ScheduledTask -TaskName $Fixture.TaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
                }
            }
            catch {
                # Preserve any task whose ownership cannot be verified.
            }
        }
    }
    if ($null -ne $Fixture.RedirectServer) { Stop-WindowsClaudeHttpFixture $Fixture.RedirectServer }
    if ($null -ne $Fixture.Server) { Stop-WindowsClaudeHttpFixture $Fixture.Server }
    if (Test-Path -LiteralPath $Fixture.Root -PathType Container) {
        Remove-Item -LiteralPath $Fixture.Root -Recurse -Force
    }
}

