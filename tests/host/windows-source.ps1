function New-Phase4RunDirectory {
    $directory = Join-Path $env:LOCALAPPDATA ('Magpie-Usage-Hub-Phase4-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    $accountSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    icacls.exe $directory /inheritance:r /grant:r "*${accountSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '验收目录授权失败' }
    $directory
}

function Stop-Phase4Process([Diagnostics.Process] $Process) {
    if ($null -eq $Process -or $Process.HasExited) { return }
    try { $Process.Kill($true) }
    catch { if (-not $Process.HasExited) { throw '验收进程无法退出' } }
    if (-not $Process.WaitForExit(5000)) { throw '验收进程退出超时' }
}

function Invoke-Phase4Magpie([pscustomobject] $Source, [string[]] $CliArguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($Source.MagpieCli)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($entry in $Source.Environment.GetEnumerator()) {
        if ($null -eq $entry.Value) { $null = $start.Environment.Remove($entry.Key) }
        else { $start.Environment[$entry.Key] = $entry.Value }
    }
    foreach ($argument in $CliArguments) { $start.ArgumentList.Add($argument) }
    $action = $CliArguments[0..1] -join ' '
    $process = [Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            Stop-Phase4Process $process
            throw "来源 $($Source.Name) 的 $action 超时"
        }
        if ($process.ExitCode -ne 0) { throw "来源 $($Source.Name) 的 $action 退出码 $($process.ExitCode)" }
        $null = $errors.GetAwaiter().GetResult()
        $output.GetAwaiter().GetResult()
    } finally {
        $process.Dispose()
    }
}

function Set-Phase4Options([Parameter(Mandatory)] [pscustomobject] $Source) {
    $settings = $Source.Settings | ConvertTo-Json -Depth 12 -Compress -ErrorAction Stop
    Invoke-Phase4Magpie $Source @('plugin','options',$Source.PackageDirectory,$settings) | Out-Null
    $saved = Invoke-Phase4Magpie $Source @('plugin','options',$Source.PackageDirectory)
    try {
        $desiredOptions = [Text.Json.Nodes.JsonNode]::Parse($settings)
        $savedOptions = [Text.Json.Nodes.JsonNode]::Parse($saved)
    } catch { throw "来源 $($Source.Name) 的 Options 读回无效" }
    if (-not [Text.Json.Nodes.JsonNode]::DeepEquals($desiredOptions, $savedOptions)) {
        throw "来源 $($Source.Name) 的 Options 读回不符"
    }
}

function New-Phase4Source {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidateSet('A','B')] [string] $Name,
        [Parameter(Mandatory)] [ValidateRange(1024,65535)] [int] $Port,
        [Parameter(Mandatory)] [string] $RunDirectory,
        [Parameter(Mandatory)] [string] $MagpieCli,
        [Parameter(Mandatory)] [string] $BunPath,
        [Parameter(Mandatory)] [string] $PackageDirectory,
        [Parameter(Mandatory)] [ValidateRange(1024,65535)] [int] $FixturePort,
        [Parameter(Mandatory)] [uri] $CenterUrl,
        [Parameter(Mandatory)] [string] $ReportingKeyFile
    )

    if ($Port -eq $FixturePort) { throw '来源与供应商端口必须独立' }
    Assert-Phase4FreePort $Port
    if (-not $CenterUrl.IsAbsoluteUri -or $CenterUrl.Scheme -notin 'http','https' -or
        $CenterUrl.UserInfo -or $CenterUrl.PathAndQuery -cne '/' -or $CenterUrl.Fragment) {
        throw '验收需要中心网关根地址'
    }
    $cli = Get-Item -LiteralPath $MagpieCli -ErrorAction Stop
    $serve = Get-Item -LiteralPath (Join-Path $cli.DirectoryName 'magpie.exe') -ErrorAction Stop
    if ($cli.Name -ine 'magpie.com' -or $serve.PSIsContainer -or
        (Test-Path -LiteralPath (Join-Path $serve.DirectoryName 'data'))) { throw '验收需要 Windows 安装版 Magpie' }
    $bun = Get-Item -LiteralPath $BunPath -ErrorAction Stop
    if ($bun.PSIsContainer) { throw 'Bun 可执行文件无效' }
    try { $reportFile = Get-Item -LiteralPath $ReportingKeyFile -ErrorAction Stop }
    catch { throw "来源 $Name 的上报凭据文件无法读取" }
    if ($reportFile.PSIsContainer -or $reportFile.LinkType -or $reportFile.Length -eq 0) {
        throw "来源 $Name 的上报凭据文件无效"
    }
    $package = (Resolve-Path -LiteralPath $PackageDirectory -ErrorAction Stop).Path
    $profile = Join-Path (Resolve-Path -LiteralPath $RunDirectory -ErrorAction Stop).Path "source-$Name"
    New-Item -ItemType Directory -Path $profile -ErrorAction Stop | Out-Null
    $environment = @{
        USERPROFILE = Join-Path $profile 'home'
        HOME = Join-Path $profile 'home'
        APPDATA = Join-Path $profile 'roaming'
        LOCALAPPDATA = Join-Path $profile 'local'
        XDG_CONFIG_HOME = Join-Path $profile 'config'
        XDG_CACHE_HOME = Join-Path $profile 'cache'
    }
    New-Item -ItemType Directory -Path @($environment.Values | Sort-Object -Unique) -ErrorAction Stop | Out-Null
    $environment += @{
        MAGPIE_ADDR = "127.0.0.1:$Port"
        MAGPIE_BUN = $bun.FullName
        MAGPIE_NAME = "Usage Hub Phase 4 $Name"
        MAGPIE_NO_ACCOUNTS = '1'
    }
    foreach ($variable in Get-ChildItem Env:MAGPIE_*) {
        if (-not $environment.ContainsKey($variable.Name)) { $environment[$variable.Name] = $null }
    }

    $configRoot = Join-Path $environment.XDG_CONFIG_HOME 'magpie'
    $provider = 'usage-hub-04-fixture'
    $model = 'phase4-fixture-v1'
    $source = [pscustomobject]@{
        Name = $Name
        Origin = "http://127.0.0.1:$Port"
        Environment = $environment
        ProfileDirectory = $profile
        ConfigRoot = $configRoot
        PackageDirectory = $package
        StatePath = Join-Path $configRoot 'magpie-usage-hub/state.json'
        MagpieCli = $cli.FullName
        MagpieExe = $serve.FullName
        BunPath = $bun.FullName
        Model = "$provider/$model"
        ModelKey = $null
        Settings = $null
        Process = $null
        StdoutPath = $null
        StderrPath = $null
    }
    Invoke-Phase4Magpie $source @('provider','add',$provider,"url=http://127.0.0.1:$FixturePort/v1",'key=phase4-fixture',"models=$model",'list=off') | Out-Null
    $keyJson = Invoke-Phase4Magpie $source @('gateway-key','issue','--ttl','2h','--name',"usage-hub-04-source-$Name",'--models',$source.Model,'--json')
    try { $source.ModelKey = $keyJson | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { throw "来源 $Name 的模型凭据返回无效" }
    if (-not $source.ModelKey.id -or -not $source.ModelKey.key) { throw "来源 $Name 的模型凭据签发失败" }
    Invoke-Phase4Magpie $source @('plugin','add',$package) | Out-Null
    $source.Settings = @{
        enabled = $true
        mode = 'continuous'
        configRevision = [Guid]::NewGuid().ToString()
        sourceGatewayUrl = "$($source.Origin)/"
        sourceCallerKeyId = $source.ModelKey.id
        centralGatewayUrl = $CenterUrl.AbsoluteUri
        centralKeyFile = $reportFile.FullName
        initialMode = 'now'
        pollIntervalSec = 5
        requestTimeoutSec = 15
    }
    Set-Phase4Options -Source $source
    $source
}

function Assert-Phase4FreePort([int] $Port) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "验收端口 $Port 已被占用"
    }
}

function Start-Phase4Source([Parameter(Mandatory)] [pscustomobject] $Source) {
    if ($Source.Process -and -not $Source.Process.HasExited) { throw "来源 $($Source.Name) 正在运行" }
    Assert-Phase4FreePort ([uri]$Source.Origin).Port
    $logId = [Guid]::NewGuid().ToString('N')
    $Source.StdoutPath = Join-Path $Source.ProfileDirectory "serve-$logId.out.log"
    $Source.StderrPath = Join-Path $Source.ProfileDirectory "serve-$logId.err.log"
    $Source.Process = Start-Process -FilePath $Source.MagpieExe -ArgumentList 'serve' -Environment $Source.Environment `
        -RedirectStandardOutput $Source.StdoutPath -RedirectStandardError $Source.StderrPath -WindowStyle Hidden -PassThru -ErrorAction Stop
    $timeout = [Diagnostics.Stopwatch]::StartNew()
    try {
        while ($timeout.Elapsed.TotalSeconds -lt 18) {
            if ($Source.Process.HasExited) { throw "来源 $($Source.Name) 提前退出" }
            try {
                $root = Invoke-RestMethod -Uri "$($Source.Origin)/" -NoProxy -MaximumRedirection 0 `
                    -ConnectionTimeoutSeconds 1 -OperationTimeoutSeconds 1 -ErrorAction Stop
            } catch { $root = $null }
            if ($root) {
                if ($root.pid -ne $Source.Process.Id -or -not $root.version) { throw "来源 $($Source.Name) 的网关身份不符" }
                return [pscustomobject]@{ pid = $root.pid; version = $root.version }
            }
            Start-Sleep -Milliseconds 250
        }
        throw "来源 $($Source.Name) 的网关启动超时"
    } catch {
        Stop-Phase4Source -Source $Source
        throw
    }
}

function Stop-Phase4Source([Parameter(Mandatory)] [pscustomobject] $Source) {
    Stop-Phase4Process -Process $Source.Process
}

function Start-Phase4Fixture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $BunPath,
        [Parameter(Mandatory)] [ValidateRange(1024,65535)] [int] $Port,
        [Parameter(Mandatory)] [string] $RunDirectory
    )

    Assert-Phase4FreePort $Port
    $scriptPath = Join-Path $PSScriptRoot 'fixture-provider.ts'
    $logId = [Guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $RunDirectory "fixture-$logId.out.log"
    $stderrPath = Join-Path $RunDirectory "fixture-$logId.err.log"
    $process = Start-Process -FilePath $BunPath -ArgumentList @('run', ('"{0}"' -f $scriptPath), $Port) `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru -ErrorAction Stop
    $timeout = [Diagnostics.Stopwatch]::StartNew()
    try {
        while ($timeout.Elapsed.TotalSeconds -lt 12) {
            if ($process.HasExited) { throw '合成供应商提前退出' }
            $listener = Get-NetTCPConnection -OwningProcess $process.Id -LocalPort $Port -LocalAddress '127.0.0.1' `
                -State Listen -ErrorAction SilentlyContinue
            if ($listener) { return $process }
            Start-Sleep -Milliseconds 250
        }
        throw '合成供应商启动超时'
    } catch {
        Stop-Phase4Process -Process $process
        throw
    }
}
