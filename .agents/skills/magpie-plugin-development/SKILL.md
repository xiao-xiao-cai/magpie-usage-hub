---
name: magpie-plugin-development
description: >
  修改清单、Options、页面桥、Bun 宿主生命周期或安装包时使用，按目标 Magpie 版本核验接入点。纯业务逻辑与发布操作不适用。
  Use when integrating a Magpie host capability or verifying an installable plugin. Do NOT use for a local mapping fix, CSS change, or release publication.
allowed-tools: Read, Edit, Write, Glob, Bash
---

# 插件接入规范

## 默认规则

- 先确定目标版本、运行形态和需要的公开能力。核对目标版本的官方文档及对应标签源码。两者有分歧时，选择能区分它们的隔离操作并记录观察值。
- 按资源选择入口。普通设置用 Options，静态页面用 `magpie.page.file`，后台 I/O 用 Bun 入口，需要 Web 回环服务时才声明 `magpie.page.service`。
- 区分包内资源、插件状态目录和受保护的凭据文件。普通选项只保存凭据文件位置，页面只显示是否配置。涉及新增采集范围、公开接口或部署架构时先确认。

## 工作流

1. 能运行目标环境时，用 `magpie --version` 读取实际版本；只能核对源码时记录对应标签。将验证对象缩小到清单字段、入口签名、页面桥或候选安装包。
2. 后台包用下列清单片段声明入口。核对默认导出的 `{ id, server }`、`server(input, options)` 和实际包内路径。从 `input.directory` 派生状态子目录，以 `import.meta.url` 定位包内资源，用校验后的 Options 取得实际网关地址。

   ```json
   { "exports": { "./server": "./server.ts" } }
   ```

3. 修改 Options 时查目标版本的桥接写入实现和宿主加载入口，核实写入是合并还是替换、什么时候通知或重载 Bun。用隔离配置和两个可区分的有效值观察下表中的结果。打包改动则从实际候选产物隔离试装，检查后端、页面和有安装脚本要求的依赖。

   | 以保存 `pollIntervalSec` 为例 | 可以得出的结论 |
   | --- | --- |
   | 桥写入后重新打开配置页，从 Options 读回，间隔与提交值一致，其他普通设置保留 | 配置重新加载后仍可读回本次保存的值。 |
   | 观察该形态的配置通知或宿主重载，确认运行任务取得的新值 | 已确定配置在何时交给 Bun。 |
   | 在中心可用、轮询未退避的隔离场景中，观察该任务按新间隔安排后续轮询，且没有旧任务并行发送 | 可以对这个版本和形态报告调度已生效。仅有配置读回证据时，将此项列为待验。 |
4. 涉及 CLI/Web/桌面的行为差异、页面服务或宿主重载时，读取[运行形态规则](references/host-modes.md)。由[分级测试规范](../magpie-testing/SKILL.md)选择取得相应证据的最小环境。实际节点上的安装、配置或写入须在本次授权内。

## 输出格式

`目标版本 | 接入点 | 源码核对或实际形态 | 操作与观察结果 | 待验形态`。证据只覆盖观察到的入口和形态。

## Gotchas

- `input.serverUrl` 不能充当已配置的网关地址。宿主输入与业务配置要分别验证。
- 本地目录可加载不能证明安装包齐全。安装包验收必须使用候选产物内的模块和资源。
