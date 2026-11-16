# 消息接入项目关联和模型原生预算修复

> Main agent implements directly; no implementation or review subagents.

**Goal:** 修复选项目后 Codex 创建失败，以及固定预算截断和内部错误回传。

**Design:** 本地项目 ID 只保留为 AgentRoam 关联，在服务边界与原生项目 ID 区分。消息模型使用内部的原生输出预算语义，不增加设置项，不写模型 ID/容量表；支持省略上限的接口交由上游决定，必填上限从模型元数据获取。技术错误保存在控制台，业务待确认与任务真实终态的回传保留。

## Implementation

- [x] NativeRuntimeService.create 识别本地项目 ID，在调用 Codex 前移除，在返回摘要和 pending 记录中保留本地关联；原生项目 ID 仍正常转发。
- [x] 消息识别、路由和回复移除固定 token 与输出字符预算；provider 支持沿用模型原生上限。
- [x] 模型技术异常向上保留，控制台可见；识别或派发准备异常不创建外发消息。
- [x] 自动产生的待确认和失败通知不作为普通本人聊天参与后续识别。
- [x] 针对真实 ID、原生模型参数、识别失败、手动选择、错误外发和历史上下文补回归。
- [x] 运行相关测试、类型检查和构建验证；不重放真实消息或发送企微测试。
- [x] 记录修改、验证及部署边界，沉淀 wiki。

## Verification

- 18 个测试文件、248 项测试通过；core 类型检查、core/messaging 构建、server 类型检查通过。
- WebApp 构建通过，输出隔离在 `/tmp/agentroam-messaging-fixes-web-build-20261105`，没有覆盖服务前端。
- WebApp 全量类型检查仍有 6 处错误：4 处缺失 better-sqlite3 声明、2 处 client-error-reporter 可空值；对应源码无本轮改动，本轮未扩展修改范围。
- 当前所选模型 openai/group/free-model 的真实最小请求通过，响应标记匹配，2750ms；发出的请求无 max_tokens 或 max_completion_tokens。
- 使用原 refund 本地 UUID、cwd=/Users/caoqu/refund 经新服务边界创建原生空会话成功，保留本地关联，thread/start 不含 projectId。没有 turn 请求，测试会话已成功归档。
- 原消息未重新识别或派发，未发送企微测试，未更新真实消息数据库；失败记录只能在人工确认后重新派发，并限制为尚无任何执行回执的创建失败。
- 没有重启/发布服务，没有提交或推送代码。当前运行实例需要另行发布才能加载修复。
- 已沉淀 `/Users/caoqu/.obsidian/wiki/_raw/2026-11-05-agentroam-messaging-project-and-native-capacity-fix.md`。
