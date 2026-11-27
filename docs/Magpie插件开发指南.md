# Magpie 插件开发指南

2026-11-25 · 以 Windows 和 Magpie `v0.1.4783` 为操作基线

从一个显示今日调用量的页面开始，随后用一个最小后端验证插件宿主。本指南说明怎样选择插件入口、准备环境、安装调试和发布。开发本仓库的只读拉取时，先查功能规格和当前兼容性基线。[功能规格与开发参考索引](01-插件定位与功能规格.md) · [开发基线](02-开发基线与兼容性.md) · [官方插件开发文档](https://usemagpie.ai/docs/plugins) · [Magpie v0.1.4783](https://github.com/yetone/magpie/releases/tag/v0.1.4783)

## 1. 先选插件入口

| 要做的功能 | 入口 | 在哪里运行 |
| --- | --- | --- |
| 用量看板、配置页、状态页 | `package.json` 中的 `magpie.page` 或 `magpie.panels` | Magpie 界面的沙箱 iframe，用 HTML、CSS、JS 和 `magpie` 页面桥。 |
| 文件读写、后台任务、访问网关 API | OpenCode 风格的宿主入口，优先声明 `exports["./server"]`，也可声明 `main` | Magpie 管理的 Bun 进程。本仓库的中心插件使用这一入口。 |
| 接入模型供应商、API Key 或订阅登录 | 宿主入口返回 `config`、`auth`、`provider` 等 hook | Bun。Magpie 通过它加载账号、列出模型、发出供应商请求和查询配额。 |
| 路由前需要异步 I/O，例如按请求读取外部上下文 | `magpie.hooks` 或 `*.hooks.ts` 等单文件，导出 `onRequest` | Bun，在路由前执行，受超时和请求变更规则约束。 |
| 修改网关入参、流式事件或普通响应 | `magpie.middleware` 或 `*.middleware.js` 等单文件 | 网关进程中的 moejs。可用标准 JS，网络、文件系统和定时任务由其他运行时承担。 |
| 自定义账号尝试顺序、观察已结束请求的用量 | `magpie.gateway` 或 `*.gateway.js`，导出 `strategies`、`onUsage` | 同一个 moejs 扩展机制，观察回调在请求结束后异步执行。 |
| 为 Agent 提供工具 | 宿主入口返回 `tool`，Magpie 提供 `/mcp/magpie/tools` | Bun。调用前验证参数，通过 Streamable HTTP MCP 暴露。 |
| 让 Magpie 能配置一个新 Agent | `magpie.agent` 指向定义文件，提供 Agent 配置位置和 `connect` 等字段 | 由 Magpie 读取声明、写入 Agent 的网关配置，并处理断开后的恢复。 |

同一个包可以声明页面和后端，安装时作为一个插件管理。已有 OpenCode 插件需要核对 Magpie 实现了哪些输入和 hook。注册 provider 的 pi 扩展也有对应加载机制，其 provider、模型和认证能力可用，pi 的命令、渲染器和事件不能按原能力原样移植。源码里的内置插件注册表及 `plugins.yml` 属于 Magpie 自身的 Go 组件。这里使用外部插件的包入口和 `plugins.json`。[宿主与入口](https://usemagpie.ai/docs/plugins#package) · [网关异步 hooks](https://usemagpie.ai/docs/plugins#gateway-request) · [网关中间件](https://usemagpie.ai/docs/plugins#middleware) · [工具](https://usemagpie.ai/docs/plugins#tools) · [Agent 扩展](https://usemagpie.ai/docs/plugins#agents) · [pi 包](https://usemagpie.ai/docs/plugins#pi) · [插件体系源码说明](https://github.com/yetone/magpie/blob/v0.1.4783/docs/subsystems/plugin-runtime.md)

## 2. 开发环境与隔离

| 需要准备什么 | 用途 |
| --- | --- |
| Magpie 发布版、终端、编辑器 | 本地插件可以从文件或目录直接加载。先执行 `magpie --version`。Web 形态便于在浏览器开发工具中检查页面。 |
| JavaScript 或 TypeScript | 宿主入口可以用 `.mjs`，Bun 也可直接执行 `.ts`。页面使用浏览器可执行的 JS。中间件以 JavaScript 为入口，将所需依赖提前打包。 |
| Bun | Magpie 在需要时下载自身的 Bun。`v0.1.4783` 的内置基线为 `1.4.2`。本机可另装 Bun 跑 `bun test`，或在开发终端用 `MAGPIE_BUN` 指到选定的可执行文件做版本复验。 |
| Node.js、npm、Git | 可按需用于前端构建、npm 发包和版本控制。运行下面的最小例子只需要 Magpie。 |

外部 npm 包由 Magpie 用 Bun 安装，依赖的安装脚本默认不执行。需要 `postinstall` 下载二进制或编译原生模块的依赖，要换成已构建的产物或验证可运行的替代方案。本地路径直接加载包目录，若用了第三方依赖，在开发目录自行安装依赖。网络受限时先验证 Bun 下载、npm registry 和代理。host 默认继承 Magpie 的网络配置，供应商或账号可有自己的代理，回环请求直连。[运行方式与依赖安装](https://usemagpie.ai/docs/plugins#run) · [Bun 版本和覆盖配置源码](https://github.com/yetone/magpie/blob/v0.1.4783/internal/plugin/bun.go) · [Bun 安装](https://bun.com/docs/installation)

### Windows 隔离实例

在专用 PowerShell 终端执行下面的命令。路径均从一个新建的临时目录派生，测试网关使用 `3499`，管理 Web 使用 `3498`。使用安装版时，Magpie 在 Windows 以 `USERPROFILE` 为 home，并用 `XDG_CONFIG_HOME` 和 `XDG_CACHE_HOME` 设置自己的目录。便携版的 `data` 目录优先，测试可另准备便携副本。涉及第三方 Agent、二进制依赖或 OAuth 时，在临时用户、虚拟机或测试容器中运行，尤其要隔离已设置的 Agent 专用配置环境变量和系统凭据。

```powershell
$magpieDevRoot = Join-Path ([IO.Path]::GetTempPath()) ('magpie-dev-' + [guid]::NewGuid().ToString('N'))
$env:USERPROFILE = Join-Path $magpieDevRoot 'home'
$env:HOME = $env:USERPROFILE
$env:APPDATA = Join-Path $magpieDevRoot 'roaming'
$env:LOCALAPPDATA = Join-Path $magpieDevRoot 'local'
$env:XDG_CONFIG_HOME = Join-Path $magpieDevRoot 'config'
$env:XDG_CACHE_HOME = Join-Path $magpieDevRoot 'cache'
$env:MAGPIE_ADDR = '127.0.0.1:3499'
New-Item -ItemType Directory -Force -Path $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA, $env:XDG_CONFIG_HOME, $env:XDG_CACHE_HOME | Out-Null
magpie --version
```

在这个终端里安装测试插件、启动测试 Web。`magpie web` 默认打开带管理鉴权的浏览器链接。检查启动输出中的网关端口和配置目录，确认用的是新实例。换个普通终端即可回到日常环境。Linux 和 macOS 可以按官方示例为进程设置独立的 `HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 和回环端口。[官方隔离测试示例](https://usemagpie.ai/docs/plugins#test) · [Windows home 规则](https://github.com/yetone/magpie/blob/v0.1.4783/internal/appdir/env.go) · [配置目录和便携模式](https://github.com/yetone/magpie/blob/v0.1.4783/internal/appdir/appdir.go)

## 3. 第一个插件：今日用量页面

在开发目录建立 `magpie-usage-glance-dev`，按以下结构放置三个文件。包名使用 ASCII，中文名称用 `magpie.page.title` 或 `magpie.page.titles` 声明。

```text
magpie-usage-glance-dev/
  package.json
  page/
    index.html
    app.js
```

**`magpie-usage-glance-dev/package.json`**

```json
{
  "name": "magpie-usage-glance-dev",
  "version": "0.1.0",
  "private": true,
  "magpie": {
    "page": {
      "title": "今日用量",
      "file": "page/index.html"
    },
    "permissions": ["usage:summary"]
  }
}
```

**`magpie-usage-glance-dev/page/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>今日用量</title>
  <script src="_magpie/bridge.js"></script>
  <script src="app.js" defer></script>
</head>
<body>
  <h1>今日用量</h1>
  <p id="usage" role="status">正在读取用量</p>
</body>
</html>
```

**`magpie-usage-glance-dev/page/app.js`**

```js
async function showUsage() {
  const status = document.getElementById('usage')
  try {
    await magpie.ready
    const summary = await magpie.read('usage:summary', { period: 'today' })
    status.textContent = `调用 ${summary.calls} 次，失败 ${summary.errors} 次`
  } catch (error) {
    status.textContent = '读取用量失败，请检查插件权限后重试。'
    console.error(error)
  }
}

void showUsage()
```

从包目录的上一级运行。想同时验证下一节的后端时，可以在启动 `magpie web` 前一起安装两个包。

```powershell
magpie plugin add ./magpie-usage-glance-dev
magpie plugin list --json
magpie web --addr 127.0.0.1:3498 --gateway
```

也可在隔离 Web 的「插件 → 添加插件」中选本地目录。打开左侧「插件 → 今日用量」，新的测试账本通常显示调用 0 次。修改 `app.js` 后重新打开页面或重载插件。开发时用浏览器的开发工具查看对应 iframe 的日志。此例的 `private: true` 用于本地包，发布前处理该字段。[官方页面示例](https://usemagpie.ai/docs/plugins#pages) · [页面 bridge 实现](https://github.com/yetone/magpie/blob/v0.1.4783/internal/gui/pagebridge.js)

### 页面开发规则

- `_magpie/bridge.js` 由 Magpie 提供。等 `magpie.ready` 完成后使用主题、读取权限内的数据或读取插件自己的设置。页面放在包内一棵独立目录中，脚本用 `<script src>` 引入。样式可以使用 `--magpie-bg`、`--magpie-fg` 等主题变量。
- `magpie.read('usage:summary', { period: 'today' })` 需要在 `magpie.permissions` 声明。该读权限支持 `today`、`7d`、`30d`。`usage:day` 和 `providers:list` 是其他可声明的读权限，具体参数见版本源码。页面自身的 `magpie.options.get()` 和 `.set()` 用于普通选项，写入频率最多每秒一次。密钥放在宿主侧的受保护存储。
- 静态页面的安全策略包含 `connect-src 'none'`。页面数据通过桥接读权限或后端服务入口提供。可以在 `magpie.panels` 中声明 `usage` 等内置槽位。页面可能在切走后被回收，`keepAlive` 管的是 iframe，后台工作应有宿主生命周期管理。[页面权限与运行时](https://github.com/yetone/magpie/blob/v0.1.4783/docs/subsystems/plugin-runtime.md) · [面板](https://usemagpie.ai/docs/plugins#panels)

## 4. 加上 Bun 后端

下面的第二个例子专门验证服务端入口和日志。建立 `magpie-host-smoke-dev` 目录，并放入两个文件。

**`magpie-host-smoke-dev/package.json`**

```json
{
  "name": "magpie-host-smoke-dev",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    "./server": "./server.mjs"
  }
}
```

**`magpie-host-smoke-dev/server.mjs`**

```js
export default {
  id: 'magpie-host-smoke-dev',
  async server() {
    console.log('magpie-host-smoke-dev: Bun host loaded')
    return {}
  },
}
```

```powershell
magpie plugin add ./magpie-host-smoke-dev
magpie plugin list --json
```

预期在插件日志或终端的 `plugin:` 输出里看到 `Bun host loaded`。这是当前 CLI 进程加载了后端的证据。运行中的桌面或 Web 使用自己的宿主，这两处要各自验收。`magpie plugin off <插件标识>`、`magpie plugin on <插件标识>` 可用于显式重载。CLI 的完整安装项与选项见 `magpie plugin help`。[官方测试说明](https://usemagpie.ai/docs/plugins#test) · [插件 CLI 实现](https://github.com/yetone/magpie/blob/v0.1.4783/internal/cli/plugins_cli.go)

### 入口、配置和状态

1. **定位入口。** 顺序为 `exports["./server"]`、`main`、`exports["."]` 或字符串形式的 `exports`，随后尝试 `index.ts`、`index.tsx`、`index.js`、`index.mjs`、`index.cjs`。也可以直接添加一个文件。默认导出 `{ id, server }` 可明确指定唯一入口。旧式的多个命名函数导出会分别被宿主调用，测试辅助函数应留在别的模块或放在导出的对象属性里。
2. **区分路径和配置。** `server(input, options)` 的 `input.directory`、`input.worktree` 是 Magpie 的配置目录。用它定位插件自己的持久状态子目录。需要读包内资源时，以 `import.meta.url` 为基准。`options` 是安装项持久化的 JSON 配置，宿主启动时读取。更新前做类型、范围、路径和 URL 校验。`input.serverUrl` 是 OpenCode 兼容形状中的占位地址，Magpie 网关地址应由插件独立配置。
3. **按生命周期设计。** 同一 Magpie 进程的启用后端插件共享 Bun 宿主。插件初始化应尽快返回。打开带后端的插件页可触发宿主启动。安装、开关、修改选项、升级都可能触发重载。常驻任务需验收冷启动、宿主重启和休眠恢复。临时执行 `magpie plugin list --json` 等命令也可能启动自己的宿主，有写入或定时任务的插件应通过明确的启用条件和跨进程互斥避免误启动或重复执行。
4. **控制权限和日志。** Bun 后端以宿主用户权限运行，可访问文件、网络和进程。只安装信任的代码，按需限定允许的目标地址和文件路径，为网络 I/O 使用超时。日志记录状态码、计数和脱敏错误，凭据、提示词、聊天响应及用户路径留在其需要的信任范围内。

[官方包入口和输入](https://usemagpie.ai/docs/plugins#input) · [Bun 宿主源码](https://github.com/yetone/magpie/blob/v0.1.4783/internal/plugin/host.js) · [插件选项](https://github.com/yetone/magpie/blob/v0.1.4783/docs/subsystems/provider-plugins.md#a-plugins-own-options) · [打开页面时启动宿主](https://github.com/yetone/magpie/blob/v0.1.4783/internal/gui/pluginpage.go)

### 在页面里展示后端状态

在有 Bun 入口的包上加 `magpie.page`，需要本地 HTTP 服务时再声明 `magpie.page.service`。将下例的 `magpie` 字段合并到原来的 `package.json`。服务在 Bun 中监听 `127.0.0.1:3477`，`options.port` 可覆盖配置端口。`port`、程序实际监听端口和页面取得的地址须一致。

```json
{
  "magpie": {
    "page": {
      "title": "同步状态",
      "file": "page/index.html",
      "service": {
        "port": 3477,
        "option": "port"
      }
    }
  }
}
```

在 `magpie web` 中，bridge 就绪后可从 `magpie.service` 取得通过 Magpie 代理的服务入口。它使用随进程变化的插件页 URL。静态页的典型做法是用它导航到服务提供的页面，由服务页面按自己的 CSP 访问相对 API，例如 `api/status`。桌面窗口在此版本的 bridge 中返回空的 `magpie.service`。若同时支持桌面，要验证受控回环入口的导航、沙箱和认证；把服务的读取结果设计为可公开给当前管理用户的脱敏数据。诊断端点可先做只读，能修改状态的操作需要后端单独校验身份、来源和请求。业务系统查询全局用量时应使用稳定的原生网关 API。[页面服务机制与示例](https://github.com/yetone/magpie/blob/v0.1.4783/docs/subsystems/plugin-runtime.md#p4-community-plugins-at-every-point) · [页面代理实现](https://github.com/yetone/magpie/blob/v0.1.4783/internal/gui/pageservice.go)

## 5. 常用扩展点的开发注意事项

| 扩展点 | 实现与测试重点 |
| --- | --- |
| Provider | 从官方 Acme 示例改起。`config` 声明 provider 和基础模型，`auth.methods` 提供登录方式，`auth.loader(getAuth)` 返回账号对应的 `baseURL`、`fetch` 或其他选项，`provider.models` 提供账号模型目录。用模拟供应商先测 API 协议、流式响应、取消、上游状态码及失败回退，再测真实账号。供应商 ID 冲突时核对界面最终使用的 ID。 |
| 配额 | Provider 的 `auth.usage` 查询账号剩余额度或已用比例，使用 `magpie quota` 检查。逐请求用量使用网关账本。 |
| Bun 异步网关 hook | `onRequest(body, ctx)` 位于路由前。适当使用 `ctx.signal`，默认每 hook 一秒预算，可配置 `gatewayTimeoutMs`。`onResponse` 是完成通知。返回值、允许改动的字段以及失败放行要按官方约定测试。 |
| JS 中间件 | `onRequest`、`onAccount`、`onProvider`、`onEvent` 和 `onResponse` 分别对应请求、账号选择、供应商尝试、流式事件和普通回复。按需使用 `ctx.state`，为 SSE 分片与多次上游尝试准备夹具。`onEvent` 的单次预算只有 50 ms，避免每事件做重计算。 |
| `onUsage` | 收到的是选定字段的完成事件。单次预算 250 ms，队列满时会丢事件，事件也不带用于账本去重的完整请求 ID。适合轻量观察，完整用量从原生账本的游标 API 读取。 |
| MCP 工具 | 用 `tool` 定义参数 schema，执行时传递 `ctx.abort`。工具的执行时限为 55 秒。检查权限、无效参数和副作用，保持结果精简。 |
| Agent 配置 | 用独有 ID 和测试配置文件。验证识别、接入、换模型、断开恢复以及配置解析失败等状态，重点核对原配置是否按预期恢复。 |

[官方 Acme 入门](https://usemagpie.ai/docs/plugins#quick) · [请求与流式处理](https://usemagpie.ai/docs/plugins#requests) · [配额 hook](https://usemagpie.ai/docs/plugins#usage) · [路由与用量观察](https://usemagpie.ai/docs/plugins#gateway-points) · [中间件执行限制](https://github.com/yetone/magpie/blob/v0.1.4783/docs/subsystems/gateway-middleware.md)

### 在中心只读插件里怎样分工

中心 Bun 管理运行锁、来源设置和网关查询。Options 页保存同一实例的回环地址及启用状态。Magpie Web 代理中心看板和管理页，只有后端消费远程 Key 与原生响应。[整体架构与模块职责](03-整体架构与模块职责.md) · [网关接口与用量数据规范](04-网关接口与用量数据规范.md)

改变请求、字段或来源写入时，用模拟 HTTP 端点和临时目录验证响应、部分失败和下次读回。涉及宿主接管时用单个隔离实例，跨网关查询时核对实际来源和中心。[同步流程与故障恢复设计](05-同步流程与故障恢复设计.md) · [开发阶段与验收计划](08-开发阶段与验收计划.md)

## 6. 调试、测试与发布

| 阶段 | 做法 |
| --- | --- |
| 快速调试 | 本地包直接加载。`magpie plugin list --json` 看加载结果、入口类型、账号或模型。后端钩子看 `plugin:` 日志，页面看浏览器 iframe 的控制台。编辑后在测试 Magpie 显式重载，确认加载的是新代码。 |
| 单元测试 | 用 `bun test` 测数据映射、配置规范、请求重试判断和状态迁移。把需要网络与文件系统的代码放在可注入的边界，用测试数据替代真实账号。 |
| 实例测试 | 测本地路径安装和拟发布产物安装。按支持范围分别测试 Windows 桌面、Magpie Web 或无界面服务器，并验证启用、重启、升级和停用。带页面服务时检查页面握手、代理路径、回环监听、端口冲突和浏览器差异。 |
| 发布产物 | README 写清支持的 Magpie 版本、安装命令、配置项、需要的权限、状态和凭据位置、停用及升级方法。用 `npm pack --dry-run` 检查产物包含入口、页面资源和许可证。正式 npm 包移除 `private: true`，通过 `files` 控制打包范围。 |
| 直接分发 | 小范围可从固定目录安装，或用 `magpie plugin add github:组织/仓库#提交哈希`、`magpie plugin add 包名@版本` 固定代码。Git 安装要求实际入口与构建产物已提交。固定 npm 版本仍可在显式执行更新后变化。 |
| 让他人发现 | 公共 GitHub 仓库可用 `magpie-plugin` topic 和根目录 `package.json`，按非官方插件展示规则处理。社区收录按 `magpie-community/plugins` 仓库的规则提交 `registry.json`。npm 安装页可用 `magpie://plugin?name=<包名>` 打开，由用户确认安装。 |

[官方测试](https://usemagpie.ai/docs/plugins#test) · [发布与收录](https://usemagpie.ai/docs/plugins#publish) · [社区检查脚本](https://github.com/magpie-community/plugins/blob/main/scripts/check.mjs) · [社区隔离试跑脚本](https://github.com/magpie-community/plugins/blob/main/scripts/try.sh)

**示例验证记录。** Windows 上使用隔离配置的 Magpie `v0.1.4783` 安装了两个本地示例，CLI 成功加载 Bun 后端并输出标记。Magpie Web 注册并返回了「今日用量」页面，`usage:summary` 返回空账本计数，未声明的 `providers:list` 返回 403。验证覆盖页面注册、资源和服务端权限。桌面渲染、浏览器内桥接交互、跨机上报和后台长期运行留给相应的集成验收。

## 7. 示例仓库与查阅入口

| 来源 | 从哪里看起 |
| --- | --- |
| [Magpie 官方文档](https://usemagpie.ai/docs/plugins) | 写插件的主入口，包含完整 Acme provider 示例、页面、工具、Agent 和发布说明。 |
| [yetone/magpie](https://github.com/yetone/magpie) | 查发布版本、宿主加载行为和网关实际约束。固定版本的 [插件运行时说明](https://github.com/yetone/magpie/blob/v0.1.4783/docs/subsystems/plugin-runtime.md) 适合与官网对照。 |
| [magpie-community/plugins](https://github.com/magpie-community/plugins) | 社区插件集合。[用量看板](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-board) 可参考页面组织，[参数覆盖](https://github.com/magpie-community/plugins/tree/main/packages/param-override) 可参考中间件入口。 |
| [Lemonawa/magpie-usage-reporter](https://github.com/Lemonawa/magpie-usage-reporter) | 单向用量上报、重试和配置界面的社区实现。 |
| [lucklyduck/magpie-usage-reporter](https://github.com/lucklyduck/magpie-usage-reporter) | 用量报表、订阅、插件后端和 Webhook 示例。 |
