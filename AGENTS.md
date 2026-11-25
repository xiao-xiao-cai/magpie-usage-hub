# Magpie Usage Hub 开发约定

## 项目概览

Magpie Usage Hub 将多个源实例的网关用量汇总到一个中心 Magpie。源端插件在 Magpie 管理的 Bun 宿主中后台运行，中心原生账本统一保存本地调用与上报记录，并为用量页面和业务查询提供数据。

仓库当前处于设计阶段。`README.md` 面向项目读者，`docs/` 按功能、架构、接口、恢复、配置、部署和验收组织开发参考。Magpie `v0.1.4783` 是接口核对基线。实现或升级时，以实际目标版本的公开接口和源码为准。

## 功能开发

- 用量采集与上报使用 Magpie 的公开网关接口，后台发送与模型请求保持独立。按功能规格确定本次开发范围，再对照网关接口与用量数据规范和目标版本核验涉及的协议行为。

## 操作边界

### Always

- 分开配置上报、查询和管理凭据。业务使用专用只读 Key。将上报 Key 放在受保护的凭据文件中，通过 `Authorization: Bearer` 请求头发送。使用 HTTPS 时校验 TLS 证书，对外展示脱敏诊断，示例和测试夹具使用合成数据。
- 在插件专用状态目录保存配置、来源身份、同步进度和互斥信息。插件页负责配置与诊断，后台调度由 Bun 宿主持有。
- 本地可按任务需要建分支、暂存和提交本次改动。保留已有工作区和暂存内容，提交前审查实际纳入的文件。

### Ask First

- 变更采集范围、公开接口或部署架构前，向用户确认。已有进度时切换中心或调整回填范围，先确认新目标和历史边界。
- 在真实节点安装或启动插件、修改配置或执行写入测试前，确认操作已获本次任务授权。
- 推送、调整远端可见性、创建远端 PR、发布版本，以及可能丢失改动或改写历史的 Git 操作，须先确认具体操作和范围。

### Never

- ❌ 禁止在上报正文、页面或日志中暴露凭据、账号标识、会话 ID、模型请求与响应正文或原始错误文本。禁止向重定向目标转发上报凭据。
- ❌ 禁止把原生账本文件作为插件的采集接口，或由发送插件直接修改两端账本。插件通过原生网关 API 读写用量。

## 开发与验证

- 本地调试按开发指南创建独立 Magpie 配置和回环端口，加载本地插件目录。用 `magpie --version` 核对环境。使用 `magpie plugin list --json` 检查加载结果时，注意该命令可能启动临时 Bun 宿主。
- 按受影响的行为选择 L0 静态检查、L1 定向验证、L2 模块集成或 L3 隔离宿主验收。可以直接选择需要的级别。当前结果能够证明预期行为及相关失败条件时即可结束。全量回归的适用条件见分级测试 Skill。
- 采集改动按涉及的边界选择合成行、模拟 HTTP 或临时状态验证。依赖真实宿主生命周期时使用隔离实例。跨网关入账验收使用两套隔离 Magpie，按目标核对 `through` 与 `reported`、只读权限或断网补传。无人值守支持须验证页面关闭、重载及休眠恢复。记录版本、实际场景和待验证项。
- 开发功能或修复用户可见行为时，按文档更新 Skill 检查文档影响，并在同一任务内补充对应说明。

## 项目 Skills

审查已有代码只选对应端的代码规范。实现功能或修复行为时，再选该端的开发规范。只有修改跨到另一端的接口或消费逻辑时，才加入另一端的规范。决定验证范围时统一查分级测试。

例如修改轮询间隔时，页面保存与读回归前端开发，配置解析与任务调度归后端开发。要判断保存后何时通知或重载 Bun，查插件接入规范。改回执时，后端开发负责进度提交条件，分级测试负责选择能观察重放结果的最小环境。

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
- 核对采集范围、字段、回执和进度提交条件。[网关接口与用量数据规范](docs/04-网关接口与用量数据规范.md) · [同步与故障恢复](docs/05-同步流程与故障恢复设计.md)
- 开发配置页或接入实际部署。[配置与诊断页面设计](docs/06-配置与诊断页面设计.md) · [部署接入与运行维护](docs/07-部署接入与运行维护.md)
- 查开发顺序、不同运行形态的已有证据和待验项。[开发阶段与验收计划](docs/08-开发阶段与验收计划.md)
- 查插件入口、Windows 隔离环境、本地调试和分发。[Magpie 插件开发指南](docs/Magpie插件开发指南.md)
- 查首次公开前的许可、历史和发布范围。[GitHub 首次开源准备](docs/GitHub开源准备.md)
