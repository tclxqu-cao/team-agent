# 桌面直播按观看者唤醒屏幕设计

- 日期：2026-09-25
- 状态：已确认（用户批准：最后一个 WebApp 观看者退出后立即释放常亮）
- 基线：`7e6545d`
- 关联：`2026-09-09-desktop-live-design.md`

## 1. 背景与目标

桌面端当前把“桌面直播功能已开启”直接等同于“屏幕必须常亮”。持久状态
`desktop-live.json` 为 `enabled: true` 时，App 启动即调用
`powerSaveBlocker.start("prevent-display-sleep")`，即使没有 WebApp 观看者也会持续阻止显示器休眠。

目标是拆开两个生命周期：

- 桌面直播开关继续控制桌面画面源是否发布，保证 WebApp 能发现并点击它。
- 屏幕唤醒与常亮只由实际观看者驱动。
- 最后一个观看者退出、断线或切换会话后立即释放常亮，恢复系统正常显示器休眠策略。

非目标：修改 CLI 的 `caffeinate -i` 系统睡眠策略、修改 `browser:*` 传输协议、处理
AgentRoam 之外进程持有的显示器断言、改变远程控制权状态机。

## 2. 方案选择

采用服务端现有 `viewerCount` 作为权威观看状态。

`browser:watch` / `browser:unwatch` 已维护 `LiveViewRegistry.watchers`，并通过
`browser:state` 把 `viewerCount` 广播给同一用户的 producer。该信号覆盖只读观看、JPEG 降级、
WebRTC 控制、多观看者、主动关闭和连接断开。

不采用以下方案：

- WebRTC `start` / `stop`：只覆盖取得控制权后的实时视频，遗漏只读观看与 JPEG 降级。
- 新增唤醒 RPC：与现有 watch 生命周期重复，并增加客户端漏发关闭请求导致断言泄漏的风险。

## 3. 生命周期设计

`DesktopScreenLive` 记录最近一次有效 `viewerCount`，并只在跨越零边界时操作
`DisplayKeepAwake`：

1. `enable()` 完成权限检查、输入 helper 启动和 producer 发布，但不再唤醒或保持屏幕。
2. 收到本桌面会话的 `browser:state` 且 `viewerCount > 0`：从 0 变为正数时调用
   `keepAwake.start()`，由 macOS `caffeinate -u` 点亮显示器并申请 `prevent-display-sleep`。
3. `viewerCount` 在正数之间变化：不重复申请或释放，支持多个观看者。
4. `viewerCount` 变为 0：立即调用 `keepAwake.stop()`。
5. `disable()`、App 退出或 producer 连接结束：无条件把观看数归零并释放断言。

缺少、非数字、负数或非本会话的 `viewerCount` 不改变当前断言状态。启用状态与观看状态保持独立：
`enabled: true` 仍会跨 App 重启恢复发布，但不会自行点亮屏幕。

## 4. 数据流

```text
WebApp 打开直播面板
  -> browser:watch
  -> LiveViewRegistry.watchers.add(peer)
  -> browser:state { session.viewerCount: 1 }
  -> DesktopScreenLive
  -> DisplayKeepAwake.start()

WebApp 关闭面板 / 切换会话 / 连接断开
  -> browser:unwatch 或 registry disconnect cleanup
  -> LiveViewRegistry.watchers.delete(peer)
  -> browser:state { session.viewerCount: 0 }
  -> DesktopScreenLive
  -> DisplayKeepAwake.stop()
```

WebRTC 仍只负责媒体协商，不承担电源生命周期。这样 WebRTC 失败回退 JPEG 时不会误释放屏幕。

## 5. 错误与恢复

- producer WebSocket 断开时立即释放常亮，因为此时无法继续向 WebApp 提供桌面画面。
- producer 重连后从零观看者状态重新开始；新的 `browser:watch` 再次触发唤醒。
- `DisplayKeepAwake.start()` / `stop()` 保持幂等，重复状态广播不会创建多个 blocker。
- 屏幕录制权限不足时 producer 不可用，也不申请常亮。
- 其它进程的 `NoDisplaySleepAssertion` 不属于本功能；验收按 assertion owner 区分。

## 6. 修改范围

- `packages/desktop/main/desktop-screen-live.ts`
  - 从 `enable()` 移除常亮申请。
  - 消费 `browser:state.session.viewerCount` 并处理零边界。
  - 在 disable、连接结束路径强制释放。
- `packages/desktop/main/desktop-screen-live.test.ts`
  - 更新原有 enable/disable 断言。
  - 增加首个观看者、多观看者、最后一个观看者、异常计数和断线清理测试。

不修改 core、server、WebApp 协议和 UI；现有 `viewerCount` 已满足需求。

## 7. 验收标准

1. 桌面直播开关开启、无 WebApp 观看时，AgentRoam Electron PID 不持有
   `NoDisplaySleepAssertion`。
2. WebApp 打开并选中桌面直播后，显示器被唤醒，AgentRoam Electron PID 出现该断言。
3. 最后一个 WebApp 关闭直播面板后，断言立即消失。
4. 两个观看者同时存在时，任一方退出不释放；最后一方退出才释放。
5. WebRTC 失败并降级到 JPEG 时仍保持常亮。
6. CLI 的 `PreventUserIdleSystemSleep` 行为不变。
7. 聚焦单测、Desktop TypeScript 编译和 `git diff --check` 通过；重启桌面端后用
   `pmset -g assertions` 完成真机验证。

