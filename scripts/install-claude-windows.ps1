param(
    [string]$HubUrl = 'http://127.0.0.1:4777',
    [string]$HostLabel = $env:COMPUTERNAME,
    [string]$SettingsPath = (Join-Path $HOME '.claude\settings.json'),
    [string]$InstallPath = (Join-Path $HOME '.claude\oh-my-dash'),
    [string]$ClaudePath = '',
    [string]$TaskName = 'OhMyDash-Claude-Liveness',
    [switch]$NoReply,
    [switch]$DryRun,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function ConvertTo-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
}
function Get-WindowsPowerShellExe {
    $path = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'Windows PowerShell 5.1 was not found under the Windows SystemRoot.'
    }
    return (ConvertTo-FullPath $path)
}

function Get-HubBase([string]$Value) {
    $uri = $null
    if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri) -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw '-HubUrl must be an HTTP(S) hub origin without credentials, path, query, or fragment.'
    }
    if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) {
        throw 'Remote hubs require HTTPS; HTTP is allowed only for local-loopback QA.'
    }
    return $uri.GetLeftPart([System.UriPartial]::Authority)
}

function Get-ClaudeExecutable([string]$Value) {
    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        $expanded = [Environment]::ExpandEnvironmentVariables($Value)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return (ConvertTo-FullPath $expanded)
        }
        if ([System.IO.Path]::IsPathRooted($expanded)) {
            throw "Claude CLI executable does not exist: $expanded"
        }
        $found = Get-Command -Name $expanded -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    else {
        $found = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $found) {
            $npmCli = Join-Path $env:APPDATA 'npm\claude.cmd'
            if (Test-Path -LiteralPath $npmCli -PathType Leaf) { return (ConvertTo-FullPath $npmCli) }
        }
    }
    if ($null -eq $found) {
        throw 'Claude Code CLI was not found. Install it or pass -ClaudePath with the absolute path to its executable or command wrapper.'
    }
    $candidate = if ($found.Path) { $found.Path } else { $found.Source }
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'Claude Code CLI resolution did not produce an existing executable file.'
    }
    return (ConvertTo-FullPath $candidate)
}

function Get-FileSha256([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-BackupPath([string]$Path) {
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $candidate = "$Path.bak-dash-$stamp"
    $suffix = 1
    while (Test-Path -LiteralPath $candidate) {
        $candidate = "$Path.bak-dash-$stamp-$suffix"
        $suffix++
    }
    return $candidate
}

function Write-ManagedBytes([string]$Path, [byte[]]$Bytes) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $old = [System.IO.File]::ReadAllBytes($Path)
        $same = $old.Length -eq $Bytes.Length
        if ($same) {
            for ($index = 0; $index -lt $old.Length; $index++) {
                if ($old[$index] -ne $Bytes[$index]) { $same = $false; break }
            }
        }
        if ($same) { return $null }
        $backup = Get-BackupPath $Path
        Copy-Item -LiteralPath $Path -Destination $backup
    }
    else { $backup = $null }

    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllBytes($temporary, $Bytes)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [System.IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value)
        }
        else {
            [System.IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    return $backup
}

function Set-JsonProperty($Object, [string]$Name, $Value) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
    else { $property.Value = $Value }
}

function Remove-DashHookGroups($Document, [switch]$Install, [object[]]$Groups) {
    $hooksProperty = $Document.PSObject.Properties['hooks']
    if ($null -eq $hooksProperty) {
        if (-not $Install) { return $Document }
        $hooks = [pscustomobject]@{}
        Set-JsonProperty $Document 'hooks' $hooks
    }
    else {
        $hooks = $hooksProperty.Value
        if ($null -eq $hooks -or $hooks -is [System.Array] -or $hooks -is [string] -or
            $hooks -is [ValueType]) {
            throw 'Claude settings hooks must be a JSON object; no settings were changed.'
        }
    }

    $preexistingEmpty = @{}
    foreach ($property in @($hooks.PSObject.Properties)) {
        if ($property.Value -is [System.Array] -and $property.Value.Count -eq 0) {
            $preexistingEmpty[$property.Name] = $true
        }
    }
    foreach ($eventName in @($hooks.PSObject.Properties | ForEach-Object { $_.Name })) {
        $eventProperty = $hooks.PSObject.Properties[$eventName]
        if ($eventProperty.Value -isnot [System.Array]) { continue }
        $remainingGroups = New-Object 'System.Collections.Generic.List[object]'
        foreach ($group in @($eventProperty.Value)) {
            if ($null -eq $group -or $group -is [System.Array] -or $group -is [string]) {
                $remainingGroups.Add($group)
                continue
            }
            $groupHooksProperty = $group.PSObject.Properties['hooks']
            if ($null -eq $groupHooksProperty -or $groupHooksProperty.Value -isnot [System.Array]) {
                $remainingGroups.Add($group)
                continue
            }
            $remainingHooks = New-Object 'System.Collections.Generic.List[object]'
            foreach ($hook in @($groupHooksProperty.Value)) {
                $commandProperty = if ($null -ne $hook -and $hook -isnot [System.Array]) { $hook.PSObject.Properties['command'] } else { $null }
                if ($null -ne $commandProperty -and $commandProperty.Value -is [string] -and
                    $commandProperty.Value.Contains('# dash-hook')) { continue }
                $remainingHooks.Add($hook)
            }
            if ($remainingHooks.Count -gt 0) {
                $groupHooksProperty.Value = [object[]]$remainingHooks.ToArray()
                $remainingGroups.Add($group)
            }
        }
        if ($remainingGroups.Count -gt 0) {
            $eventProperty.Value = [object[]]$remainingGroups.ToArray()
        }
        elseif (-not $preexistingEmpty.ContainsKey($eventName)) {
            $hooks.PSObject.Properties.Remove($eventName)
        }
    }

    if ($Install) {
        foreach ($entry in $Groups) {
            $eventName = $entry.Event
            $eventProperty = $hooks.PSObject.Properties[$eventName]
            if ($null -eq $eventProperty) {
                $newGroups = [object[]]@($entry.Group)
                Set-JsonProperty $hooks $eventName $newGroups
            }
            elseif ($eventProperty.Value -is [System.Array]) {
                $newGroups = New-Object 'System.Collections.Generic.List[object]'
                foreach ($group in @($eventProperty.Value)) { $newGroups.Add($group) }
                $newGroups.Add($entry.Group)
                $eventProperty.Value = [object[]]$newGroups.ToArray()
            }
            else {
                throw "Claude settings hooks.$eventName must be an array; no settings were changed."
            }
        }
    }
    elseif ($hooks.PSObject.Properties.Count -eq 0) {
        $Document.PSObject.Properties.Remove('hooks')
    }
    return $Document
}

function New-DashHookGroups([string]$HookPath, [string]$WaiterPath, [switch]$NoReply) {
    $powerShellExe = Get-WindowsPowerShellExe
    if ($HookPath.Contains('"') -or $WaiterPath.Contains('"') -or $powerShellExe.Contains('"')) {
        throw 'Windows paths cannot contain a quotation mark.'
    }
    $quotedExe = '"' + $powerShellExe + '"'
    $ingestCommand = $quotedExe + ' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $HookPath + '" -DashHookMarker "# dash-hook"'
    $replyCommand = $quotedExe + ' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $WaiterPath + '" -DashHookMarker "# dash-hook"'
    $events = @(
        @{ Event = 'SessionStart' },
        @{ Event = 'UserPromptSubmit' },
        @{ Event = 'PreToolUse'; Matcher = 'AskUserQuestion' },
        @{ Event = 'PostToolUse'; Matcher = 'AskUserQuestion' },
        @{ Event = 'PermissionRequest' },
        @{ Event = 'Notification' },
        @{ Event = 'Stop' },
        @{ Event = 'StopFailure' },
        @{ Event = 'SessionEnd' }
    )
    $groups = New-Object 'System.Collections.Generic.List[object]'
    foreach ($event in $events) {
        $hook = [ordered]@{ type = 'command'; async = $true; timeout = 5; command = $ingestCommand }
        $group = [ordered]@{ hooks = @($hook) }
        if ($event.ContainsKey('Matcher')) { $group.matcher = $event.Matcher }
        $groups.Add([pscustomobject]@{ Event = $event.Event; Group = $group })
        if ($event.Event -eq 'Stop' -and -not $NoReply) {
            $reply = [ordered]@{ type = 'command'; async = $true; asyncRewake = $true; timeout = 21600; command = $replyCommand }
            $groups.Add([pscustomobject]@{ Event = 'Stop'; Group = [ordered]@{ hooks = @($reply) } })
        }
    }
    return $groups.ToArray()
}

function Get-SettingsOutput([string]$Path, [switch]$Install, [object[]]$Groups) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $originalText = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        try { $document = ConvertFrom-Json -InputObject $originalText -ErrorAction Stop }
        catch { throw "Claude settings contain invalid JSON: $Path" }
    }
    elseif ($Install) {
        $originalText = $null
        $document = [pscustomobject]@{}
    }
    else { return [pscustomobject]@{ Changed = $false; Bytes = $null } }

    if ($null -eq $document -or $document -is [System.Array] -or $document -is [string] -or $document -is [ValueType]) {
        throw 'Claude settings JSON must contain an object at the root; no settings were changed.'
    }
    $merged = Remove-DashHookGroups -Document $document -Install:$Install -Groups $Groups
    $text = (ConvertTo-Json -InputObject $merged -Depth 100) + [Environment]::NewLine
    $changed = $null -eq $originalText -or $text -cne $originalText
    return [pscustomobject]@{ Changed = $changed; Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text) }
}

function Quote-TaskArgument([string]$Value) {
    if ($Value.Contains('"')) { throw 'Windows paths cannot contain a quotation mark.' }
    return '"' + $Value + '"'
}

function Get-DashTaskArguments([string]$Path) {
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-TaskArgument $Path)
}

function Assert-DashTaskOwnership([string]$Path, [string]$TaskName) {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -eq $task) { return }

    $expectedPowerShell = Get-WindowsPowerShellExe
    $expectedPath = ConvertTo-FullPath $Path
    $expectedArguments = Get-DashTaskArguments $expectedPath
    $expectedWorkingDirectory = ConvertTo-FullPath (Split-Path -Parent $expectedPath)
    $expectedUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskUser = [string]$task.Principal.UserId
    if ($taskUser.StartsWith('S-1-')) {
        $taskUserSid = [System.Security.Principal.SecurityIdentifier]::new($taskUser).Value
    }
    else {
        $taskUserSid = [System.Security.Principal.NTAccount]::new($taskUser).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    $actions = @($task.Actions)
    $owned = $task.Description -ceq 'Oh My Dash managed Claude liveness task (oh-my-dash-claude-windows)' -and
        $taskUserSid -eq $expectedUser -and
        $task.Principal.LogonType -eq 'Interactive' -and
        $actions.Count -eq 1
    if ($owned) {
        $actualExecutable = ConvertTo-FullPath ([string]$actions[0].Execute)
        $actualWorkingDirectory = ConvertTo-FullPath ([string]$actions[0].WorkingDirectory)
        $owned = $actualExecutable -ieq $expectedPowerShell -and
            [string]$actions[0].Arguments -ieq $expectedArguments -and
            $actualWorkingDirectory -ieq $expectedWorkingDirectory
    }
    if (-not $owned) {
        throw "Scheduled Task '$TaskName' exists but does not match the managed Windows Claude task; refusing to overwrite or remove it."
    }
}

function Register-DashLivenessTask([string]$Path, [string]$TaskName) {
    $powershellExe = Get-WindowsPowerShellExe
    $livenessPath = ConvertTo-FullPath $Path
    Assert-DashTaskOwnership -Path $livenessPath -TaskName $TaskName
    $action = New-ScheduledTaskAction -Execute $powershellExe -Argument (Get-DashTaskArguments $livenessPath) `
        -WorkingDirectory (Split-Path -Parent $livenessPath)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $repeating = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) `
        -RepetitionInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger @($atLogon, $repeating) `
        -Principal $principal -Settings $settings `
        -Description 'Oh My Dash managed Claude liveness task (oh-my-dash-claude-windows)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
}

function Remove-DashLivenessTask([string]$Path, [string]$TaskName) {
    Assert-DashTaskOwnership -Path $Path -TaskName $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
}


function Remove-InstalledHelpers([string]$Directory) {
    $configPath = Join-Path $Directory 'client-config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        Write-Output 'Installed helper files were preserved because no managed client config was found.'
        return
    }
    try { $config = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop }
    catch {
        Write-Output 'Installed helper files were preserved because the client config is not readable JSON.'
        return
    }
    if ($config.ManagedBy -ne 'oh-my-dash-claude-windows' -or $null -eq $config.HelperHashes) {
        Write-Output 'Installed helper files were preserved because the client config is not owned by this installer.'
        return
    }
    foreach ($name in @('claude-hook.ps1', 'reply-wait.ps1', 'claude-liveness.ps1', 'windows-client-common.ps1')) {
        $path = Join-Path $Directory $name
        $expected = $config.HelperHashes.PSObject.Properties[$name]
        if ($null -eq $expected -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $actual = Get-FileSha256 ([System.IO.File]::ReadAllBytes($path))
        if ($actual -ceq [string]$expected.Value) { Remove-Item -LiteralPath $path -Force }
        else { Write-Output "Preserved modified helper: $path" }
    }
    $configBackup = Get-BackupPath $configPath
    Copy-Item -LiteralPath $configPath -Destination $configBackup
    Remove-Item -LiteralPath $configPath -Force
    if (@(Get-ChildItem -LiteralPath $Directory -Force).Count -eq 0) { Remove-Item -LiteralPath $Directory -Force }
}

try {
    $SettingsPath = ConvertTo-FullPath $SettingsPath
    $InstallPath = ConvertTo-FullPath $InstallPath
    if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,128}$') { throw '-TaskName may contain only letters, digits, spaces, dots, underscores, or hyphens.' }
    if ($HostLabel -match '\.') { $HostLabel = $HostLabel.Split('.')[0] }
    if (-not $Uninstall -and $HostLabel -notmatch '^[A-Za-z0-9_-]{1,64}$') {
        throw '-HostLabel must be a label of 1 to 64 letters, digits, underscores, or hyphens.'
    }
    $livenessPath = Join-Path $InstallPath 'claude-liveness.ps1'
    Assert-DashTaskOwnership -Path $livenessPath -TaskName $TaskName

    if ($Uninstall) {
        if ($DryRun) {
            Write-Output "Would remove hooks from $SettingsPath"
            Write-Output "Would unregister per-user Scheduled Task '$TaskName'"
            Write-Output "Would remove owned helper copies from $InstallPath (preserving modified or unrelated files and backups)"
            return
        }
        $settings = Get-SettingsOutput -Path $SettingsPath -Install:$false -Groups @()
        if ($settings.Changed) {
            $backup = Write-ManagedBytes -Path $SettingsPath -Bytes $settings.Bytes
            if ($backup) { Write-Output "Settings backup: $backup" }
        }
        Remove-DashLivenessTask -Path $livenessPath -TaskName $TaskName
        Remove-InstalledHelpers $InstallPath
        Write-Output 'Uninstalled Windows Claude hooks and liveness task.'
        return
    }

    $hubBase = Get-HubBase $HubUrl
    $HostLabel = $HostLabel.Split('.')[0]
    $ClaudePath = Get-ClaudeExecutable $ClaudePath
    $helperNames = @('claude-hook.ps1', 'reply-wait.ps1', 'claude-liveness.ps1', 'windows-client-common.ps1')
    $helperBytes = @{}
    $helperHashes = [ordered]@{}
    foreach ($name in $helperNames) {
        $source = Join-Path $PSScriptRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required source-pinned helper is missing: $source" }
        $bytes = [System.IO.File]::ReadAllBytes($source)
        $helperBytes[$name] = $bytes
        $helperHashes[$name] = Get-FileSha256 $bytes
    }
    $hookPath = Join-Path $InstallPath 'claude-hook.ps1'
    $waiterPath = Join-Path $InstallPath 'reply-wait.ps1'
    $livenessPath = Join-Path $InstallPath 'claude-liveness.ps1'
    $groups = New-DashHookGroups -HookPath $hookPath -WaiterPath $waiterPath -NoReply:$NoReply
    $settings = Get-SettingsOutput -Path $SettingsPath -Install:$true -Groups $groups
    $config = [ordered]@{
        ManagedBy = 'oh-my-dash-claude-windows'
        SchemaVersion = 1
        HubBase = $hubBase
        HostLabel = $HostLabel
        ClaudePath = $ClaudePath
        ReplyWaitSeconds = 21600
        HelperHashes = $helperHashes
    }
    $configText = (ConvertTo-Json -InputObject $config -Depth 8) + [Environment]::NewLine
    $configBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($configText)
    $configPath = Join-Path $InstallPath 'client-config.json'

    if ($DryRun) {
        Write-Output "Would install native Claude hooks in $SettingsPath"
        Write-Output "Would copy source-pinned PowerShell helpers and client config to $InstallPath"
        Write-Output "Would configure hub $hubBase for host $HostLabel using Claude CLI $ClaudePath"
        Write-Output "Would register per-user Scheduled Task '$TaskName' with one-minute liveness checks"
        Write-Output "Would create ten Dash hook groups (or nine with -NoReply); settings change: $($settings.Changed)"
        return
    }

    foreach ($name in $helperNames) {
        $backup = Write-ManagedBytes -Path (Join-Path $InstallPath $name) -Bytes $helperBytes[$name]
        if ($backup) { Write-Output "Helper backup: $backup" }
    }
    $configBackup = Write-ManagedBytes -Path $configPath -Bytes $configBytes
    if ($configBackup) { Write-Output "Client config backup: $configBackup" }
    Register-DashLivenessTask -Path $livenessPath -TaskName $TaskName
    if ($settings.Changed) {
        $settingsBackup = Write-ManagedBytes -Path $SettingsPath -Bytes $settings.Bytes
        if ($settingsBackup) { Write-Output "Settings backup: $settingsBackup" }
    }
    Write-Output "Installed Windows Claude hooks and per-user liveness task '$TaskName'."
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
