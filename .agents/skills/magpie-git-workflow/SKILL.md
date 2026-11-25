---
name: magpie-git-workflow
description: >
  操作项目分支、暂存、提交、历史或远端时使用，按路径或片段保护已有工作。普通文件编辑和首发审核不适用。
  Use when staging, committing or performing a branch, history or remote operation. Do NOT use for ordinary edits or release readiness review.
allowed-tools: Read, Bash
---

# Git 操作规范

## 默认规则

- 先确定本次 Git 操作、目标和授权。日常开发沿用合适的当前分支，需要隔离时才建本地分支。空历史按项目约定在 `main` 建立基线。
- 必须保护操作前的工作区和暂存区，只纳入本次归属明确的内容。凭据、真实用量、状态、本地配置和生成包不得进入提交或输出。
- 推送、远端 PR、可见性和发布须确认具体目标与范围。可能丢失修改或改写历史时，先确认影响范围。

## 工作流

1. 在仓库中用 Git 只列名称，识别敏感文件后再对适合审查的候选路径查看补丁。

   ```sh
   git status --short --branch --untracked-files=all
   git diff --name-status
   git diff --cached --name-status
   ```

2. 独占文件且索引内容均属本次时，用 `git add -- <本次路径>` 明确暂存范围，核对实际暂存差异，运行 `git diff --cached --check`。索引已有其他工作或同一文件混有多项修改时，先读取[混合索引规则](references/mixed-index.md)。
3. 比对将提交的内容与验证时的工作区。按索引提交时，对已确认可读的相关路径查看 `git diff --cached -- <路径>`，并用 `git diff -- <路径>` 查找被留在工作区的依赖。按路径提交时以该路径的整个工作区版本为准。漏掉的解析器、消费方、测试或夹具若会改变结论，在隔离的候选内容上做对应级别的检查，或明确标出待验。只有无关差异时沿用原证据。用 Conventional Commits 按实际候选内容拟定标题。
4. 提交后用 `git show --stat --oneline HEAD` 核对哈希与文件，用 `git show HEAD -- <本次路径>` 核对实际片段。再检查操作前记录的暂存和未暂存修改，含钩子产生的变化。

## 输出格式

`实际操作与目标 | 产生的提交或远端结果 | 纳入范围 | 剩余工作区及暂存状态`。若目标是提交，核对实际哈希后才报告完成。

## Gotchas

- 普通 `git commit` 会带上整个索引。只在确认所有暂存内容归属本次后使用。
- `.gitignore` 无法清除已经进入历史的敏感内容。发现后停止相关外发，按授权处理。
