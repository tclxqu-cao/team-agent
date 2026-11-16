# VS Code Copilot 已有会话接入实施计划

用户已明确选择接入 VS Code 已有会话；早期独立 SDK 原型不作为本方案的实现或验收。

## 目标与边界

通过运行中的 VS Code Agent Host 接入原有 Copilot 会话。领域层只注册 Agent 身份和协作成员类型；AHP、socket、历史与审批转换由 native-runtime 适配现有端口。遵循项目 CLAUDE.md；docs/code-standards.md 当前不存在。保留共享工作树中的并行改动。

不提交、推送、发布、重启服务或修改项目 docs。真实发送验证使用同一 VS Code 宿主内的隔离会话；用户原有会话只读。

## 实施项

- [x] 注册 copilot Agent、Broker adapter、SDK 公共类型和共享界面图标。
- [x] 只读发现 VS Code / Insiders 的 owner-protected AHP 1.x 本地端点，跳过失效进程、旧协议和不安全元数据。
- [x] 使用官方 @microsoft/agent-host-protocol 1.0.0 与现有 ws 依赖；协议实现打入 native-runtime bundle。
- [x] 原生 session/chat URI、工作区、完整历史分页、工具、用量、模型和 pending input 映射。
- [x] 沿用 VS Code 的模型、自定义 Agent、工具客户端和权限；不接管 activeClient，不改原有配置。
- [x] 发送等待宿主 authoritative echo；steering、精确轮次取消、审批与多问题输入；不重试不确定的写入。
- [x] 区分外部 VS Code 轮次与 Broker 自己的运行，界面权限显示“跟随 VS Code”。
- [x] 移除独立 Copilot SDK、CLI 原生依赖、额外发行配置及其原型测试。

## 验证

- [x] 协议与界面聚焦测试 39/39 通过；新增原型会话、并发答题、未消费 steering 等边界已覆盖。
- [x] 扩大回归 1613 通过、0 失败、1 个原有 benchmark 跳过。
- [x] Core/native-runtime 构建，server/desktop main 类型检查，隔离 WebApp 生产构建通过。
- [x] 真机只读发现 3 个未归档的 VS Code Copilot 会话、34 个模型，读取当前项目历史。
- [x] 同一 VS Code 宿主内隔离会话：原生模型真实回复、跨连接续聊记忆、Shell 工具审批与结果、原生取消通过；验证会话已归档。
- [x] DDD 和 diff 自查；token 不进入日志/持久化；历史经验写 wiki。

完整 desktop renderer 类型检查仍为 134 项既有/并行改动问题，未扩大范围修复。Windows named-pipe 路径已有实现，未做 Windows 实机验收；未做完整安装包或手机实机验收。Copilot 当前原生推理强度沿用 VS Code 配置，不从 AgentRoam 单独改写。

证据：/Users/caoqu/.codex/artifacts/agentroam-vscode-copilot-20261103/。
