# Copilot 审批、插入消息与重复轨迹修复

> 由主 Agent 在本会话直接完成，不委派子 Agent。用户已确认修复上一轮定位的两处问题，并要求检查 Copilot 重复显示。

目标：原地球会话恢复后能看到待确认权限；待插入消息不提前消失、不覆盖已有插入；实时流与原生历史保持同一消息身份。

约束：保留共享工作树已有改动；不提交、不修改项目 docs、不代替用户批准原任务命令。当前 CLAUDE.md 已读取，docs/code-standards.md 不存在。

- [x] 将 Copilot 未决审批纳入 Broker 与 UnifiedSessionService 最新历史分页；原生审批快照覆盖旧 run 的过期审批；恢复后的卡片直接路由到原生答复。
- [x] Copilot steer 使用队列项的稳定 ID，等待服务端消费事件后才完成；审批等待时明确提示并保留队列，已有待插入消息时拒绝覆盖。
- [x] 已消费的队列输入通过现有 receipt 与 goal history 持久保存，在原轮次后恢复；原生待消费 steering 也可从历史快照恢复。
- [x] 为 Copilot 实时文本、思考和工具调用使用与历史一致的 turn/part ID，分页通过 nativeMessageId 保留原生身份；不同 ID 的相同文字保留。
- [x] 补充审批分页、消费确认、拒绝/取消、并发、刷新恢复和重复轨迹回归；255 项通过，真实地球流与历史连续合并 3 次仍只有 7 个唯一气泡、2 个工具、1 张审批卡和 1 条待插入输入。
- [x] core/native-runtime/webapp/server 隔离构建通过，修复已在 :3000 运行。网关重启产生的旧 interrupted 事件及 footer 不再覆盖 Copilot 原生状态。
- [ ] 浏览器页面验收：ego-browser space 83 被通知权限弹窗交给用户控制，已请求用户处理，不能绕过或在未确认前恢复浏览器。接口与 renderer 真实数据回放已完成；未做手机实机验收。
- [x] wiki-capture 记录实施内容、验证结果及上线边界。

交付证据：`/Users/caoqu/.codex/artifacts/agentroam-copilot-fix-20261104-080217/`；最终运行源码为 `source-reconnect`，build `cpV_ffOkGP56gOgnSiW2B`，PID 37987。webapp typecheck 的 6 项错误与原运行版本完全一致，本次未新增。

验证：Node 22 下运行相关 Vitest 文件；构建 core、native-runtime、webapp 和 server；浏览器读取地球会话，检查唯一审批卡、唯一原生轨迹和待插入输入。不以健康接口代替原问题验收。
