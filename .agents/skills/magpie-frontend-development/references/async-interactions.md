# 连续刷新与重复提交

**读取条件**：同一页面允许请求重叠或允许在上一次写入结束前再次提交。

1. 读请求可以取消时中止上一次请求。若不能保证取消成功，用请求序号控制结果、错误和忙碌状态的更新权。在每个会更新 UI 的异步分支做同样的检查。

   ```js
   let latestRefresh = 0

   async function refresh() {
     const sequence = ++latestRefresh
     showLoading()
     try {
       const status = await readStatus()
       if (sequence === latestRefresh) showStatus(status)
     } catch {
       if (sequence === latestRefresh) showReadFailure()
     } finally {
       if (sequence === latestRefresh) finishLoading()
     }
   }
   ```

2. 写入操作统一从 `submit` 进入。同步设置提交中标记，拦住第二次提交，待当前请求结束再恢复控件。失败时保留表单值。若允许请求期间继续编辑，旧的保存结果不得覆盖新输入。
3. 验证两个请求倒序完成、旧请求迟到失败、连续提交两次。分别断言页面保留最新结果、忙碌状态正确、写入次数为一。只执行本次操作可触发的分支。
