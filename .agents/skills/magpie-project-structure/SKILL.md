---
name: magpie-project-structure
description: >
  在 Magpie Usage Hub 新增、移动文件或审查项目目录布局时使用，按文件用途和读取方确定位置，并检查受路径变更影响的入口。仅修改已有文件的逻辑、样式或措辞时跳过。
  Use when placing new files, moving files, or reviewing the repository layout. Do NOT use for edits to existing logic, CSS, or wording that leave paths unchanged.
allowed-tools: Read, Edit, Write, Glob, Bash
---

# 项目目录结构规范

## 默认规则

1. 先确定文件由谁加载。对浏览器资源，再区分是 Magpie 从包内加载的页面，还是 Bun 通过 HTTP 提供的页面。用 `git ls-files` 查仓库已有路径，沿用所属模块的命名。
2. 表中的源码和测试目录是首版实现约定。第一个实际文件落地时再创建对应目录。局部开发只处理本次新增或移动的路径。
3. 审查目录时，指出具体的当前路径、目标位置和读取方。路径移动后，完成下方与该文件相关的检查。

## 文件归位表

| 文件用途 | 位置与放置规则 |
| --- | --- |
| 项目说明、仓库配置 | 根目录放 `README.md`、`AGENTS.md`、`.gitmessage`、`.gitignore`、`.gitattributes`、`.editorconfig` 等仓库级文件。 |
| 插件清单与宿主入口 | 实现插件时，`package.json`、`tsconfig.json`、Bun 锁文件 `bun.lock` 放在根目录。根 `server.ts` 导出宿主入口，由 `exports["./server"]` 指向 `./server.ts`。具体后台行为放 `src/`。 |
| Bun 后端源码 | `src/gateway/` 放源端读取、中心上报及 HTTP 回执解码。`src/sync/` 放行映射、轮询、批次确认和游标推进判断。`src/state/` 放身份、进度和锁的持久化代码。配置解析和诊断服务端代码按职责放在 `src/`。 |
| Magpie 宿主页面 | `magpie.page.file` 指向 `page/index.html`。此页及其 JS、样式、图像放在 `page/`。等待 `magpie.ready` 后可读写普通 Options。Web 有 `magpie.service` 时导航到该服务入口，桌面端入口为空时仍在本页提供配置。 |
| Web 诊断服务页面 | 第一份诊断页面落地时创建 `ui/`。由 Bun 提供的 HTML、JS、CSS 和图像放在这里。页面通过同源相对 API 读取最近同步状态、分页、退避和阻塞原因。提供资源和处理 API 请求的 TypeScript 放在 `src/`。 |
| 测试及合成数据 | 单个函数或控件的测试放 `tests/unit/`，跨模块、模拟 HTTP 或临时文件测试放 `tests/integration/`，实际 Magpie 宿主验收用例放 `tests/host/`。可提交的合成回执等夹具放 `tests/fixtures/`。 |
| 开发文档与脚本 | 功能规格、设计、验收和开发指南放 `docs/`。面向整个仓库的维护脚本放 `scripts/`，例如供本地和 CI 共用的打包脚本。 |
| 本地执行计划 | 单次任务的实施步骤、待办和进度记录放在仓库根目录的 `plan/`，由 Git 忽略。需要随项目长期维护的设计结论和验收标准写入 `docs/`。 |
| 项目 Skill | 入口为 `.agents/skills/<技能名>/SKILL.md`。某个 Skill 专用的脚本、按需规则、模板分别放在该 Skill 自己的 `scripts/`、`references/`、`assets/` 中。 |
| GitHub 配置 | Actions 工作流放 `.github/workflows/`，PR 模板放 `.github/pull_request_template.md`，Issue 模板及其 `config.yml` 放 `.github/ISSUE_TEMPLATE/`。 |
| 运行数据与本地产物 | 真实 `identity.json`、`state.json` 和进程锁由 Bun 写入 `input.directory` 下的插件专用状态目录。上报凭据保存在 `centralKeyFile` 指向的受保护文件。仓库内隔离调试数据放已忽略的 `.magpie-dev/`，构建输出和覆盖率报告分别放 `dist/`、`coverage/`。 |

## 移动文件检查

- 移动前搜索旧路径，并查找相对导入、清单项、HTML 资源引用、工作流命令或 Markdown 链接。例如从仓库根运行 `git grep -n -F -- 'page/index.html'` 可找到已跟踪文件中使用该字面路径的位置。对相对路径另按文件名查找调用方。
- 移动后从读取方所在位置解析新路径。移动 `page/` 资源时核对 `magpie.page.file` 和页面相对引用。移动 `ui/` 资源时核对 Bun 的静态文件映射和诊断页的相对请求。涉及测试夹具时，从消费它的用例读取一次。涉及文档时，检查引用该文件的文档链接。按[分级测试规范](../magpie-testing/SKILL.md)选择能证明这次移动正确的最小检查。
- 已有可打包的插件，且本次新增或移动运行文件时，在包根运行 `npm pack --dry-run --ignore-scripts --json`。逐项核对输出的 `files[].path` 是否包含 `server.ts`、它直接或间接导入的 `src/` 模块、`page/` 的入口与引用资源，以及已实现的 `ui/` 服务页与引用资源。缺项时调整 `package.json` 的 `files` 范围并重查。
- 汇报格式为 `文件用途 | 目标路径 | 受影响的入口或引用 | 已验证结果`。仅提供选址建议时，说明选址依据即可。

## Gotchas

- 判断回执代码的位置时，看它解决的问题。解析中心响应属于 `src/gateway/`，判断整页能否确认属于 `src/sync/`，测试用的回执样本属于 `tests/fixtures/`。
- `src/state/` 中提交的是持久化实现，真实游标、锁和凭据留在运行环境。需要复现问题时，重新构造合成夹具。
- CI 调用某个 Skill 的专用脚本时，脚本仍随该 Skill 维护。例如本地链接检查器归 `magpie-docs-update`，移动它时须同步检查调用它的工作流。
