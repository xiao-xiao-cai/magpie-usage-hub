---
name: magpie-frontend-code-style
description: >
  编写、重构或审查插件页 HTML、CSS、JavaScript 时使用，检查控件语义、主题、焦点、事件和展示字段。纯宿主修改不适用。
  Use when writing or reviewing native plugin UI code, including local CSS fixes. Do NOT use for Bun-only changes.
allowed-tools: Read, Edit, Write, Glob, Bash
---

# 前端代码规范

## 默认规则

- 从变更控件找到关联的 HTML、CSS 和事件处理函数。使用包内外部脚本，遵守项目 UTF-8、LF、两空格缩进约定。
- 表单动作使用 `submit`，其他动作用 `button type="button"`，导航用带 `href` 的链接。输入控件必须有可见标签，键盘操作必须有可见焦点。
- 复用 `--magpie-*` 主题变量。选择器限制在受影响的控件。失败、阻塞和禁用状态必须能通过文字或控件语义识别。
- 视觉与数字格式以 [Magpie 前端风格设计指南](../../../docs/magpie前端风格设计指南.md) 为准：卡片与 KPI 查 §4，字号查 §5，`1.2M`/`万`/`¥0.125`/`—` 等格式查 §6，符号查 §7，验收清单查 §12。可复制骨架见 [附 CSS 速查](../../../docs/magpie前端风格设计指南-附CSS速查.css)。本 Skill 的规则管正确性与安全，指南管视觉一致性，冲突时以本 Skill 为准并同步修指南。
- 只渲染宿主已脱敏且此处需要的字段。动态文本写入 `textContent`，为错误类别选择固定提示。禁止把原始异常、请求正文或凭据写入页面或控制台。

## 工作流

1. 按控件的职责定位改动。HTML 定义标签、单位、提交与反馈区域，CSS 定义主题和交互状态，JavaScript 读取控件、调用页面能力并更新结果。可以同处一个页面目录，文件如何拆分取决于现有页面。
2. 将事件绑定放在初始化阶段。表单只绑定一次 `submit`，让点击按钮和按 Enter 走同一处理函数。读取数值型控件用 `valueAsNumber`，只有通过有限性及配置范围校验后才交给保存逻辑。刷新时只更新受影响的节点，保留焦点和未提交值。
3. 用合成诊断检查显示边界。下例假设宿主已生成允许展示的目的地标签，提示区域已声明 `role="status"`。

   ```js
   destinationElement.textContent = diagnostic.destinationLabel
   statusElement.textContent = diagnostic.errorKind === 'timeout'
     ? '连接超时，请重试。'
     : '暂时无法读取状态。'
   ```

4. 改样式时用 Tab 到达控件并观察实际焦点。审查时指出可复现的不良结果。只要求审查时以审查意见交付。

例如为轮询间隔添加表单时，先让 HTML 表达字段、单位和动作。以下只示范控件语义，字段的有效范围取自已确认的配置约定。

```html
<form id="poll-settings">
  <label for="poll-interval">轮询间隔（秒）</label>
  <input id="poll-interval" name="pollIntervalSec" type="number" step="any" required>
  <button type="submit">保存</button>
  <p role="status"></p>
</form>
```

## 输出格式

`控件及状态 | 代码变更或审查发现 | 操作与观察结果`。视觉结论需有对应主题和状态的观察结果。

## Gotchas

- `element.innerHTML = error.message` 同时引入 HTML 解析和异常泄露。`console.error(error)` 仍会输出原始异常。替换为受控类别和固定提示。
- `textContent` 不会替你脱敏。目的地显示标签应在宿主侧构造，不能用带账号或查询参数的完整 URL 代替。
- 重建整个表单会丢失焦点。更改状态文案时只更新状态节点。
- `Number('')` 会得到 `0`。清空输入后，保存处理应提示用户补全字段，不得写入由空串转换的数值。
