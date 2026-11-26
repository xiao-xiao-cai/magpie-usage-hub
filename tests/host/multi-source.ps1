[CmdletBinding()]
param(
    [Parameter(Mandatory)] [uri] $CenterUrl,
    [Parameter(Mandatory)] [string] $ReportingKeyAFile,
    [Parameter(Mandatory)] [string] $ReportingKeyBFile,
    [Parameter(Mandatory)] [string] $ReplacementKeyAFile,
    [Parameter(Mandatory)] [string] $ReadOnlyKeyFile,
    [Parameter(Mandatory)] [string] $CandidateArchive,
    [Parameter(Mandatory)] [ValidatePattern('^[0-9a-fA-F]{64}$')] [string] $CandidateSha256,
    [Parameter(Mandatory)] [string] $BunPath,
    [Parameter(Mandatory)] [scriptblock] $RevokeReportingKeyA,
    [string] $MagpieCli = (Join-Path $env:LOCALAPPDATA 'Programs/magpie/magpie.com'),
    [ValidateRange(1024, 65535)] [int] $SourceAPort = 3499,
    [ValidateRange(1024, 65535)] [int] $SourceBPort = 3500,
    [ValidateRange(1024, 65535)] [int] $FixturePort = 3497
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-source.ps1')

function Wait-Phase4Observation([string] $Description, [int] $Seconds, [scriptblock] $Observe) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $observation = & $Observe
        if ($null -ne $observation) { return $observation }
        Start-Sleep -Milliseconds 500
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "$Description 超时"
}

function Invoke-Phase4Http([string] $Origin, [string] $Path, [string] $Key, [string] $Body) {
    $arguments = @{
        Uri = "$Origin$Path"
        NoProxy = $true
        MaximumRedirection = 0
        TimeoutSec = 15
        SkipHttpErrorCheck = $true
    }
    if ($Key) { $arguments.Headers = @{ Authorization = "Bearer $Key" } }
    if ($Body) {
        $arguments.Method = 'Post'
        $arguments.ContentType = 'application/json'
        $arguments.Body = $Body
    }
    try { Invoke-WebRequest @arguments } catch { throw '验收 HTTP 请求失败' }
}

function Read-Phase4Json([string] $Origin, [string] $Path = '/', [string] $Key) {
    $response = Invoke-Phase4Http $Origin $Path $Key
    if ([int]$response.StatusCode -ne 200) { throw "验收读取返回 HTTP $($response.StatusCode)" }
    try { $response.Content | ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String }
    catch { throw '验收读取返回无效 JSON' }
}

function Read-Phase4Page([string] $Origin, [string] $Cursor, [string] $Via, [string] $Key, [string] $CallerId) {
    $path = "/v1/magpie/usage/requests?limit=500&via=$Via&cursor=" + [uri]::EscapeDataString($Cursor)
    if ($CallerId) { $path += '&callerKey=' + [uri]::EscapeDataString($CallerId) }
    $page = Read-Phase4Json $Origin $path $Key
    if ($page.rows -isnot [array] -or $page.has_more -isnot [bool] -or -not $page.next_cursor) {
        throw '验收读取返回无效用量页'
    }
    $page
}

function Read-Phase4State($Source) {
    if (-not (Test-Path -LiteralPath $Source.StatePath -PathType Leaf)) { return }
    try { Get-Content -LiteralPath $Source.StatePath -Raw | ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String }
    catch { throw "来源 $($Source.Name) 状态不可读" }
}

function Get-Phase4Host($Source) {
    if ($null -eq $Source.Process -or $Source.Process.HasExited) { return }
    Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($Source.Process.Id)" |
        Where-Object ExecutablePath -IEQ $Source.BunPath
}

function Wait-Phase4HostReplacement($Source, [object[]] $PreviousHosts) {
    Wait-Phase4Observation "来源 $($Source.Name) Bun 宿主交接" 30 {
        if ($Source.Process.HasExited) { throw "来源 $($Source.Name) 网关进程提前退出" }
        $hosts = @(Get-Phase4Host $Source)
        if ($hosts.Count -ne 1 -or $hosts[0].ProcessId -in $PreviousHosts.ProcessId) { return }
        foreach ($former in $PreviousHosts) {
            $running = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($former.ProcessId)"
            if ($running -and $running.CreationDate -eq $former.CreationDate) { return }
        }
        $hosts[0]
    }
}

function Read-Phase4Diagnostics($Source) {
    $hosts = @(Get-Phase4Host $Source)
    $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3493 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -ne 1 -or $listener[0].OwningProcess -notin $hosts.ProcessId) { return }
    try { $status = Read-Phase4Json 'http://127.0.0.1:3493' '/api/status' } catch { return }
    if ($status.loadedRevision -ceq $Source.Settings.configRevision) { $status }
}

function Send-Phase4Fixture($Source, [string] $Label, [switch] $Stream) {
    $snapshot = Read-Phase4Page -Origin $Source.Origin -Cursor 'now' -Via 'through' -CallerId $Source.ModelKey.id
    $body = @{
        model = $Source.Model
        messages = @(@{ role = 'user'; content = "Usage Hub phase 4 $Label" })
        stream = [bool]$Stream
        max_tokens = 2
    }
    if ($Stream) { $body.stream_options = @{ include_usage = $true } }
    $response = Invoke-Phase4Http $Source.Origin '/v1/chat/completions' $Source.ModelKey.key ($body | ConvertTo-Json -Depth 4 -Compress)
    if ([int]$response.StatusCode -ne 200) { throw "来源 $($Source.Name) 合成模型返回 HTTP $($response.StatusCode)" }
    if ($Stream -and ([string]$response.Headers['Content-Type'] -notmatch 'text/event-stream' -or
        $response.Content -notmatch 'data:\s*\[DONE\]')) { throw '合成流式请求未完整返回事件流' }
    Wait-Phase4Observation "来源 $($Source.Name) 合成记录落账" 15 {
        $page = Read-Phase4Page -Origin $Source.Origin -Cursor $snapshot.next_cursor -Via 'through' -CallerId $Source.ModelKey.id
        if ($page.rows.Count -gt 1 -or $page.has_more) { throw '单次合成调用对应多条记录' }
        if ($page.rows.Count -eq 1) {
            $row = $page.rows[0]
            if ($row.origin -cne 'gateway' -or $row.computer -or $row.callerKeyId -cne $Source.ModelKey.id -or
                -not $row.id -or $row.status -ne 200 -or $row.in -ne 3 -or $row.out -ne 1) {
                throw '合成调用的来源、状态或 Token 不符'
            }
            $row
        }
    }
}

function New-Phase4ExpectedRow($Row, [string] $SourceId) {
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Row.id))).ToLowerInvariant()
    @{ Rid = "mpu1.$SourceId.$digest"; Source = $Row }
}

function Assert-Phase4CenterRows([object[]] $Expected, [object[]] $Absent = @()) {
    $matching = @{}
    foreach ($item in (@($Expected) + @($Absent))) { $matching[$item.Rid] = @() }
    $cursor = $centerStart
    for ($pageNumber = 1; $pageNumber -le 100; $pageNumber++) {
        $page = Read-Phase4Page $centerOrigin $cursor 'reported' $readerKey
        foreach ($row in $page.rows) {
            if ($row.rid -cin $matching.Keys) { $matching[$row.rid] += $row }
        }
        if (-not $page.has_more) { break }
        if ($page.next_cursor -ceq $cursor -or $pageNumber -eq 100) { throw '中心对账超过分页预算' }
        $cursor = $page.next_cursor
    }
    foreach ($item in $Expected) {
        $actual = $matching[$item.Rid]
        if ($actual.Count -ne 1) { throw "中心对应记录数应为 1，实际为 $($actual.Count)" }
        foreach ($field in @('t','provider','model','in','out','status')) {
            if ($actual[0][$field] -cne $item.Source[$field]) { throw "中心字段 $field 与源账本不符" }
        }
        if ($item.Source.priced -eq $true -and ($actual[0].priced -ne $true -or $actual[0].cost -ne $item.Source.cost)) {
            throw '中心已计价成本与源账本不符'
        }
    }
    foreach ($item in $Absent) {
        if ($matching[$item.Rid].Count -ne 0) { throw '撤销期间来源 A 的新记录已入账' }
    }
}

function Wait-Phase4CursorAdvance($Source, $PreviousState) {
    Wait-Phase4Observation "来源 $($Source.Name) 确认新游标" 45 {
        $state = Read-Phase4State $Source
        if ($state -and $state.sourceInstanceId -cne $PreviousState.sourceInstanceId) { throw '来源实例身份变化' }
        if ($state.cursor -and $state.cursor -cne $PreviousState.cursor) { $state }
    }
}

function Read-Phase4PrivateKeyFile([string] $Path) {
    try {
        $file = Get-Item -LiteralPath $Path
        if ($file -isnot [IO.FileInfo] -or $file.LinkType) { throw '无效凭据文件' }
        $key = [IO.File]::ReadAllText($file.FullName).Trim()
        if ($key -cnotmatch '^[\x21-\x7e]+$') { throw '无效凭据内容' }
        @{ Path = $file.FullName; Key = $key }
    } catch { throw '无法读取专用凭据文件' }
}

$dailyOrigin = 'http://127.0.0.1:3425'
$dailyGateway = Read-Phase4Json $dailyOrigin
if ($dailyGateway.name -cne 'magpie' -or -not $dailyGateway.pid) { throw '日常网关身份无效' }
if (-not $CenterUrl.IsAbsoluteUri -or $CenterUrl.Scheme -notin @('http','https') -or $CenterUrl.IsLoopback -or
    $CenterUrl.UserInfo -or $CenterUrl.AbsolutePath -cne '/' -or $CenterUrl.Query -or $CenterUrl.Fragment) {
    throw '中心地址应为服务器的 HTTP 或 HTTPS 网关根地址'
}
$centerOrigin = $CenterUrl.GetLeftPart([UriPartial]::Authority)
$ports = @(3493, $SourceAPort, $SourceBPort, $FixturePort)
if (3425 -in $ports -or @($ports | Sort-Object -Unique).Count -ne $ports.Count) { throw '验收端口必须各自独立' }
$occupied = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -In $ports)
if ($occupied.Count) { throw "验收端口占用 $($occupied.LocalPort -join ',')" }

$reportA = Read-Phase4PrivateKeyFile $ReportingKeyAFile
$reportB = Read-Phase4PrivateKeyFile $ReportingKeyBFile
$replacementA = Read-Phase4PrivateKeyFile $ReplacementKeyAFile
$reader = Read-Phase4PrivateKeyFile $ReadOnlyKeyFile
if (@(@($reportA.Path, $reportB.Path, $replacementA.Path, $reader.Path) | Sort-Object -Unique).Count -ne 4 -or
    @(@($reportA.Key, $reportB.Key, $replacementA.Key, $reader.Key) | Sort-Object -CaseSensitive -Unique).Count -ne 4) {
    throw '验收应使用四份独立凭据'
}
$readerKey = $reader.Key
$center = Read-Phase4Json $centerOrigin '/' $readerKey
$centerBaseline = Read-Phase4Page $centerOrigin 'now' 'reported' $readerKey
if ($center.name -cne 'magpie' -or -not $center.version -or $centerBaseline.rows.Count -ne 0 -or $centerBaseline.has_more) {
    throw '中心版本或对账起点无效'
}
$centerStart = $centerBaseline.next_cursor
$archive = Get-Item -LiteralPath $CandidateArchive
if ($archive -isnot [IO.FileInfo] -or $archive.LinkType -or
    (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash -ine $CandidateSha256) { throw '候选归档 SHA-256 不符' }
$magpieCli = (Resolve-Path -LiteralPath $MagpieCli).Path
$BunPath = (Resolve-Path -LiteralPath $BunPath).Path
$bunVersion = & $BunPath --version
if ($LASTEXITCODE -ne 0 -or -not $bunVersion) { throw '验收 Bun 版本读取失败' }

$runDirectory = New-Phase4RunDirectory
& tar -xf $archive.FullName -C $runDirectory 2>$null
if ($LASTEXITCODE -ne 0) { throw '候选归档解包失败' }
$packageDirectory = Join-Path $runDirectory 'package'
$manifest = Get-Content -LiteralPath (Join-Path $packageDirectory 'package.json') -Raw | ConvertFrom-Json -AsHashtable
if ($manifest.name -cne 'magpie-usage-hub' -or $manifest.version -cne '0.3.0' -or
    $manifest.magpie.options.enabled -ne $false -or $manifest.magpie.page.service.port -ne 3493 -or
    $manifest.exports.'./server' -cne './server.ts') { throw '候选包清单不符' }

$fixtureProcess = $null
$sourceA = $null
$sourceB = $null
$testFailure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
try {
    $fixtureProcess = Start-Phase4Fixture -BunPath $BunPath -Port $FixturePort -RunDirectory $runDirectory
    $sourceArguments = @{
        RunDirectory = $runDirectory; MagpieCli = $magpieCli; BunPath = $BunPath; PackageDirectory = $packageDirectory
        FixturePort = $FixturePort; CenterUrl = $centerOrigin
    }
    $sourceA = New-Phase4Source @sourceArguments -Name 'A' -Port $SourceAPort -ReportingKeyFile $reportA.Path
    $sourceB = New-Phase4Source @sourceArguments -Name 'B' -Port $SourceBPort -ReportingKeyFile $reportB.Path
    $gatewayA = Start-Phase4Source -Source $sourceA
    $null = Wait-Phase4Observation '来源 A 首次游标和诊断就绪' 45 {
        $status = Read-Phase4Diagnostics $sourceA
        if ($status.phase -ceq 'blocked') { throw '来源 A 首次同步已阻塞' }
        if ($status.appliedRevision -ceq $sourceA.Settings.configRevision -and (Read-Phase4State $sourceA).cursor) { $status }
    }
    $gatewayB = Start-Phase4Source -Source $sourceB
    if ($gatewayA.pid -eq $gatewayB.pid -or $dailyGateway.pid -in @($gatewayA.pid, $gatewayB.pid) -or
        $gatewayA.version -cne $gatewayB.version) { throw '隔离来源进程或版本核对失败' }
    $initialA = Read-Phase4State $sourceA
    $initialB = Wait-Phase4Observation '来源 B 首次游标落盘' 45 {
        $state = Read-Phase4State $sourceB
        if ($state.cursor) { $state }
    }
    $initialHostB = @(Get-Phase4Host $sourceB)
    if (-not $initialA.sourceInstanceId -or -not $initialB.sourceInstanceId -or $initialA.binding.initialMode -cne 'now' -or
        $initialB.binding.initialMode -cne 'now' -or $initialA.sourceInstanceId -ceq $initialB.sourceInstanceId -or
        $initialHostB.Count -ne 1) { throw '独立来源身份、宿主或首次模式核对失败' }

    $firstA = New-Phase4ExpectedRow (Send-Phase4Fixture $sourceA 'normal') $initialA.sourceInstanceId
    $firstB = New-Phase4ExpectedRow (Send-Phase4Fixture $sourceB 'stream' -Stream) $initialB.sourceInstanceId
    $confirmedA = Wait-Phase4CursorAdvance $sourceA $initialA
    $confirmedB = Wait-Phase4CursorAdvance $sourceB $initialB
    $expected = @($firstA, $firstB)
    Assert-Phase4CenterRows $expected

    $null = Read-Phase4Json $centerOrigin '/v1/magpie/usage?period=all' $readerKey
    $null = Read-Phase4Page $centerOrigin 'now' 'through' $readerKey
    $probe = @{ rid = $firstA.Rid }
    foreach ($field in @('t','agent','provider','model','in','out','status')) { $probe[$field] = $firstA.Source[$field] }
    $probeBody = ConvertTo-Json -InputObject @($probe) -Compress
    foreach ($response in @(
        (Invoke-Phase4Http $centerOrigin '/v1/magpie/usage/requests' $readerKey $probeBody),
        (Invoke-Phase4Http $centerOrigin '/v1/chat/completions' $readerKey '{')
    )) {
        try { $errorCode = ($response.Content | ConvertFrom-Json -AsHashtable).error.code }
        catch { throw '中心只读权限探测返回无效 JSON' }
        if ([int]$response.StatusCode -ne 403 -or $errorCode -cne 'gateway_key_read_only') { throw '中心只读权限探测不符' }
    }
    Write-Information '双来源入账、字段和只读权限已核对' -InformationAction Continue

    try { & $RevokeReportingKeyA | Out-Null } catch { throw '撤销来源 A 专用上报 Key 失败' }
    $revokedProbe = Invoke-Phase4Http $centerOrigin '/v1/magpie/usage/requests' $reportA.Key $probeBody
    if ([int]$revokedProbe.StatusCode -notin @(401,403)) { throw '来源 A 的原上报 Key 仍可使用' }
    $pendingA = New-Phase4ExpectedRow (Send-Phase4Fixture $sourceA 'revoked') $initialA.sourceInstanceId
    $blocked = Wait-Phase4Observation '来源 A 鉴权阻塞' 45 {
        $status = Read-Phase4Diagnostics $sourceA
        if ($status.phase -ceq 'blocked') {
            if ($status.failure.stage -cne 'center' -or $status.failure.code -cne 'unauthorized' -or
                $status.failure.httpStatus -ne [int]$revokedProbe.StatusCode) { throw '来源 A 阻塞原因与撤销响应不符' }
            $status
        }
    }
    if ((Read-Phase4State $sourceA).cursor -cne $confirmedA.cursor) { throw '来源 A 被拒绝后游标推进' }
    Assert-Phase4CenterRows $expected @($pendingA)

    $secondB = New-Phase4ExpectedRow (Send-Phase4Fixture $sourceB 'while-a-revoked') $initialB.sourceInstanceId
    $null = Wait-Phase4CursorAdvance $sourceB $confirmedB
    $expected += $secondB
    Assert-Phase4CenterRows $expected @($pendingA)
    if ((Read-Phase4State $sourceA).cursor -cne $confirmedA.cursor) { throw '来源 A 阻塞期间游标推进' }
    Write-Information '来源 A 持续阻塞，来源 B 已继续入账' -InformationAction Continue

    $previousAHosts = @(Get-Phase4Host $sourceA)
    if ($previousAHosts.Count -ne 1) { throw '来源 A 重载前 Bun 宿主数量不符' }
    $sourceA.Settings.centralKeyFile = $replacementA.Path
    $sourceA.Settings.configRevision = [Guid]::NewGuid().ToString()
    Set-Phase4Options -Source $sourceA
    $null = Wait-Phase4HostReplacement $sourceA $previousAHosts
    $resumedA = Wait-Phase4CursorAdvance $sourceA $confirmedA
    $expected += $pendingA
    Assert-Phase4CenterRows $expected

    $fixtureTime = [DateTimeOffset]::Parse($pendingA.Source.t, [cultureinfo]::InvariantCulture).UtcDateTime
    $dateFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'"
    $from = $fixtureTime.AddMilliseconds(-1).ToString($dateFormat, [cultureinfo]::InvariantCulture)
    $to = $fixtureTime.AddMilliseconds(2).ToString($dateFormat, [cultureinfo]::InvariantCulture)
    if ([DateTimeOffset]::Parse($to).UtcDateTime -gt [DateTime]::UtcNow) { throw '同中心回填截止时间尚未经过' }
    $requestId = [Guid]::NewGuid().ToString()
    $sourceA.Settings.configRevision = [Guid]::NewGuid().ToString()
    $sourceA.Settings.recoveryRequest = @{ id = $requestId; kind = 'range'; from = $from; to = $to; binding = $resumedA.binding }
    Set-Phase4Options -Source $sourceA
    $replay = Wait-Phase4Observation '来源 A 原中心回填完成' 45 {
        $state = Read-Phase4State $sourceA
        $result = $state.recovery.results | Where-Object { $_.request.id -ceq $requestId }
        if ($result -and $result.status -cne 'complete') { throw '来源 A 原中心回填失败' }
        if ($result) { @{ State = $state; Result = $result } }
    }
    if ($replay.Result.accepted -ne 0 -or $replay.Result.skipped -ne 1 -or $replay.State.version -ne 2 -or
        $replay.State.cursor -cne $resumedA.cursor -or $replay.State.sourceInstanceId -cne $initialA.sourceInstanceId) {
        throw '来源 A 原中心回填去重、游标或身份不符'
    }
    $currentHostB = @(Get-Phase4Host $sourceB)
    if ($currentHostB.Count -ne 1 -or $currentHostB[0].ProcessId -ne $initialHostB[0].ProcessId -or
        $currentHostB[0].CreationDate -ne $initialHostB[0].CreationDate -or
        (Read-Phase4Json $sourceA.Origin).pid -ne $gatewayA.pid -or (Read-Phase4Json $sourceB.Origin).pid -ne $gatewayB.pid) {
        throw '来源 A 的重载波及其他进程'
    }
    Assert-Phase4CenterRows $expected
    Write-Information '来源 A 已补传并通过回填去重' -InformationAction Continue
} catch {
    $testFailure = $_
} finally {
    $sources = @($sourceA, $sourceB) | Where-Object { $null -ne $_ }
    $stoppedState = @{}
    $maxPoll = 0
    foreach ($source in $sources) {
        try {
            $previous = @(Get-Phase4Host $source)
            $source.Settings.enabled = $false
            $source.Settings.configRevision = [Guid]::NewGuid().ToString()
            Set-Phase4Options -Source $source
            if ($source.Process -and -not $source.Process.HasExited) {
                if ($previous.Count -eq 0) { throw '未观察到原 Bun 宿主' }
                $null = Wait-Phase4HostReplacement $source $previous
                $stoppedState[$source.Name] = Read-Phase4State $source
                $maxPoll = [Math]::Max($maxPoll, [int]$source.Settings.pollIntervalSec)
            }
        } catch { $cleanupFailures.Add("来源 $($source.Name) 停用确认失败") }
    }
    try {
        if ($maxPoll -gt 0) { Start-Sleep -Seconds (2 * $maxPoll + 1) }
        foreach ($source in $sources) {
            if (-not $stoppedState.ContainsKey($source.Name)) { continue }
            $end = Read-Phase4State $source
            $before = $stoppedState[$source.Name]
            if ($before.cursor -cne $end.cursor -or $before.lastConfirmedAt -cne $end.lastConfirmedAt) {
                $cleanupFailures.Add("来源 $($source.Name) 停用后持久进度变化")
            }
        }
    } catch { $cleanupFailures.Add('暂停后的持久状态检查失败') }
    foreach ($source in $sources) {
        try { Stop-Phase4Source -Source $source } catch { $cleanupFailures.Add("来源 $($source.Name) 进程停止失败") }
    }
    if ($fixtureProcess) {
        try { Stop-Phase4Process -Process $fixtureProcess } catch { $cleanupFailures.Add('合成供应商进程停止失败') }
    }
    $remainingPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -In $ports)
    if ($remainingPorts.Count) { $cleanupFailures.Add('验收端口未全部关闭') }
    try {
        if ((Read-Phase4Json $dailyOrigin).pid -ne $dailyGateway.pid) { throw '日常网关 PID 发生变化' }
        if ((Read-Phase4Json $centerOrigin '/' $readerKey).version -cne $center.version) { throw '中心版本发生变化' }
    } catch { $cleanupFailures.Add('收尾网关核对失败') }
}

if ($cleanupFailures.Count) { Write-Warning ($cleanupFailures -join '，') }
if ($testFailure) { throw $testFailure }
if ($cleanupFailures.Count -or $stoppedState.Count -ne 2) { throw '双来源停用验收未完成' }
[pscustomobject]@{
    CandidateVersion = $manifest.version
    WindowsMagpieVersion = $gatewayA.version
    DockerMagpieVersion = $center.version
    SourceBunVersion = $bunVersion
    InitialReportedRows = 2
    FinalReportedRows = $expected.Count
    OriginalFieldsMatch = $true
    ReadOnlyGets = 3
    ReadOnlyDenied = 2
    RevokedModelStatus = 200
    RevokedReportingStatus = $blocked.failure.httpStatus
    RevokedCursorPreserved = $true
    OtherSourceContinued = $true
    ReplacementIdentityPreserved = $true
    ReplayAccepted = $replay.Result.accepted
    ReplaySkipped = $replay.Result.skipped
    ReplayCursorPreserved = $true
    DisabledAndQuiescent = $true
    DailyGatewayPreserved = $true
    CenterGatewayHealthy = $true
}
