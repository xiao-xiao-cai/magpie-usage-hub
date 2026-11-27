# Magpie Usage Hub 开发约定

## 项目概览

Magpie Usage Hub 在中心 Magpie 的 Web 看板按来源展示原生网关用量。中心插件在 Magpie 管理的 Bun 宿主中读取容器回环和管理员登记的来源网关。远程来源使用各自原生网关签发的专用只读 Key。

`0.5.0` 是中心只读拉取候选版本。管理员在中心插件配置启停和回环网关地址，再从看板的「来源管理」测试并保存远程来源。原生接口源码基线为 Magpie `v0.1.4874`，Windows 和 Docker 原生回环预检使用 `v0.1.4799`。实现或升级时，以目标版本的公开接口和实际验收为准。[部署接入](docs/07-部署接入与运行维护.md) · [验收记录](docs/08-开发阶段与验收计划.md)

## 功能开发

- 用量查询使用 Magpie 公开网关接口。修改周期、字段或映射时，核对 `computer=this`、`through` 与 `direct` 分项、源实例的周期起点和失败来源的隔离。[原生网关查询](docs/04-网关接口与用量数据规范.md#原生网关查询)
- 配置页通过原生 Options 保存中心设置，Web 页面通过 Magpie 页面服务代理读取用量和脱敏状态。修改交接时，分别核对保存读回、宿主读取和持锁宿主采用的修订。[配置与诊断](docs/06-配置与诊断页面设计.md)
- 修改来源管理时，核对来源 ID、地址与 Key 的绑定、并发修订、原子落盘和重载后的读回。连接测试使用已提交或显式输入的地址与对应 Key。[看板与管理接口](docs/04-网关接口与用量数据规范.md#看板与管理接口)

## 操作边界

### Always

- 分开配置查询和管理凭据。远程用量使用专用只读 Key，保存在中心受保护的 `pull/sources.json`，仅通过 `Authorization: Bearer` 请求头发送给登记的来源。使用 HTTPS 时校验证书，对外展示脱敏诊断，示例和测试夹具使用合成数据。
- 在插件专用状态目录保存来源配置、身份和互斥信息。插件页负责配置、看板和诊断，读取和写入由持锁 Bun 宿主持有。
- 本地可按任务需要建分支、暂存和提交本次改动。保留已有工作区和暂存内容，提交前审查实际纳入的文件。

### Ask First

- 变更采集范围、公开接口或部署架构前，向用户确认。切换旧版部署前核对备份、维护窗口及回退范围。
- 在真实节点安装或启动插件、修改配置或执行写入测试前，确认操作已获本次任务授权。
- 推送、调整远端可见性、创建远端 PR、发布版本，以及可能丢失改动或改写历史的 Git 操作，须先确认具体操作和范围。

### Never

- ❌ 禁止在页面响应或日志中暴露来源凭据、账号标识、会话 ID、模型请求与响应正文或原始错误文本。禁止向重定向目标转发来源凭据。
- ❌ 禁止把原生账本文件作为插件的采集接口，或直接改动原生账本。插件通过原生网关 API 读取用量。

## 开发与验证

- 批量新增、移动或删除源码文件，拆分或合并模块，或重构跨模块接口与调用关系后，在仓库根目录运行 `codegraph index .` 重建索引。分阶段重构时，每完成一轮结构调整就刷新一次，再用 CodeGraph 分析下一步。运行 `codegraph status .` 确认索引为最新后，再依据查询结果判断影响范围。
- 本地调试按开发指南创建独立 Magpie 配置和回环端口，加载本地插件目录。用 `magpie --version` 核对环境。使用 `magpie plugin list --json` 检查加载结果时，注意该命令可能启动临时 Bun 宿主。
- 按受影响的行为选择 L0 静态检查、L1 定向验证、L2 模块集成或 L3 隔离宿主验收。可以直接选择需要的级别。当前结果能够证明预期行为及相关失败条件时即可结束。全量回归的适用条件见分级测试 Skill。
- 用量改动按涉及的边界选择合成响应、模拟 HTTP 或临时状态验证。依赖宿主生命周期时使用隔离实例。现有 Windows 与 Docker 验收按维护窗口核对来访地址、只读权限、逐来源原生统计、断线恢复以及宿主重载。分别记录实际版本、场景和待验证项。
- 开发功能或修复用户可见行为时，按文档更新 Skill 检查文档影响，并在同一任务内补充对应说明。

## 项目 Skills

审查已有代码只选对应端的代码规范。实现功能或修复行为时，再选该端的开发规范。只有修改跨到另一端的接口或消费逻辑时，才加入另一端的规范。决定验证范围时统一查分级测试。

例如修改查询超时时，页面保存与读回归前端开发，配置解析与 HTTP 超时归后端开发。要判断保存后何时重载 Bun，查插件接入规范。修改配置保存时，由分级测试选择能观察修订冲突和写入失败的最小环境。

| 任务 | Skill |
| --- | --- |
| 编写或审查插件页 HTML、CSS、JavaScript，调整按钮样式或焦点 | [magpie-frontend-code-style](.agents/skills/magpie-frontend-code-style/SKILL.md) |
| 编写或审查 Bun 后端 TypeScript、字段映射和错误处理 | [magpie-backend-code-style](.agents/skills/magpie-backend-code-style/SKILL.md) |
| 开发配置页、诊断页，调整页面的数据读取、保存或恢复流程 | [magpie-frontend-development](.agents/skills/magpie-frontend-development/SKILL.md) |
| 修改后台行为，追踪调用方、状态、重试或任务生命周期 | [magpie-backend-development](.agents/skills/magpie-backend-development/SKILL.md) |
| 修改宿主入口、插件 Options、页面桥或安装包 | [magpie-plugin-development](.agents/skills/magpie-plugin-development/SKILL.md) |
| 选择 L0–L3 验证级别，判断扩大范围或停止的条件 | [magpie-testing](.agents/skills/magpie-testing/SKILL.md) |
| 操作本地分支、暂存、提交或远端 Git | [magpie-git-workflow](.agents/skills/magpie-git-workflow/SKILL.md) |
| 编辑 README、项目说明，或随功能、接口、配置和验证变化更新文档 | [magpie-docs-update](.agents/skills/magpie-docs-update/SKILL.md) |

## 文档入口

- 确定首版范围、目标版本与模块职责。[功能规格与索引](docs/01-插件定位与功能规格.md) · [开发基线与兼容性](docs/02-开发基线与兼容性.md) · [整体架构](docs/03-整体架构与模块职责.md)
- 核对查询范围、字段、修订和失败后的恢复。[网关接口与用量数据规范](docs/04-网关接口与用量数据规范.md) · [故障恢复](docs/05-同步流程与故障恢复设计.md)
- 开发配置页或接入实际部署。[配置与诊断页面设计](docs/06-配置与诊断页面设计.md) · [部署接入与运行维护](docs/07-部署接入与运行维护.md)
- 查开发顺序、不同运行形态的已有证据和待验项。[开发阶段与验收计划](docs/08-开发阶段与验收计划.md)
- 查插件入口、Windows 隔离环境、本地调试和分发。[Magpie 插件开发指南](docs/Magpie插件开发指南.md)
- 查首次公开前的许可、历史和发布范围。[GitHub 首次开源准备](docs/GitHub开源准备.md)
