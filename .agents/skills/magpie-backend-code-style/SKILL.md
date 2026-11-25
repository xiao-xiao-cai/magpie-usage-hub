---
name: magpie-backend-code-style
description: >
  编写、重构或审查 Bun 后端 TypeScript 时使用，检查边界类型、字段映射、模块职责与诊断。纯页面修改不适用。
  Use when writing or reviewing Bun and TypeScript code. Do NOT use for page-only code or to decide public protocol changes.
allowed-tools: Read, Edit, Write, Glob, Bash
---

# 后端代码规范

## 默认规则

- 采用严格 TypeScript、ESM、UTF-8、LF 和两空格缩进。函数和变量用 `camelCase`，类型用 `PascalCase`。协议字段名在边界转换一次。
- HTTP JSON、Options 和磁盘状态以 `unknown` 接收。先校验形状、类型及值域，再以字段白名单构造内部对象。
- 可独立判断的映射与校验使用纯函数。文件、网络和计时器留在拥有相应资源的模块。单次读取已校验属性可就地处理。
- 在能够作出处理决定的位置分类错误。向日志或调用方输出受控类别、阶段、状态码或计数。原始错误和响应正文不得进入诊断。

## 工作流

1. 找到外部值首次进入业务代码的位置和最终消费者。配置解析接收原始 Options，输出带单位的内部配置，例如 `pollIntervalSec`。调度器只接收已校验的间隔，在调用计时器时转换为毫秒。配置解析器既不创建计时器，也不读取页面控件。
2. 在读取处先写 `const payload: unknown = await response.json()`。以已计价行的可选费用为例，调用方校验行结构和 `priced` 后，把字段交给下列函数。`maximum` 取自该接口已核实的上限。

   ```ts
   function readOptionalCost(value: unknown, maximum: number): number | undefined {
     if (value === undefined) return undefined
     if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
       throw new RangeError('invalid_cost')
     }
     return value
   }
   ```

3. 在组装上报对象的边界使用校验结果。下面是已校验 `priced` 标记之后的字段映射示例。验证最终生成的对象中是否有 `cost` 键，并覆盖普通数值和非法输入。

   ```ts
   function mapCost(priced: boolean, rawCost: unknown, maximum: number): { cost?: number } {
     const cost = priced ? readOptionalCost(rawCost, maximum) : undefined
     return cost === undefined ? {} : { cost }
   }
   ```

   这类有省略语义的规则可独立测试。已校验字段的一次直接赋值留在原处。HTTP 客户端负责解码和状态码，字段映射产生允许上报的对象，调度层决定受控错误是否重试。新增依赖时核对宿主 Bun 兼容性、安装脚本和项目锁文件。
4. 有已配置的类型检查命令时检查类型。有行为变化时，定向验证相关输入和输出对象。

## 输出格式

`代码位置 | 输入或调用方 | 预期返回值或错误类别 | 实际证据`。审查交付还应指出哪种输入会造成哪种后果。

## Gotchas

- `if (cost)` 会漏报已知零费用，`cost ?? 0` 会把未知费用计为零。组装输出时显式判断 `cost !== undefined`。
- `as` 不验证外部数据。Bun 能加载 `.ts` 也不能证明通过了静态类型检查。
