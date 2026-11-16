# Bot 生态调研与本项目对比(2026-11)

- 输入:材料一(5 视角 × 14 个外部 Bot 调研)+ 材料二(本项目 customer-agent / AgentRoam 现状)+ 材料三(2026-11-07 补充轮:OpenCode / Qoder / WorkBuddy / ZCode 官方侧调研、首轮"待核实"项回源、多 agent 协作 / 监督对照样本;全部经 WebSearch + 官方文档回源取得,未取得一手来源处均如实标注)+ 材料四(2026-11-07 第三轮:个人助理 / 陪伴类 Agent——Muse / Grok Bot / ChatGPT Pulse / Manus / Genspark / 星野-Talkie,含同名消歧说明)+ 材料五(2026-11-07 第四轮:Muse Sentinel 工程细节、豆包手机助手与 SAEP 协议、个人 vs 编码 agent 记忆数据模型对照——补齐材料四遗留的三条缺口)。
- 定位:内部调研文档,结论先行,供架构决策参考。"待核实"标注随调研轮次滚动更新:首轮三项已于补充轮回源处理(见 §2.9 / §2.11 / §2.12),当前剩余风险清单见 §8 末尾。
- 项目侧关键 `file:line` 已做存在性与内容抽查(命令与结果见 §5.7);各轮材料(含两轮审读)中带代码锚点者的行号 / 数字 / 变量名偏差均已按实测修正并在 §5.7 注明。

---

## 1. 调研范围与方法

**范围**:材料一覆盖 5 个视角——终端双雄(Claude Code / Codex CLI)、IDE 双雄(GitHub Copilot 双形态 / Cursor)、开源阵营(Gemini CLI / Aider / OpenHands / SWE-agent)、国产模型侧(DeepSeek / 智谱 GLM / Qwen Code)、IM 平台(企微 / 钉钉 / 飞书 / Telegram / Slack);每个对象按定位 / 架构 / 会话 / 接入 / 强弱项五维摘录并附来源。材料二为本项目 8 个外部 runtime 适配器、Broker、messaging 包的现状与痛点。

**方法与边界**:
- 本文档以各轮材料为事实来源做转写与综合;材料三为外部文档回源调研,其引用的本项目代码锚点已于 2026-11-07 实读复核——实质内容吻合,但 6 处行号全部有漂移,本文一律按实测行号引用(见 §5.7)。
- 材料四(个人助理 / 陪伴类)为独立品类:与编码 agent(§2.1-2.11)共享 agent loop 内核,但产品主轴转向主动性 / 长期记忆 / 个性化 / 多渠道触达 / 信任;画像见 §2.14,矩阵单列表 5(不并入表 1 / 表 2 的"编码 Agent"口径),对本项目的借鉴评估见 §4.14-15 与 §7 建议 12-15。
- 材料五补齐材料四遗留的三条缺口:Muse Sentinel「模型外守门」工程细节(§2.15,含对材料四"审批四档"的更正)、端侧触达豆包手机助手与 SAEP 协议(§2.16,含对 Capacitor mobile 壳的落地注记)、个人 vs 编码 agent 记忆数据模型对照(§3 表 6);对 §7 建议 13 / 14 / 15 的落地形态有直接影响(已同步改写,并新增建议 16);§4 据其新增模式 16(守门工程化 + 声明式策略)与 17(记忆三极与溯源谱系);材料四多条无来源量化论断经第三轮审读标注待核实(见 §2.14 与 §8)。
- 本项目已接入、但材料一没有画像的对象:OpenCode、Qoder、WorkBuddy、ZCode——已由补充轮(材料三)完成官方侧画像,见 §2.13 与 §3 表 4;四家与本项目适配器路线的映射(含实测代码锚点)一并收录在 §2.13。
- 工作量估算(§7)是本文作者的工程粗估,不是材料原文。

---

## 2. 各家 Bot 逐个画像

### 2.1 Claude Code(Anthropic)

- **定位**:Anthropic 官方终端 AI 编程 agent(闭源 CLI,另有 IDE 扩展 / 桌面 / Web / 云会话),既是日常编码工具,也是 Claude Agent SDK 与 Managed Agents 的能力底座。
- **架构**:Node CLI 内置 agent loop,经 Anthropic API / Bedrock / Vertex 驱动;工具 = 内置文件读写编辑 / Bash + MCP;权限 = 六档 permission-mode(官方文档口径 default / acceptEdits / plan / auto / dontAsk / bypassPermissions;**本项目实际驱动的 claude 2.1.319 `--help` 实测 choices 为 acceptEdits / auto / bypassPermissions / manual / dontAsk / plan——无 default、多 manual,存在版本差**)+ allow/deny 规则 + canUseTool 回调;可选 OS 沙箱 Bash(macOS Seatbelt / Linux bubblewrap,网络走域名白名单代理,默认关闭);hooks 30+ 事件(command / http / mcp_tool / prompt / agent,exit 2 阻断、additionalContext 注入);子代理独立上下文、默认后台并行、可嵌套。
- **会话**:transcript 落盘 `~/.claude/projects/*.jsonl`;`--continue` / `--resume`(id/名称/路径)/ `--fork-session` / `--session-id` 恢复分叉;auto-compact 窗口阈值可调(`/autocompact`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`),`/compact` 手动;steering 靠 `--input-format stream-json` 实时注入用户消息、channels 从 MCP 推事件、SDK `interrupt()`;`--bg` 后台会话可 attach。
- **接入**:`claude -p` headless 支持 text / json / stream-json 输出、`--json-schema` 结构化、`--max-turns` / `--max-budget-usd` 上限;官方 TS/Python Agent SDK 是进程内封装同一 CLI 二进制;任意语言可子进程驱动;`--bg` 后台会话 attach/logs/stop;另有桌面 / 云 / Remote Control / 企业网关;官方推荐脚本用 `--bare` 跳过自动发现。
- **强项**:可定制生态最深(hooks 30+ 事件、plugins / skills / 子代理热加载,headless 与 SDK 文档成熟);权限体系细颗粒(模式 + 规则 + 回调 + OS 沙箱 + 企业托管策略,`--restricted` / `--safe-mode` 兜底);会话管理最完整(命名 / 分叉 / `--from-pr` / 后台 attach / Remote Control 跨设备续会)。
- **弱项**:CLI 本体闭源(仅 GitHub issue 跟踪),系统提示与协议只能靠 flag 定制、不能改源;默认启动加载 hooks / skills / MCP / CLAUDE.md 较重,脚本场景需 `--bare` 且其禁用一切 hooks;无沙箱时 bypassPermissions 模式风险高,官方仅建议在无网沙箱环境使用。

### 2.2 Codex CLI(OpenAI)

- **定位**:OpenAI 官方开源(Apache-2.0,约 13.3 万 stars)的 Rust 终端编码 agent,覆盖 CLI TUI / IDE 扩展 / 桌面 App / 云,也是 Codex SDK 与 app-server 集成的执行底座。
- **架构**:单一开源二进制内嵌 agent loop;系统提示按模型分文件内置仓库(`codex-rs/core/gpt_5_2_prompt.md` 等,含 AGENTS.md 目录树作用域规范);工具 = shell + apply_patch + update_plan;命令在 OS 沙箱执行(macOS Seatbelt / Linux Landlock+seccomp / Windows AppContainer 实验性);`sandbox_mode`(read-only / workspace-write / danger-full-access)与 `approval_policy`(现值 on-request / never)两维正交,`--approve-for-me` 自动审批;hooks 支持 command / mcpTool / prompt / agent 且需持久化 hook trust;子代理可并行。
- **会话**:持久化 `~/.codex/sessions`;`codex resume` / `fork` 支持 picker、`--last`、按 UUID 或会话名,`exec resume <id>` 续非交互会话;`/queue` 向运行中会话排队消息实现中途注入;auto-compact 按 `model_auto_compact_token_limit` 与 turn-end 百分比阈值(compaction 有 pre/postCompact 钩子);config.toml 分层(requirements.toml 可托管 hooks)。
- **接入**:`codex exec` 非交互(`--json` JSONL 事件流、`--output-schema` 结构化、`-o` 写最后回复、`--ephemeral` 不落盘、`-c key=value` 任意覆盖配置);官方 TS SDK(@openai/codex-sdk)与 Python SDK(openai-codex)spawn CLI 走 stdin/stdout JSONL;codex app-server(实验性 JSON-RPC,附 TS 绑定与 JSON Schema 生成)+ daemon / remote-control 远程驱动;任意语言均可子进程调用。
- **强项**:完全开源(harness、系统提示、协议 schema 全部可审计可复用,第三方可精确对齐行为);安全模型清晰(OS 级沙箱默认开启、沙箱与审批两维正交,Landlock / Seatbelt / Windows sandbox 工程深度);服务化接口多(app-server / exec-server / daemon / remote-control,内置 MCP 客户端管理 `codex mcp`)。
- **弱项**:审批策略演进快(untrusted 已移除、on-failure 弃用,0.167.0 实测仅剩 on-request / never),跨版本集成需盯 changelog;Windows 沙箱、app-server / exec-server / remote-control 标实验性,生产依赖需评估;developers.openai.com 文档分散且部分页面有反爬,细节常需回源码核对。

### 2.3 GitHub Copilot(交互 Agent + 云端 coding agent)

**Copilot Agent(VS Code Agent 模式 + Copilot CLI)**
- **定位**:GitHub 官方交互式编码 agent:IDE 内 Agent 模式(VS Code 等)与终端原生 Copilot CLI(2026-02-25 GA)双形态,本地执行为主、可一键转云端沙箱。
- **架构**:VS Code agent 模式由 Copilot harness 驱动内置 + MCP 工具循环,可换 Claude / Codex harness;CLI 为独立运行时,支持 custom agents / hooks / skills / plugins、MCP、多模型与 BYO provider;权限三级 Manual / Assisted(LLM 判审)/ Allow all,配 allowlist 与终端沙箱。
- **会话**:CLI 在 95% token 阈值自动压缩历史(`/compact`、`/context`),plan mode 先澄清后规划;`--cloud` 转云沙箱并跨 CLI / Mobile 接续;审批支持 Allow Once / Session / Always 作用域。
- **接入**:`copilot -p` 非交互脚本化;Copilot SDK(2026-06 GA,Python/TS/Go/.NET/Java/Rust)复用同一 agent 引擎;支持 ACP 接第三方 IDE;BYO provider 环境变量(OpenAI / Azure / Anthropic / Ollama)。
- **强项**:多 surface 一致体验与 GitHub 生态深度集成;审批体系最细(作用域审批、URL 请求/响应双段审批、正则 allowlist、OS 沙箱);多语言 SDK + ACP,程序化接入面最宽。
- **弱项**:自动审批 / allowlist 官方自认 best-effort 非安全边界,复合命令可绕过;BYO provider 要求模型支持 tool calling + streaming 且上下文 ≥128k;曾有 CLI 自动更新破坏 headless `--stdio`(MCP/SDK 集成)的记录。

**Copilot coding agent(云端异步派活)**
- **定位**:GitHub 官方云端异步编码 agent:把 issue / @copilot / REST 任务派给它,在 GitHub 托管环境自主编码并交付 PR;2026-10 起并入跨客户端的 "Copilot in the cloud" 统一体验。
- **架构**:三种执行环境——Cloud sandbox(跨端续会话、可跨仓库)、GitHub Actions-based(单仓库、59 分钟上限、28 天会话保留)、Remote 自定义环境;以 copilot-swe-agent 在指定仓库/分支自主编码开 draft PR,遵守 firewall allowlist 与 ruleset / branch protection。
- **会话**:session logs 记录步骤与工具调用;@copilot 评论跟进追加改动,可对任意 PR 叠开新 PR(2025-10);跨 surfaces 同步历史;Agent Merge "Watch and fix" 自动处理 CI 失败与合并冲突。
- **接入**:Agent tasks REST API(preview):`POST /agents/repos/{owner}/{repo}/tasks` 启动、GET 查状态(含 waiting_for_user);REST/GraphQL issues API 派 issue;MCP 工具 assign_copilot_to_issue;仅支持 user-to-server token。
- **强项**:issue 分配是一等派活原语,与 GitHub 工作流 / CI / ruleset 深度绑定;执行环境弹性(云沙箱 / Actions / 自托管 Remote);组织策略、审计与内容排除完善。
- **弱项**:Actions 环境限单仓库且 59 分钟硬上限;任务 API 不支持 server-to-server token,CI 内自动化受限;官方明示 logs 不能替代人工审查,只适合范围明确的任务。

### 2.4 Cursor(Anysphere)

- **定位**:全栈编码 agent:IDE 内 Agent / Plan / Ask 模式、cursor-agent CLI、云端 Cloud Agents(原 Background Agents,2025 改名)隔离 VM 执行,一体覆盖。
- **架构**:本地 agent = Rules / AGENTS.md 指令 + 工具(搜索 / 编辑 / 终端 / 浏览器 / 图像)+ 逐模型调优;Cloud Agents 跑隔离 VM(Dockerfile / snapshot / Builds 预热),支持自托管执行机;权限为 Run Modes(Auto-review / Allowlist / Run Everything)+ permissions.json + hooks + CLI 沙箱。
- **会话**:Checkpoints 本地快照(独立于 Git)仅回滚文件;消息队列 + Steer(下次工具调用送达);`/goal` 长目标、`/side` 副线;CLI ls / resume / `--continue` 恢复;`&` 前缀把本地任务推云端,web / mobile / URL 分享接续。
- **接入**:Cloud Agents API v1(public beta):`POST /v1/agents`、runs 可 steer / 排队、SSE 流、artifacts / secrets / environments,官方 TS SDK;CLI `-p` print 模式上 CI;Slack / Linear / PR 评论 @cursor 多入口;MCP 支持 HTTP / stdio / OAuth。
- **强项**:云端任务 API 最完整(follow-up / steer / SSE / usage / secrets 全覆盖);本地-云端-移动交接顺滑(`&` 前缀一键上云);确定性 allowlist + LLM Auto-review + hooks 多层护栏。
- **弱项**:云端 API 仍 public beta 可能变动(v0 弃用、v1 暂无 webhooks);allowlist / autoRun 官方自认非安全边界;Cloud Agents 需 Premium 及以上计划(Free / Plus 不含)。

### 2.5 Gemini CLI(Google)

- **定位**:Google 开源的终端 AI 编码 agent harness(Apache 2.0、TypeScript):把 Gemini 模型变成带工具循环的终端 agent,个人账户上线时免费 60 次/分、1000 次/天,主打 1M token 上下文。
- **架构**:packages/cli(客户端)+ packages/core(本地服务端)的客户端-服务端结构;core 统一调度 Gemini API 与内置工具(read_file / write_file / read_many_files、run_shell_command、web_fetch、google_web_search、save_memory);工具经 MCP(stdio / SSE / Streamable HTTP)与 Extensions 扩展;沙箱可选 macOS Seatbelt 或 Docker / Podman(`--yolo` 默认开沙箱),配 approval-mode 审批。
- **会话**:GEMINI.md 层级记忆(`/memory`、save_memory 工具,context.fileName 可改);`/compress` 压缩上下文;checkpointing 默认关闭,开启后文件修改前自动快照、`/restore` 恢复;`/chat save` / `resume` 支持会话保存与分支。
- **接入**:`-p` / `--prompt` 非交互 headless(配 `--output-format json` 拿结构化输出)、`--prompt-interactive`;core 可作 SDK 集成;官方 GitHub Action 进 CI;作为 MCP 客户端接入生态,自身当 MCP server 未见官方支持(仅社区 bridge)。
- **强项**:免费额度 + 1M 上下文的获取门槛最低;开源且扩展生态完整(MCP + Extensions + 官方 GH Action);沙箱 / 审批的安全模型在开源 CLI 中最完整。
- **弱项**:输出质量被用户反馈不稳定(时好时坏);深度绑定 Gemini 模型栈,换第三方模型非主打;会话 / 压缩等能力散在实验特性里,文档分散。

### 2.6 Aider

- **定位**:Aider-AI 的终端 AI 结对编程工具(Python):"请求-编辑-自动 git 提交"的轻循环,支持多家云与本地模型,无沙箱、直接在本地仓库工作。
- **架构**:招牌是 repo-map:tree-sitter 抽取全库符号定义/引用构成图,做图排名(PageRank,见官方博客)挑最重要文件与签名,按 `--map-tokens`(默认 1k)预算打包进每次请求,并随聊天状态动态扩缩;编辑以 diff 等格式落盘并自动 git 提交,全程无容器隔离。
- **会话**:上下文管理偏手动:`/tokens` 查看、`/drop` 移除文件、`/clear` 清史、`/compact` 压缩;不强制 token 上限、只转发 API 报错;repo map 在聊天中无文件时自动放大以代偿。
- **接入**:`--message` / `-m` 一次性执行、`--message-file`、`--yes` / `--dry-run` 可脚本化;Python API(Coder.create + coder.run)可用但官方声明"非正式支持、不保证兼容";无 HTTP API,另有浏览器模式。
- **强项**:repo-map 是大仓库上下文注入的经典低成本方案;git 深度集成(自动提交、可回滚),改动全程留痕;模型无关,迁移到任意云/本地模型成本低。
- **弱项**:默认非自主长循环的结对范式,缺后台 agent 与沙箱隔离;Python API 非官方支持、无服务端接口;上下文控制靠手动命令,自动化程度低。

### 2.7 OpenHands(All Hands AI)

- **定位**:自主软件开发 agent 平台(前身 OpenDevin):云端企业版 + CLI(TUI)+ Python SDK,事件溯源架构,让沙箱化 agent 从 issue 自主做到 PR。
- **架构**:企业版 Enterprise Server 编排会话与 webhook,Keycloak 认证;每会话独立 Runtime pod 沙箱(内含 agent server,执行 bash / 文件编辑 / 浏览器 / git);LiteLLM 代理统一多家 LLM;Runtime API 维护 warm 池免冷启动;SDK 拆 SDK / Tools / Workspace / Server 四包;错误分两层——AgentErrorEvent 发给模型自恢复,ConversationErrorEvent 终止运行。
- **会话**:会话是 append-only 不可变事件日志(SystemPrompt / Message / Action / Observation / AgentError / CondensationSummary 等事件驱动并重建状态,source 与 LLM role 刻意分离);Condenser 接近窗口时丢旧事件并插入 LLM 摘要;状态持久化于 PostgreSQL / Redis / 对象存储。
- **接入**:Python SDK 与 Agent Server REST API 双轨,可被第三方程序完整驱动;CLI / TUI 与 headless;企业版经 HMAC 签名 webhook 接入 GitHub / GitLab / Slack / Jira。
- **强项**:事件溯源 + Condenser 提供可审计、可恢复的上下文管理;沙箱隔离与 warm 池的工程化在开源里最完整;接入面最广(SDK / REST / webhook / CLI)。
- **弱项**:企业栈重(K8s / Keycloak / PostgreSQL / Redis / 对象存储);部分订阅型 LLM 场景压缩被禁用导致长会话上下文溢出(GitHub issue 2026-08);运行成本与复杂度显著高于单机 CLI。

### 2.8 SWE-agent(普林斯顿/斯坦福)

- **定位**:仓库级研究型 agent,提出 Agent-Computer Interface(ACI)概念(NeurIPS 2024,arXiv:2405.15793);现已转维护模式,官方推荐 100 行 Python 的 mini-swe-agent。
- **架构**:核心是 ACI——为模型定制工具:编辑命令先过 linter(语法不过不落盘)、专用文件查看器每轮 100 行、全库搜索只返回文件名、空输出返回确认语防误判;运行时经 SWE-ReX 接 Docker / Modal 等沙箱 shell;全量版由单一 YAML 配置 agent,mini-swe-agent 退到纯 bash 工具循环。
- **会话**:无产品化会话恢复 / checkpoint;history processor 在每次调模型前对轨迹做可配置过滤与截断(裁剪旧观察、标记缓存点);轨迹可用 trajectory inspector 检查。
- **接入**:CLI 两形态:sweagent run 单实例、run-batch 批量评测;Python 包可脚本化;mini-swe-agent 提供 mini-extra swebench 批跑;无托管 HTTP API。
- **强项**:ACI 洞见——工具接口设计对 agent 成功率影响巨大(论文约 3600 次引用);SWE-bench 评测生态与轨迹检查器一流;mini-swe-agent 以 100 行达到与全量版相当的成绩(官方口径 SWE-bench Verified 65%)。
- **弱项**:主线已停更、仅维护;研究导向,缺审批 / 恢复等消费级 UX;全量版 YAML 配置复杂曾是公认负担。

### 2.9 DeepSeek(深度求索)

- **定位**:模型厂商,不出自有 agent harness;官方工具链 = OpenAI / Anthropic / Responses 三协议兼容 API + 官方接入指南(Claude Code、OpenCode 等),agent 能力全部由模型侧 function calling 提供。
- **架构**:纯 API 服务,无自有运行时;第三方 harness 经 `ANTHROPIC_BASE_URL=api.deepseek.com/anthropic` 驱动,服务端映射模型名(claude-opus* → deepseek-v4-pro,其余 → deepseek-flash);支持思考模式工具调用、strict 工具 schema(beta 端点)与服务端 web_search;不支持 MCP、code_execution、document 块。
- **会话**:无官方会话/状态管理,无服务端恢复;上下文与压缩完全由客户端 harness 负责,cache_control 等字段被服务端忽略。
- **接入**:三协议 REST + `/beta` 端点;改两个环境变量即可把 Claude Code 切到 DeepSeek;无官方 CLI / SDK;Anthropic / Responses API 支持在对话历史中途注入工具调用,Chat Completion API 不支持。
- **强项**:双协议兼容,接入 Claude Code 零改造,官方维护兼容文档与限制矩阵;思考模式 + 工具调用已打通且 strict schema 可校验参数;tool_choice=auto/none 完整支持、服务端 web_search 免客户端执行。
- **弱项**:无官方 CLI / IDE / 云端 agent,会话、沙箱、审批全靠第三方 harness;兼容层有硬边界(tool_choice any 降级为 auto、tool 仅非思考模式、thinking 轮次需回传完整 assistant 内容块、图片支持受限);文档结构变动(补充轮实测):旧地址 /guides/function_calling 已 404,当前主推模型为 deepseek-flash(DeepSeek-V4.1-Flash-1017 服务)与 deepseek-v4-pro,deepseek-v4-flash 等旧名退役;Wayback 旧版指南快照两轮查询均未取到。
- **补充轮回源(2026-11-07)**:『V3.2 原生 tool calls 失败反馈』拆两半核验——前半句成立,官方 Tool Calls 指南原文 "From DeepSeek-V3.2, the API supports tool use in the thinking mode"(思考模式原生工具调用、推理与工具交错),Change Log 记录 deepseek-chat / deepseek-reasoner 升级 DeepSeek-V3.2-Exp 且 Function Calling 准确率提升;后半句查无官方出处——官方示例的 tool role 消息只回传成功结果(如 "24℃"),仅 strict 模式(/beta)提到 JSON Schema 校验不合"返回错误消息"(请求校验错误,非工具执行失败反馈),该条应视为项目内实践而非官方能力。
- **补充轮新发现(dsh,审读修订后)**:DeepSeek Harness(`dsh`)为 DeepSeek AI 官方开源 agent harness,仓库 README 实抓原文:"DeepSeek Harness is in developer preview and iterating rapidly."、"It is built on an everything-is-a-plugin architecture and powered by Cordis"、"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."(github.com/deepseek-ai/deepseek-harness;材料三原引语"用于构建 Agent Harness 的插件化 SDK"系转述、README 无此原句,news250929 为 V3.2-Exp 公告与 dsh 无关,引语出处已换锚到仓库 README);官方 Agent Integrations 文档直接列出 WorkBuddy/CodeBuddy、Qoder、OpenCode 等集成页。本项目 deepseek-harness-client / codec 适配器对应的官方面即此,跟进需盯其破坏性变更公告(风险已录入 §8 清单)。

### 2.10 智谱 GLM Coding Plan(含 AutoGLM / AutoClaw)

- **定位**:面向编码场景的订阅套餐(国内 bigmodel.cn、海外 Z.AI),借 Claude Code / Codex / OpenCode / ZCode 等成熟 harness 运行 GLM 旗舰模型;另以官方本地客户端 AutoClaw(2026-03 发布,内置 50+ Skills、集成 AutoGLM Browser-Use)与 AutoGLM 浏览器代理补足自有形态。
- **架构**:Anthropic 兼容端点 `open.bigmodel.cn/api/anthropic`(海外 `api.z.ai/api/anthropic`),服务端把 Claude 模型名映射为 GLM:Opus / Sonnet / Haiku 三槽位默认 GLM-4.7,GLM-5.2 需写 `glm-5.2[1m]` 启用 1M 上下文;`/effort` 强度映射(low/medium/high → high,xhigh/max/ultracode → max);官方提供视觉 / 搜索 / 网页读取 MCP。
- **会话**:会话恢复、压缩、并行等沿用所借 harness 的原生机制;官方以 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` 控制自动压缩窗口以配合 1M 上下文,并建议升级 Claude Code 版本以识别 `[1m]` 后缀。
- **接入**:改 `~/.claude/settings.json` 或环境变量即可接入,Coding Tool Helper 一键自动配置;积分制计费:Lite 2000/5h、Pro 12000/5h、Max 28000/5h 积分(周额度 5 倍),积分按 token 与模型系数抵扣、非高峰五折;套餐额度仅限指定工具环境内共享,不覆盖一般 API 调用。
- **强项**:对 Claude Code 生态兼容度最高(官方维护映射文档、MCP 服务器、版本适配与排障指南);订阅制成本远低于 Claude 官方套餐;AutoClaw + AutoGLM 补齐本地客户端、浏览器操作与飞书等 IM 接入。
- **弱项**:套餐额度锁死在官方指定工具白名单内;2026 年 2 月与 7 月两度调价并从按次 prompts 改为 token 积分制(Lite 49→118 元/月、Pro 149→538 元/月,第三方报道),涨价与额度缩水有争议;服务端映射语义依赖 Claude Code 版本,配置不生效需手动排障。

### 2.11 Qwen Code(阿里通义)

- **定位**:阿里官方开源终端编码 agent(TypeScript),起步于 Gemini CLI v0.8.2 fork、v0.1 起停止同步独立演进,已扩展为 CLI / 桌面 / Web / IDE 插件 / IM 通道的全形态 agent 框架,与 Qwen 模型同步开源。
- **架构**:Node CLI 自研 agent loop,多协议驱动(OpenAI / Anthropic / Gemini / Qwen API 及 Ollama / vLLM 本地模型,可运行时切换);内置 SubAgents、Agent Teams、Auto-Memory、Auto-Skills、Hooks、MCP、Plan Mode、Sandbox、LSP、Computer Use;daemon 模式 `qwen serve` 经 HTTP+SSE(ACP)让多客户端共享 agent 会话;默认对接阿里云 ModelStudio 的 qwen3-coder-plus(DashScope 兼容接口),旗舰 Qwen3-Coder-480B-A35B 原生 256K、YaRN 外推 1M 上下文。
- **会话**:官方文档覆盖 conversations-recovery(会话恢复)、managed-session-worktrees(按会话挂 git worktree)、`/branch` `/resume` `/fork` 会话分支、memory 与 context-cost 上下文压缩、cross-session-protocol;daemon 支持客户端断线重连活跃会话。
- **接入**:npm / Homebrew / 独立脚本安装;`qwen -p` headless 供 CI 与批量任务;TS / Python / Java 三种 SDK;daemon REST API(附 OpenAPI 规范);GitHub Actions 集成;钉钉 / 企微 / 飞书 / Telegram IM 通道(`qwen channel start`);可经 ACP 被其他 agent(如 Claude Code)委托调用。
- **强项**:模型 + 框架全开源无锁定;README 功能对照表自称已对齐 Claude Code 并多出 Agent Arena(多模型同题对打)、daemon 多客户端共享、IM 通道;多协议层可接任意第三方或本地模型;官方 SWE-bench Verified 7 个版本均值 76.4%–77.8%。
- **弱项**:自述仍以自身 agent 快速迭代自身,成熟度与稳定性待长期观察;评测分数绑定自家 Qwen 3.7 Max 模型,换模型无官方数据;免费额度(补充轮回源):旧口径已过时——官方认证文档(2026-10-19 更新版,本轮实抓)列 5 种认证方式,Qwen OAuth 现要求 chat.qwen.ai 的 Plus/Pro 订阅,配额表述为 "usage is subject to your subscription plan",页面已不含任何"2000 次/天"数字;"每天 2000 请求、每分钟 60"系 2025 年 OAuth 上线时的社区确认(issue #1726、Reddit 帖),2026-04 起有用户报告降至 1000/天甚至更低(issue #3267、#3203)——当前具体限额官方未给出数字,不能作为事实引用;Anthropic 生态兼容靠自身多协议层而非服务端映射。

### 2.12 IM 平台 Bot 生态(企微 / 钉钉 / 飞书 / Telegram / Slack)

- **企业微信智能机器人**:双轨——「消息推送」(原群机器人,单向 webhook 群播)与「智能机器人」(双向 API 机器人,webhook 或 WebSocket 长连接)。长连接 `wss://openws.work.weixin.qq.com`,aibot_subscribe 订阅、30s 心跳、单机器人仅 1 连接、新连踢旧连;回复透传 req_id 做 stream 流式上屏、10 分钟内须 finish;主动推送前提是用户先发过消息(24h 窗口);image / voice / file / video 仅单聊可收;单会话回复+推送合计 30 条/分、1000 条/时;enter_chat 事件 5 秒内回欢迎语;非超管创建的机器人回调 userid 加密需转明文。强项:微信生态触达、长连接免公网 IP、原生流式、模板卡片等企业交互;弱项:媒体仅单聊、主动推送受限、长连接单实例互踢且无官方多连接负载方案。
- **钉钉机器人**:三形态——自定义机器人(群 webhook 单向,需关键词 / 加签 / IP 白名单三选一)、企业内部应用机器人(双向单聊+群聊)、AI 助理(开箱即用智能体平台)。Stream 模式(dingtalk-stream SDK 反向 WebSocket)无需公网 IP / 域名 / 证书 / 内网穿透;AI 回复用 AI 卡片 streamMode:创建卡片 → streamingUpdate 增量写入 → 终止,配 typingAction 打字机效果;单聊仅企业内部应用机器人支持;自定义机器人 20 条/分钟、超限罚停 10 分钟且只能发群;服务端 API 标准版 20 QPS、IP 维度 20 秒 1 万次即封 5 分钟。强项:接入门槛全场最低、官方 AI 卡片流式 + AI 助理开箱即用、组织内审批 / 日程 / 待办联动深;弱项:自定义机器人限频罚停、单聊能力限企业内部应用机器人。
- **飞书机器人**:自建 / 商店应用机器人(双向)+ 自定义机器人(群 webhook 单向)。事件订阅走 webhook(公网 URL + 验签解密)或 SDK 长连接(WebSocket 全双工,仅自建应用,每应用 ≤50 连接,集群模式随机单点投递、不支持广播);事件须 3 秒内处理完否则重推;AI 回复走 CardKit v1:创建卡片 → 流式更新文本 → 完成,卡片 14 天内可更新——五家中最完整的专用 AI 流式 API。限频:同用户 5 QPS、同群全体机器人共享 5 QPS;自定义 webhook 单租户单机器人 100 次/分、5 次/秒。强项:CardKit 流式、长连接免公网免验签、卡片组件第一梯队;弱项:长连接仅自建应用(商店应用必须 webhook)、集群随机投递不支持广播、消息 / 群组类接口明确不支持自行提频。
- **Telegram Bot**:官方 Bot API,无企业组织模型,AI Agent 最常用的一线接入入口。getUpdates 长轮询与 setWebhook HTTPS 回调二选一互斥(webhook 仅 443/80/88/8443 端口、需 SSL、secret path 鉴权);webhook 响应体内联 API 调用;流式回复用 Bot API 9.5+ `sendMessageDraft` / 10.x `sendRichMessageDraft` 原生草稿,或 editMessageText 节流编辑;群聊默认 privacy mode 只收命令 / 回复 / 经本 bot 发送的消息;频控:单 chat 1 msg/s、群 20 msg/min、广播约 30 msg/s,超限 429 + retry_after,付费广播可提至 1000 msg/s(0.1 Stars/条,需 10 万 Stars 余额 + 10 万 MAU)。强项:接入零门槛、原生流式草稿 API、生态与第三方库最丰富;弱项:无企业权限体系、发送阈值未文档化、文件下载 ≤20MB / 发送 ≤50MB。
- **Slack App**:bot 即 Slack App,Bolt 框架 + Events API / Socket Mode + Web API tier 限流 + Block Kit。Events API HTTP 回调(限 30,000 events/workspace/app/60 分钟)或 Socket Mode(app-level token 调 apps.connections.open 换动态 WebSocket URL,免公共端点);AI 流式用 2025-10 新增 chat.startStream / appendStream / stopStream(+2026-04 streaming blocks);chat.postMessage 特殊 tier 每 channel 1 msg/s(允许短突发),429 + Retry-After;读历史限制已回源官方一手 changelog(2025-05-29):仅 conversations.history / conversations.replies 降为每请求 15 条、每分钟 1 次(limit 最大/默认同步降为 15),2025-05-29 后新建 app 及所有"新安装"立即生效,既有外部分发安装不受影响、内部自建应用完全豁免、Marketplace 应用不受限,官方理由点名防敏感会话数据外泄与"unsanctioned data scraping"(AI 风险);另:bot token 只能读其已加入的会话(not_in_channel 仅 user token 可越),标准 Tier 3 为 50+/分钟。强项:Socket Mode 免公网 + 官方 AI 流式最完整、Block Kit 与企业 SaaS 生态最强、按 method×workspace×app 限流清晰可预期;弱项:postMessage 1 msg/s/channel 偏紧、读历史收紧影响上下文回填(官方一手确认,豁免路径=上架 Marketplace 或既有安装/内部自建)、官方文档站迁移老链接大量 404(材料实测 api.slack.com 与 docs.slack.dev 旧 Socket Mode 链接均 404)。落地含义:若本项目 Slack 接入使用 2025-05-29 之后新建的自建 app,读历史会命中 15 条/1rpm 限制。

### 2.13 OpenCode / Qoder / WorkBuddy / ZCode(补充轮官方侧画像)

> 补充轮(材料三)成果:首轮未覆盖的四个本项目已接入 runtime 的官方侧调研;除标注外均为官方文档 / 一手来源;"与本项目映射"的代码锚点已于 2026-11-07 实读复核并按实测行号引用(材料三原行号全部漂移,见 §5.7)。

**OpenCode(sst 系开源,仓库已迁移)**
- 文档域:`opencode.ai/docs` 以 308 永久重定向到 docs.opencode.ai(本轮抓取实测);文档分 v1 / v2 两代(ACP 路径为 /v2/docs/cli/acp),与本项目 opencode-v2-* 适配器命名对应。
- 服务化接口(协议核心):`opencode serve` 启动 headless HTTP 服务器,暴露 OpenAPI 3.1 规范(`GET /doc`,官方 SDK 即由该规范生成);默认端口 4096;`OPENCODE_SERVER_PASSWORD/USERNAME` 开 HTTP Basic 认证;事件流为 SSE(`GET /event` 首个事件 server.connected,另有 `GET /global/event` 全局流);会话端点含同步 `/session/:id/message`、异步 prompt_async(204)、command / shell / fork / revert / 权限响应;IDE 插件走 `/tui/*` 控制端点;支持 `POST /mcp` 动态挂 MCP。
- ACP:原生支持 ACP(Agent Client Protocol,Zed 系协议);JetBrains AI Assistant 自 2026-10 起可接入 OpenCode。
- 版本节奏:GitHub Releases API 实测——v2.2.6(2026-11-06)、v2.2.1–v2.2.5(10-29 / 10-30),独立组件 process-daemon v0.4.0 / v0.5.0 单独发版:数天一发 patch + 组件拆分发版;仓库已迁移(旧 /repos/sst/opencode 返回 301)。changelog 页直抓超时,版本以 GitHub API 为准。
- 与本项目映射:当前走 HTTP server + 官方 SDK 路线——opencode-v2-transport.ts:9 用 @opencode-ai/sdk 的 createOpencodeClient(:2 导入),:10 注明 "The legacy SDK's SSE implementation ignores its configured fetch adapter",:11-13 手工覆盖 global.event 改走 `/global/event` SSE;官方 ACP 是另一条未采用的集成面。

**Qoder(阿里)**
- 产品形态已重构:官方文档拆为 Qoder(全新形态)/ IDE / JetBrains 插件 / CLI / Agent SDK / Cloud Agents / QoderWork / QoderWake / 移动端&网页版 / 企业版;IDE 内 "Quest" 视窗已下线,Quest 形态走向独立桌面端 "New Qoder"。
- CLI 能力面:交互 / Plan / Goal / 定时任务 / `/loop` / Headless 无头模式(结构化输出,供脚本与 CI/CD);另有 Remote Control、Cloud Mode、Qoder Action、ACP。
- Agent SDK:TS / Python / Java 三语言;可切换云端代理(TS `options.experimentalCloudAgent`、Python `experimental_cloud_agent`),认证走 PAT / 环境变量。
- Cloud Agents REST API(v1 Beta):Managed(`https://api.qoder.com/api/v1/cloud`)与 Forward(`/api/v1/forward`)双网关;Bearer PAT/SAT 认证;请求体上限 4MB;Metadata Search 限 10 个在途请求;Beta 特性需 `x-qoder-beta` 头(如 browser-use-2026-07-14、search-2026-08-31);资源模型含 agents / environments / sessions / events / files / vaults / skills / memory_stores / deployments,自托管环境有 work 队列与 worker lease。
- 版本节奏:独立站 changelog.qoder.com;近期条目含 Qoder Lite($10/月)上线、Efficient 档升级为 Fast 档。
- 与本项目映射:qoder-client.ts:55 经 NativeRpcClient(`new NativeRpcClient(() => resolveNativeCliCommand("qoder"))`)走 CLI 进程 + stdio JSON-RPC,未使用官方 Cloud Agents REST / SDK——官方服务化接口是当前适配器之外的新能力面,值得评估迁移或并行支持。

**WorkBuddy(= 腾讯云 CodeBuddy Code)**
- 身份核实(首轮材料一未明确):workbuddy.ai/docs/zh/cli 页面渲染为「腾讯云代码助手 CodeBuddy」,canonical 指向 www.codebuddy.ai/docs/zh/cli/overview;安装 `npm install -g @tencent-ai/codebuddy-code`,命令名 codebuddy / cbc;DeepSeek 官方 Agent Integrations 列表以 "WorkBuddy/CodeBuddy" 并列收录。
- 能力面(官方文档侧边栏,本轮实抓):无头模式、Workflow stdio 协议、ACP 协议集成、HTTP API (Beta)、Daemon 模式、远程控制、Web UI、企业微信智能机器人接入、Agent Teams、子代理、Goal、定时任务、Channels [Beta]、Python/TypeScript SDK、安全(权限模式 / 权限规则 / Bash 沙箱)。
- ACP 协议细节:`codebuddy --acp` 原生作为 ACP 服务端可接 Zed;协议扩展含——客户端轮次 ID(`_meta.conversationRequestId`,32 位 UUIDv7 hex)、认证扩展(`codebuddy.ai/userinfo`)、工具代理(客户端声明 fs.readTextFile / fs.writeTextFile / terminal 后相关工具转由客户端执行)、会话级 context_window 200K / 1M 档位、Code Mode(off / all PTC)、Agent Teams 事件(session_info_update 的 `_meta['codebuddy.ai/teamUpdate']` 与成员消息 `_meta['codebuddy.ai/memberEvent']`,loadSession 重放)、Multitask 协调器(ACP / `--serve` 模式明确禁止,能力发现 `agentCapabilities.multitaskSupport`,配置走 `session/set_config_option` 的 `configId:"multitask"`)。
- 版本节奏(两镜像不一致,引用前需择一为准):workbuddy.ai 文档侧边栏发布列表 v2.37.0 → v2.162.0(本轮实抓最新);腾讯云文档中心 CLI 命令参考标注 2026-08-26 更新、搜索显示存在 v2.163.0 / v2.168.2 / v2.173.0——两边节奏不同步,差异原因待核实。
- 与本项目映射:workbuddy-client.ts:13 以 `channel: NativeStdioChannel`(:7 导入、:61 工厂)用 JSON 包驱动 CLI(stdio 直连),未走官方 ACP / HTTP API / SDK 面。

**ZCode(Z.ai)**
- 官方定位:Z.ai 的 Agentic Development Environment(ADE),与 GLM-5.3 联合调优的官方 harness;入口为桌面端(Electron,当前 3.17.2)、Mobile Remote(手机控制 Agent)、Bot Channel(飞书 / 微信 Bot,@ 触发任务)。能力面:Goal Mode、Subagents、Idle-time Task(空闲时段免费跑任务)、Browser Automation、MCP / Plugin / Skill / Hooks / Command、Memory、Repo Wiki、Automations、Remote Development / Control、Safety Confirmation(敏感命令 / 文件改动需确认)。
- 版本节奏(releases 页实抓):3.14.3(2026-09-22)→ 3.15.1(10-12,飞书群聊协作、工作流可为每个 sub-agent 指定独立模型、自主模式危险命令需确认)→ 3.15.3(10-13,修复多 Agent 并行请求异常)→ 3.16.2(10-20,插件市场)→ 3.16.3(10-23,子代理可见会话已开文档)→ 3.17.2(11-03,MCP 配置界面 draft、无 Node 也可启动 MCP、macOS 最低 13)。约 1–2 周一发。
- 服务化接口:welcome 页未给出公开 REST API / SDK;官方仓库含 Desktop / Web / backend 与 Agent CLI runtime(`apps/zcode-cli`,来自第三方仓库说明,官方仓库入口待核实)。
- 与本项目映射(风险标注):zcode-desktop-bridge.ts:25 读取 `~/.zcode/v2/desktop-bridges` 目录(`:15` 描述符类型 `{version: 1; protocol; hostId; pid; port; token}`)经 RPC 连桌面端,:19 注释明确 "Borrow the desktop owner. This client never resumes or spawns its session"——该 desktop-bridge 描述符协议在官方文档站未见公开描述,属桌面端内部 / 逆向接口,升级时需警惕兼容风险。

### 2.14 个人助理 / 陪伴类 Agent(补充轮:材料四)

> 材料四成果:消费级个人 agent(任务执行型)与陪伴类产品的首轮调研,与编码 agent(§2.1-2.11)对照阅读——同一 agent loop 内核,主轴从"代码产出"换成"主动性、长期记忆、个性化、多渠道触达与信任"。

**Muse(Meta)**
- **定位**:Meta 2026-09-08 发布的消费级个人 AI Agent(口号:材料四引 "Your Personal AI Agent",但第三轮审读实抓发布稿标题为 **"The World's First Personal AI Agent Built for Everyone"**、无该口号——口号改锚 ai.meta.com/muse 落地页,**待核实**),iOS / Android / Mac App + muse.ai 网页 + WhatsApp 多端形态,定位"不是聊天机器人,而是能替用户真实执行任务的智能体",扎克伯格称之为个人超级智能的消费级入口。同名消歧:微软研究院 MUSE(数据科学元智能体)、Unity Muse(游戏 AI,已弃用)、Sudowrite Muse(小说模型)均为**同名检索噪声**(非 Muse 本名);Museland(上海逐鹿行)同为 AI 角色扮演 / 陪伴类,与本章纳入的星野 / Talkie 同类,不单列画像——排除口径是"陪伴类已由星野 / Talkie 代表",而非"不符个人 agent 定位"。
- **架构**:Muse Spark 模型(现 1.3)驱动(审读实抓发布稿吻合);每用户独享一台云端隔离 Linux 虚拟机 Muse Secure VM(含完整浏览器;"约 8GB 内存"为材料四口径、清单无对应条目,**待核实**);同机独立 Sentinel agent 审批所有出站动作并按需向用户请示(工程细节见 §2.15);凭据存于 agent 不可见的加密存储(§2.15 surrogation 机制),支付走一次性卡号(材料四称 Stripe Link、清单无对应条目,**待核实**),全程活动审计日志;已宣布 Windows 原生版(微软 MXC 沙箱)与 AI 眼镜版(发布稿吻合 AI 眼镜预告)。
- **会话**:App / 网页 / WhatsApp / Mac 触达同一驻留 VM 的 agent,关掉应用任务继续;纠正会沉淀为跨会话记忆,可在"记忆"面板查看 / 编辑或令其遗忘;审批档位(**材料五更正**):官方决策三档 allowed / denied / ask,批准为 capability、支持五种授权粒度(one-time / session-scoped / task-scoped / time-bounded / perpetual)——材料四"单次 / 本任务 / 本站点 / 始终四档"未在官方原文逐字出现,详见 §2.15;已知缺陷:上下文压缩会丢失确认规则。
- **接入**:个人 agent 本体无 API;Meta Model API(dev.meta.ai)开放 Muse Spark / Wonder 推理,兼容 Responses / Chat Completions / Messages 三种格式;Muse Connector 平台(2026-09-18 起)开放第三方连接器接入;Muse Code 编码 agent 可对接 Claude Code / Codex / OpenCode,可被第三方程序间接驱动。
- **强项**:分发与入口极强(WhatsApp / IG / Meta 账号直接触达;"上线 10 天登顶美区 App Store 免费榜""Meta 股价单月涨约 20%"为材料四口径、§8 清单无媒体来源条目,**待核实**,§4.14 已同步标注);执行与安全架构完整(持久 VM + Sentinel 模型外守门 + 一次性支付卡 + 审计日志,工程细节 §2.15);主动性强(跨应用连接器、后台持续任务、主动记忆与未请求建议 Active Memory / Active Focus)。
- **弱项**:隐私信任危机(多起越权访问报告——未经同意同步数据、读取私信;材料四称 WSJ 专文"有信任问题"、§8 清单无该报道条目,**待核实**);实操硬伤(2FA 保护的账户不可用、亚马逊拦截、CAPTCHA 卡死、日历时间出错、推荐已停业餐馆);覆盖受限("仅美加、后扩新加坡"与免费档周用量限额为材料四口径、清单无对应条目,**待核实**;订阅 Power $20 / 月、Maximum $100 / 月,锚 §8 已列 meta.com 订阅帮助页——审读实抓发布稿无定价)。

**Grok Bot(xAI)**
- **定位**:xAI 的个人 AI 代理家族:X 内置 Grok(导航栏 / @grok)与独立 App(grok.com / iOS / Android)是通用个人助理;2026-08-11 beta 推出的 Grok Bot 是『有自己云电脑的常驻 AI 队友』,订阅制(SuperGrok 等套餐——材料四原文"Cursor 系套餐"疑为转写笔误,Cursor 是第三方编码 IDE 不属 xAI 订阅体系;第三轮审读抓取 x.ai 被拒未能回源,**待核实**,疑似应为 Premium+ / SuperGrok Heavy 等档位,企业走 waitlist)。
- **架构**:消费端 DeepSearch 将查询拆解、并行搜索并综合,支持多 agent;API 端 Agent Tools API 提供服务端工具(X 搜索、网页浏览、远程代码执行、文档检索),模型自主决定、跨轮并行调用,全托管于 xAI 基础设施;Grok Bot 为每个 Bot 配独立云电脑,直接登录用户应用 UI 操作,无需 API / MCP,仅在需审批时中断。
- **会话**:记忆功能(2025-04 beta)跨会话记住偏好,可查看回答引用了哪些历史会话并逐条删除;Grok Bot 记住对话与偏好、可把演示过的工作流存为 routine 复跑;会话线程手机 / 桌面接续,Bot 间在群聊中共享上下文;模型侧上下文 2M(grok-4.1-fast,清单有 x.ai/news/grok-4-1-fast 条目);grok-4.7 的 500k 上下文无对应来源条目,**待核实**。
- **接入**:OpenAI 兼容 API(api.x.ai/v1):可用 OpenAI SDK、Python xai_sdk、@ai-sdk/xai 与 Responses API,含 tool calling / 结构化输出;Agent Tools API 按成功调用计费(约 $5 / 千次);另有 Voice / Imagine API;Grok Bot 本体无公开 API,仅 iOS / 桌面 App 内订阅使用。
- **强项**:独家实时 X 数据与社交情报,DeepSearch agentic 搜索基准(Research-Eval / FRAMES / X Browse)领先 GPT-5 与 Claude Sonnet 4.5 且 API 更便宜;每实例配独立云电脑、跨应用 UI 操作端到端交付,多 Bot 群聊协作(与 §6.3 CodeBuddy Agent Teams、本项目协作群互为多 agent 协作形态);记忆透明可控(查引用来源、逐条删除)。
- **弱项**:生态成熟度、企业集成与产品打磨不及 ChatGPT;新功能推送不均且地区受限(记忆初期排除欧盟 / 英国,Grok Bot 限高级订阅 beta 且用量单独计量);迭代激进有功能回撤(2026-07 有报道称 Grok 4.5 移除语音人格,**待核实**);依赖 X 数据的优势在非社交场景减弱。

**ChatGPT(Pulse / Agent Mode)**
- **定位**:OpenAI 的通用 AI 助手(App / Web / Atlas 浏览器),叠加 Agent Mode、Pulse 主动晨报与定时任务,是「主动个人助理」的事实标准形态。
- **架构**:闭源云端 harness:Agent Mode 由融合 Operator 与 Deep Research 的 agentic 模型驱动,在云端虚拟计算机中执行——图形+文本浏览器、终端、API 直连;登录 / 支付等敏感操作需批准,支持监看与接管;Pulse 夜间异步研究生成晨报。
- **会话**:记忆 = 保存记忆 + 引用历史聊天;Pulse 已并入统一 Scheduled Tasks 中心(2026-06);单会话可回溯,上下文压缩机制未公开;无并行多 agent。
- **接入**:消费端助手无官方 API 可被第三方驱动;程序化接入靠 Apps SDK(MCP 扩展,把交互式应用嵌入 ChatGPT)与 connectors;OpenAI API 属开发者产品线,与助手会话分离。
- **强项**:多渠道触达最广(App / Web / Atlas,曾借 WhatsApp 到达亿万用户);主动服务产品化最完整(夜间研究→晨报卡片→反馈闭环);连接器与应用生态规模最大(Apps SDK / MCP)。
- **弱项**:Agent Mode 额度低(Plus 40 次 / 月、Pro 400 次 / 月);闭源黑盒,上下文与记忆管理不可控;多渠道受平台政策钳制(因 Meta 政策 2026-01 退出 WhatsApp,清单有 openai.com chatgpt-whatsapp-transition 条目;"Atlas 亦被整合裁撤"无对应来源条目,**待核实**)。

**Manus**
- **定位**:独立创业公司(原 Monica 团队,公司主体 Butterfly Effect 属公开报道、本轮未单独核实)的云端通用 Agent:「给 Agent 一台云电脑」,自主执行研究、编码、生成应用等长任务并交付沙箱产物。
- **架构**:不微调模型,基于前沿模型(Claude 类)的 agent loop:模型从预定义动作空间选动作→云 VM 沙箱执行→观察追加回上下文;靠上下文工程驱动:KV-cache 命中率优先、append-only、todo.md 目标复述、logit mask 控制工具集、错误留上下文;Wide Research 以并行多 agent 处理批量任务。
- **会话**:append-only 上下文 + 文件系统当外部记忆,压缩可恢复(留 URL / 路径即可弃内容);Schedules 2.0(2026-05)支持定时 + 事件触发自动化;支持会话分享与中断续跑(细节**待核实**);任务中可补指令 steering。
- **接入**:官方 RESTful API(open.manus.ai 的 Create Task,单任务 prompt 约 5k token 上限);无 CLI 与本地 SDK;第三方程序可异步提交任务、取回产物,属可驱动型。
- **强项**:上下文工程方法论业界标杆(KV-cache、文件系统即上下文);云沙箱异步自主执行与产物交付最成熟;自动化(定时 / 事件)与 API 接入闭环完整。
- **弱项**:典型任务 50+ 次工具调用、输入输出 token 比约 100:1,成本与延迟高;依赖第三方前沿模型,无自有模型纵深;个人化 / 陪伴属性弱,更像任务执行器而非日常贴身助理。

**Genspark(Super Agent)**
- **定位**:Genspark(2024 年从 AI 搜索引擎转型)的「超级代理」个人工作台(Web / 移动),零配置全自动:能打电话、做幻灯片、生成视频、管理文档。
- **架构**:Mixture-of-Agents:"编排 9 个专用 LLM(模型池 30+)+ 80 余个工具"为材料四口径、§8 清单(Genspark 四条)无对应条目,**待核实**;电话功能双层架构——OpenAI Realtime API 实时对话 + shadow model 经消息队列监督纠偏;GPT-4.1 负责研究与严格 JSON 结构化输出。
- **会话**:SecondBrain 统一记忆:邮件、会议、文件、聊天与历史项目持续喂入,构建单一运行记忆;Second Brain Note(MagSafe 录音卡)把线下对话录入;产物沉淀为可复用项目资产。
- **接入**:C 端为主,Connectors & Integrations 管理第三方应用授权;"2025-11 成为 Microsoft Agent 365 启动伙伴"无对应来源条目,**待核实**;公开 API / SDK 未见(**待核实**),第三方程序化驱动受限。
- **强项**:多渠道触达独树一帜——AI 替用户真打电话(Call For Me 覆盖商家与个人电话;"与 Twilio 合作全球扩量"无对应来源条目,**待核实**);SecondBrain 记忆 + 硬件入口形成个人数据闭环;no-code 全自动,上手门槛最低。
- **弱项**:多模型编排成本高,可靠性依赖工具验证与打分;供应链依赖强(GPT / Twilio 等第三方);开放性不足,生态锁定在自家工作台内。

**星野 / Talkie(MiniMax)**
- **定位**:MiniMax 的 AI 陪伴双产品(星野 = 国内、Talkie = 海外),移动 App 沉浸式角色陪伴与 UGC 角色社区,曾是国内外 AI 陪伴下载量第一梯队。
- **架构**:基于 MiniMax 自研模型(文本+语音)的角色陪伴 harness:角色卡 + 人设驱动对话,提供重说 / 回溯 / 记忆 / 重启 / 评价 / 事件簿六个机制把叙事进程控制权交给用户(机制出处为搜索摘要引述的星野万字长文,未取原文链接)。
- **会话**:「记忆图谱」可视化持久记忆,被行业竞相效仿;Talkie 把对话沉淀为可收藏交易的星念卡片;Talkie+ 宣传「扩展记忆」但长对话记忆重置仍是 2026 年常见投诉;无任务型会话与并行概念。
- **接入**:纯 C 端 App,无 API / SDK 对外开放;个性化靠自建角色与音色形象,不可被第三方程序驱动。
- **强项**:自研模型 + 语音 / 形象一体,沉浸式陪伴体验完整;数百万 UGC 角色共创生态与卡片交易;情感付费意愿强(女性用户付费更高)。
- **弱项**:长对话记忆重置仍是硬伤;监管风险高(2024-12 Talkie 从美国 App Store 下架,星野整改下架大批擦边智能体);热度回落明显(2025 Q4 月活环比降约六成)。

### 2.15 Muse Sentinel「模型外守门」工程深挖(材料五)

> 一手来源:Meta 官方工程博客《How We Built Safety Into Muse》(2026-09-08,Tarek Sheasha,research.meta.ai)。补齐材料四遗留的 Sentinel 工程细节缺口;§7 建议 14 的落地形态据此具体化。

- **定位与信任边界**:Sentinel 是独立于 Muse 的宿主侧(host-side)agent,是「connector 动作 + 全部网络出站」的**唯一权限权威**(sole permission authority);Muse 只能 propose,不能自我审批、不能覆盖 Sentinel;官方架构母题是 "one box, two isolated security domains"——不是"带 root 的 LLM agent"。
- **两条拦截路径**:① Connector 路径——runtime cell 内调用 connector 工具 → 向 Sentinel 提交结构化请求(connector 标识、method、动作类别、scope、用户请求上下文)→ Sentinel 生成用户可见"用途说明"并对照用户 connector policy 判定;② 网络出站路径——所有请求经正向代理(Linux 网络控制面强制:userns、veth 边界、eBPF 过滤)→ Sentinel 在 L4+L7 双层评估(hostname、DNS 解析后最终目的 IP、端口、协议、HTTP method、path、**解码后的实际请求体**),内置 SSRF 限制(公开域名解析到私有基础设施即拦)。
- **凭据代换(surrogation)**:runtime cell 内代码只见 authd 铸造的 surrogate token;请求获准后 Sentinel 在**网络边界**才换成真凭据——prompt injection 逼 agent 交出真实密钥在原理上无效。
- **tainted egress 污点追踪**(治理审批噪音的关键):每个工具执行进程从 clean 状态启动,**一旦读取用户数据即被污染**;clean 进程命中窄边界 auto-allow 策略且通过出站 URL 检查的请求直接放行不打扰用户;tainted 或不可验证进程丧失 auto-allow、回落人工审批。实现:eBPF cgroup 程序做网络拦截与进程归因,外加挂到自制 Linux Security Module hook 的 eBPF 程序做污点传播。设计原则:read-only、已放行过、低风险动作不打扰用户,"把摩擦放在 consent 真正重要的地方"。
- **审批档位与状态(修正材料四)**:官方决策为**三档 allowed / denied / ask**;ask 时 Sentinel 创建 pending approval、执行停止,请求直达 Muse 客户端以**系统级 dialog**呈现(明确不是聊天消息),答复直接回传 Sentinel 并更新其权威审批状态(authoritative approval state);**批准即能力(capability)而非对话承诺**:严格绑定 connector/目的地 + 用例,**五种授权粒度:one-time、session-scoped、task-scoped、time-bounded、perpetual**,后续调用须精确匹配已授予 scope;pending approval 的持久化细节官方未披露(仅知权威状态在 Sentinel 侧、与 runtime cell 及凭据库隔离,durable 应用状态在独立 postgres)——**待核实**;材料四"四档"表述未在官方原文逐字出现,疑对应四层放行来源(窄边界 auto-allow → 正常 ask 流 → denied → connector policy 静态规则)。
- **进程拓扑(§7 建议 14 直接可抄)**:runtime cell 用 **systemd-nspawn**(cell 内 root 映射为宿主非特权用户、独立 rootfs、独立虚拟网卡、系统调用过滤禁 io_uring、裁剪 CAP_SYS_PTRACE / CAP_NET_ADMIN);cell 外安全服务各自独立 systemd unit:**hatch-safety**(独立模型/分类器组,检查进出核心模型推理的请求防 prompt injection)、**privsep**(最小权限执行内置 connector 逻辑)、**hatch-authd**(凭据存储 + surrogation)、Sentinel、推理/遥测代理;**全部 IPC 走 Unix domain socket + SO_PEERCRED + peer ACL**(内核认证的最小权限 IPC,无密钥可窃);浏览器 CDP 由 cell 外 broker 管理,浏览器子 agent 只见**可访问性树快照而非原始 DOM**、无脚本执行能力。
- **Confidential VM(用户自持密钥)**:当前版本仅靠运营策略限制 Meta 人员访问;Confidential VM 承诺"**密码学上且可验证地**"阻止 Meta 访问 VM 内数据,计划年内交付;已交小范围可信测试者、设计与源码向外部审计方开放,上线后将做任何人都可查看的持续审计;密钥托管位置 / 恢复机制 / attestation 协议 / 是否基于 TDX 或 SEV-SNP **官方未公开——待核实**。相关技术披露《Receipt-Gated Staged Execution for AI Agents》(TDCommons)PDF 被 Cloudflare 挑战页拦截,本轮未读原文,仅确认标题。
- **二手分析(标注单方陈述)**:impartment 营销博客称 Sentinel 是"意图与效果之间的授权层",弱点包括只保护 Meta 自家环境、Meta 同时拥有两端、审批疲劳(impart.ai)。

### 2.16 端侧触达:豆包手机助手与 SAEP 协议(材料五)

> 补齐材料四遗留的"端侧进手机(豆包)"缺口;对 §7 建议 15 与本项目 mobile 壳(Capacitor)直接相关,落地注记见末条与 §7 建议 16。

- **产品定位**:豆包手机助手被定义为**行业首款「系统级 GUI Agent」**:深度耦合 OS 底层而非孤立 App、与手机厂商合作获取系统级权限,UI-TARS 支撑跨 App 长链路任务(定义来自搜索聚合转载页,**原文未直接抓取,待核实**)。
- **进程与权限(第三方逆向分析,非官方,谨慎引用)**:四个系统进程 aivoice(语音入口)/ assistantaiagent(助手)/ aikernel(本地推理内核,Native 堆约 160MB,Binder RPC 系统级服务)/ autoaction(屏幕捕获 + 指令执行);关键权限均为 **signature 级**:READ_FRAME_BUFFER(直读 GPU 渲染缓冲)、CAPTURE_SECURE_VIDEO_OUTPUT(突破银行类 App 截屏限制)、INJECT_EVENTS(injectInputEvent 注入输入事件);获取途径要求系统签名 + 预装 /system/app;端云分工:每 3–5 秒上传一帧约 250KB 压缩屏幕图、云端返回约 1KB 指令;7 种指令集(打开应用 / 点击 / 输入 / 等待 / 滑动 / 记笔记 / 条件判断);虚拟屏用 DisplayManager.createVirtualDisplay(分辨率同物理屏、亮度恒 0 的 headless 模式、独立 layerStack,后台操作不干扰用户)。
- **SAEP 协议(官方一手,本轮实抓全文)**:SAEP = Screen Automation Execution Protocol(屏幕自动化操作声明协议),面向 GUI Agent 操作第三方应用的**声明协议**——把 App 保护要求转为机器可解析策略,系统在操作前完成 **Agent 身份校验(包名、签名、UUID、可信等级)+ 策略决策**。架构角色:Target App(声明边界)、GUI Agent(提交目标/动作/上下文)、身份认证、策略管理、动作执行、TEE 服务、日志管理、安全存储;**系统基线**(身份 / 能力 / 行为三类)优先于 App 声明与 Agent 自身判断;高风险动作(支付转账、账号认证、内容发布、删除、权限变更)可强制二次确认或拒绝。
- **声明格式与方式**:JSON,schema 固定 **"AGRP-Policy/1.0"**(Android GUI Robots Policy),顶层字段 schema / policy_version / package / updated_at / default_policy / scope。静态(推荐):策略文件放 **res/raw/agent_saep_policy.json** + AndroidManifest meta-data(`com.obric.agentrobots.POLICY_JSON`),系统在**安装 / 更新时读取缓存,不依赖 App 进程启动**;动态更新:ContentProvider `content://com.obric.agentrobots.provider/policy` 提交完整 JSON + 递增 version。
- **三级作用域**:App 级(global_disable / screenshot_disable / input_disable)、Activity 级(scope.activities.<完整类名>.page_scope)、Intent 级(scope.agent_intents,枚举 modify_content / post_content / delete_content / account_incentive 等)。
- **决策四档与规则语义**:ALLOW / BLOCK / CALL_USER / CLARIFY(CLARIFY 语义文档注明"以目标 SDK 为准");字段默认 true=限制,false 不代表最终允许(系统基线仍可拒);解析失败回退 default_policy 并记录原因;多规则命中**取更严格值**;版本单调递增禁止回滚;global_disable=true 最优先。BLOCK 须停止自动操作、向用户说明限制、**不得换通道绕过**;CALL_USER 暂停等确认,"确认只覆盖所展示的具体步骤"。
- **审计内建**:决策与执行均入审计链路,日志含 decision_outcome、reason_code(APP_POLICY_GLOBAL、SYSTEM_BASELINE 等)、agent_uuid、pkg_sha256、trust_level;App 只能查自身日志;留存 **60 天 / 100 MB / 10 万条**任一触发滚动删除。
- **接入六步**:RobotsHelperStub.isRobotsEnabled(Context) 检测 → 设定策略 → 静态声明 → 动态更新(可选)→ AgentManagerStub.listRegisteredAgents() / getAgentInfo(uuid) 查可信 Agent → SecurityAuditManagerStub.queryLogs(...) 查审计日志;当前示例多为反射调用,**正式 SDK 尚未发布**;Demo:GitHub bytedance/SAEP-demo、Gitee ByteDance/SAEP-demo。文档未提供页面元素语义标注接口与 deeplink 机制。
- **开放节奏(新闻二手,搜索摘要)**:30 天公示期后逐步放开三方操作权限;10-21 起对银行 / 支付 / 信托等金融类 App 主动限制自动化;此前 155 款主流 App 集体拒绝授权(openinstall 分析,**待核实**)。
- **与本项目 Capacitor mobile 壳的关联(落地注记)**:Capacitor 应用本质是标准 Android 工程——**静态接入路径完全可行**(res/raw 放 agent_saep_policy.json + manifest meta-data 即可参与 SAEP,无需原生代码改动),启动时 isRobotsEnabled 检测后回退;**粒度风险**:Activity 级 page_scope 以完整 Activity 类名为单位,Capacitor SPA 通常全部页面共用一个 MainActivity,**页面级细粒度控制在该协议下先天受限**——若需细分只能依赖 Intent 级声明或 H5 路由自建守门(后者为本文推断,非文档内容);备选路线:小米 MCP 协议 + 第三方 App 接入 SDK(知乎对比,搜索摘要,待核实)、火山方舟「豆包助手 API」企业服务与 developer.doubao.com 插件平台(搜索摘要,未抓取详情)。

---

## 3. 横向对比矩阵

### 表 1:编码 Agent——定位与接入

| Agent | 开源/形态 | Headless 入口 | SDK/协议 | 云端/后台任务 |
|---|---|---|---|---|
| Claude Code | 闭源 CLI(Node)+ IDE/桌面/云 | `claude -p`(text/json/stream-json、`--json-schema`) | Agent SDK(TS/Python,封装同一 CLI 二进制);任意语言子进程 | `--bg` 后台会话;云会话 / Remote Control / 企业网关 |
| Codex CLI | 开源 Apache-2.0(Rust) | `codex exec`(`--json` JSONL、`--output-schema`、`--ephemeral`) | TS/Python SDK(spawn CLI 走 JSONL);app-server JSON-RPC(实验);daemon / remote-control | exec 后台;daemon / remote-control |
| Copilot Agent | CLI 独立运行时 + IDE 模式 | `copilot -p` | Copilot SDK 六语言;ACP;BYO provider | `--cloud` 云沙箱跨 CLI/Mobile 接续 |
| Copilot coding agent | GitHub 云端服务 | REST / GraphQL issues API | Agent tasks REST API(preview,仅 user-to-server token);MCP assign_copilot_to_issue | 云沙箱 / Actions(59 分钟上限)/ Remote 三环境 |
| Cursor | 闭源 IDE + CLI + 云 | `cursor-agent -p`(print 模式上 CI) | Cloud Agents API v1(public beta,TS SDK、SSE);MCP(HTTP/stdio/OAuth) | Cloud Agents 隔离 VM;`&` 一键上云;自托管执行机 |
| Gemini CLI | 开源 Apache-2.0(TS) | `-p` + `--output-format json` | core 作 SDK;官方 GH Action;MCP 客户端 | 官方 GitHub Action 进 CI |
| Aider | 开源(Python) | `-m` / `--message-file` / `--yes` / `--dry-run` | Python API(非正式支持);无 HTTP API | 无 |
| OpenHands | 开源平台(企业版 + CLI + SDK) | CLI / TUI + headless | Python SDK + Agent Server REST;HMAC webhook | Enterprise Server 编排;webhook 接 GH / GitLab / Slack / Jira |
| SWE-agent | 开源(研究,维护模式) | sweagent run / run-batch;mini-extra swebench | Python 包 | run-batch 批量评测 |
| DeepSeek | 纯 API(无 harness) | —(接入方即 harness) | OpenAI / Anthropic / Responses 三协议 REST + `/beta` | — |
| GLM Coding Plan | 订阅 + 兼容端点 | 借用 Claude Code 等 harness | Anthropic 兼容端点 + 服务端模型名映射;官方 MCP | AutoClaw / AutoGLM 客户端 |
| Qwen Code | 开源全栈(TS) | `qwen -p` | TS/Python/Java SDK;daemon REST(OpenAPI);ACP;IM 通道 | GH Actions;钉钉 / 企微 / 飞书 / TG 通道 |

### 表 2:编码 Agent——会话 / 压缩 / 安全 / steering

| Agent | 会话持久化与恢复 | 上下文压缩 | 权限与沙箱 | Steering / 中途注入 |
|---|---|---|---|---|
| Claude Code | `~/.claude/projects/*.jsonl`;`--continue` / `--resume` / `--fork-session` / `--session-id`;`--bg` attach | auto-compact 可调(`/autocompact`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`)+ `/compact`;PreCompact 可 hook(材料一 lens-1 patterns) | 六档 permission-mode + allow/deny + canUseTool 回调;OS 沙箱可选默认关;企业托管策略 | stream-json 双向输入流实时注入;channels(MCP 推事件);SDK `interrupt()` |
| Codex CLI | `~/.codex/sessions`;resume / fork(picker / `--last` / UUID);`exec resume <id>` | `model_auto_compact_token_limit` + turn-end 百分比阈值;pre/postCompact 钩子 | OS 沙箱默认开启(Seatbelt / Landlock+seccomp / AppContainer 实验性);sandbox_mode × approval_policy 两维正交 | `/queue` 排队消息;app-server 协议中断 / 续转 |
| Copilot Agent | `--cloud` 跨 CLI / Mobile 接续 | 95% token 阈值(`/compact`、`/context`) | Manual / Assisted / Allow all + 作用域审批(Once/Session/Always)+ 正则 allowlist + OS 沙箱(自认 best-effort) | plan mode 先澄清;URL 请求/响应双段审批 |
| Copilot coding agent | session logs;@copilot 评论跟进;跨 surface 同步 | —(云端托管) | firewall allowlist + ruleset / branch protection;logs 不替代人工审查 | @copilot 评论追加;对任意 PR 叠开新 PR |
| Cursor | Checkpoints(独立于 Git);CLI ls / resume / `--continue`;`/goal` `/side` | —(材料未提) | Run Modes + permissions.json + hooks + CLI 沙箱(自认非安全边界) | 消息队列 + Steer(下次工具调用送达);API runs steer(202 返回 steered/queued) |
| Gemini CLI | GEMINI.md 层级记忆;`/chat save` / `resume`;checkpointing 默认关 | `/compress` | Seatbelt 或 Docker / Podman(`--yolo` 默认开)+ approval-mode | —(材料未提) |
| Aider | 无自动恢复;手动 `/tokens` `/drop` `/clear` `/compact` | `/compact` + repo-map 动态扩缩 | 无沙箱,git 自动提交兜底 | —(结对范式) |
| OpenHands | append-only 事件日志;PG / Redis / 对象存储 | Condenser(近窗口丢旧 + LLM 摘要) | 每会话 Runtime pod 沙箱 + warm 池 | —(材料未提) |
| SWE-agent | 无产品化恢复;history processor 每轮过滤 | history processor 裁剪旧观察 / 标记缓存点 | SWE-ReX 接 Docker / Modal 沙箱 | — |
| DeepSeek | 无服务端会话,客户端 harness 负责 | 客户端负责;cache_control 被服务端忽略 | — | Anthropic / Responses 协议支持历史中途注入工具调用 |
| GLM Coding Plan | 沿用所借 harness | `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` 透传 | 沿用 harness | 沿用 harness |
| Qwen Code | `/branch` `/resume` `/fork`;会话恢复;worktree 挂载;daemon 断线重连 | memory + context-cost | Sandbox + Plan Mode + Hooks | daemon 多客户端共享活跃会话 |

### 表 3:IM 平台——收发与流式

| 平台 | 收消息通道(免公网) | 原生 AI 流式 API | 发送频控 | 长连接约束 | 会话键 |
|---|---|---|---|---|---|
| 企微 | aibot WebSocket 长连接(aibot_subscribe)或 webhook(Token/AESKey 加解密) | req_id 透传 stream 流式上屏,10 分钟内须 finish | 单会话回复+推送合计 30 条/分、1000 条/时 | 单机器人仅 1 连接、新连踢旧连;30s 心跳 | 单聊/群聊;媒体仅单聊可收 |
| 钉钉 | Stream 模式反向 WebSocket(dingtalk-stream SDK)或 HTTP 回调(需公网) | AI 卡片 streamMode(创建 → streamingUpdate → 终止)+ typingAction | 自定义机器人 20 条/分(超限罚停 10 分钟);服务端 API 标准版 20 QPS | Stream SDK 纯出网 | conversationType 1 单聊 / 2 群聊;单聊仅企业内部应用机器人 |
| 飞书 | SDK 长连接(WebSocket 全双工,仅自建应用)或 webhook(验签解密) | CardKit v1 流式更新(卡片 14 天内可更新) | 同用户 5 QPS;同群全体机器人共享 5 QPS;自定义 webhook 100 次/分、5 次/秒 | 每应用 ≤50 连接;集群随机单点投递、不支持广播;事件 3 秒内须处理 | im.message.receive_v1(p2 事件模型) |
| Telegram | getUpdates 长轮询或 setWebhook(仅 443/80/88/8443、SSL) | sendMessageDraft(9.5+)/ sendRichMessageDraft(10.x);editMessageText 节流兜底 | 单 chat 1 msg/s、群 20 msg/min、广播约 30 msg/s;429 + retry_after;付费广播 1000 msg/s | 长轮询 / webhook 互斥 | chat id;群聊默认 privacy mode |
| Slack | Socket Mode(动态 WebSocket)或 Events API(30,000 events/ws/app/60min) | chat.startStream / appendStream / stopStream(2025-10;2026-04 streaming blocks) | chat.postMessage 每 channel 1 msg/s(允许短突发);429 + Retry-After | Socket Mode 免公共端点 | channel / thread |

### 表 4:OpenCode / Qoder / WorkBuddy / ZCode——官方侧补充画像(材料三,2026-11-07)

| 运行时 | 形态 | 服务化接口 | 协议 / SDK 面 | 版本节奏 | 本项目适配器路线(实测锚点) | 风险 / 机会标注 |
|---|---|---|---|---|---|---|
| OpenCode | 开源(sst 系,仓库已迁移) | `opencode serve` HTTP + OpenAPI 3.1(默认 4096、Basic 认证、SSE /event 与 /global/event、prompt_async / fork / revert、POST /mcp) | 官方 SDK(由 OpenAPI 生成)+ ACP(Zed 系;JetBrains 2026-10 接入) | 数天一发 patch + 组件拆分发版(v2.2.6,2026-11-06) | HTTP server + @opencode-ai/sdk + 手工覆盖 /global/event SSE(opencode-v2-transport.ts:9-13) | 官方 ACP 为未采用的替代集成面 |
| Qoder | 闭源(阿里) | Cloud Agents REST v1 Beta(Managed / Forward 双网关、Bearer PAT/SAT、4MB 上限、x-qoder-beta 头) | CLI(stdio ACP 契约)+ Agent SDK 三语言(可切云端代理)+ ACP | 独立 changelog 站;Qoder Lite $10/月上线 | CLI 进程 + stdio JSON-RPC(qoder-client.ts:55) | 官方 Cloud REST / SDK 未用,是适配器之外的新能力面 |
| WorkBuddy | 闭源(腾讯云 CodeBuddy Code) | HTTP API (Beta)、Daemon 模式、远程控制、Web UI、企微智能机器人接入 | Workflow stdio 协议 + ACP(工具代理 / 轮次 ID / Agent Teams 事件 / Multitask 守卫)+ Python/TS SDK | 两镜像不同步:workbuddy.ai v2.162.0 vs 腾讯云文档 v2.173.0(待核实) | NativeStdioChannel JSON 包 stdio 直连(workbuddy-client.ts:13) | 未走官方 ACP / HTTP / SDK 面;版本号引用需回源所引站点 |
| ZCode | 闭源(Z.ai ADE,与 GLM-5.3 联合调优) | 无公开 REST API / SDK(welcome 页未给出) | 桌面端内部 bridge(本项目逆向使用)+ Mobile Remote + Bot Channel(飞书/微信) | 约 1–2 周一发(3.17.2,2026-11-03) | 自研 NDJSON RPC app-server + desktop-bridge 借道桌面(zcode-desktop-bridge.ts:15/19/25) | desktop-bridge 描述符协议官方未文档化,升级兼容风险 |

### 表 5:个人助理 / 陪伴类 Agent——触达 / 记忆 / 主动性 / 信任边界 / 接入(材料四,含材料五更正)

> 编码 agent(表 1 / 表 2)的主轴是代码产出与仓库交互;个人 agent 的主轴换成触达、记忆、主动性与信任,故单列表 5。Muse 行信任边界已并入材料五更正(三档决策 allowed / denied / ask + 五种授权粒度、surrogation),与 §2.14 / §2.15 同口径。

| 产品 | 形态 | 触达渠道 | 记忆与个性化 | 主动性 / 后台 | 执行与信任边界 | 程序化接入 |
|---|---|---|---|---|---|---|
| Muse(Meta) | 消费级个人 agent(闭源) | iOS/Android/Mac App、muse.ai、WhatsApp;已宣布 Windows / 眼镜版 | 跨会话记忆面板(查看 / 编辑 / 遗忘);Active Memory / Active Focus | 关应用任务续跑(驻留 VM);主动回访与未请求建议 | 每用户专属 Secure VM;独立 Sentinel agent 模型外守门(三档决策 allowed/denied/ask + 五种授权粒度,§2.15);凭据代换 surrogation + 一次性支付卡 + 审计日志 | 本体无 API;Meta Model API(三协议兼容)、Connector 平台、Muse Code 对接编码 CLI |
| Grok Bot(xAI) | 常驻 AI 队友(订阅 beta) | X 内置、独立 App(iOS / 桌面 / 网页) | 记忆 + 引用溯源可查可删;工作流存 routine 复跑;多 Bot 群聊共享上下文 | 常驻云电脑持续任务 | 每 Bot 独立云电脑,直接操作应用 UI(无需 API/MCP),需审批时中断 | OpenAI 兼容 API + Agent Tools API(按成功计费);Bot 本体无 API |
| ChatGPT(Pulse / Agent Mode) | 通用助手 + agent 模式(闭源) | App / Web / Atlas;曾借 WhatsApp(2026-01 退出) | 保存记忆 + 引用历史聊天 | Pulse→统一 Scheduled Tasks 中心(2026-06),夜间异步研究 | 云端虚拟计算机(浏览器 + 终端 + API);登录 / 支付需批准,监看 / 接管 | 消费端无驱动 API;Apps SDK(MCP)+ connectors |
| Manus | 云端通用 agent | Web / App;API 异步提交 | append-only 上下文 + 文件系统外部记忆,压缩可恢复 | Schedules 2.0 定时 + 事件触发 | 云 VM 沙箱执行;任务中可 steering | 官方 REST API(Create Task,~5k token 上限);无 CLI / SDK |
| Genspark(Super Agent) | 个人工作台(C 端) | Web / 移动;AI 替身电话(Call For Me) | SecondBrain 统一记忆(邮件 / 会议 / 文件 / 硬件录音卡) | 全自动零配置执行 | 9 LLM + 80 工具动态路由;电话双层(Realtime + shadow model 纠偏) | 公开 API / SDK 未见(待核实);Connectors 授权管理 |
| 星野 / Talkie(MiniMax) | AI 陪伴(C 端封闭) | 移动 App(国内外双产品) | 记忆图谱可视化持久记忆;星念卡片交易;长对话重置仍是投诉 | 无(叙事陪伴) | 无任务执行;六机制把叙事控制权交用户 | 无 API / SDK,不可第三方驱动 |

### 表 6:个人 agent 记忆 vs 编码 agent 记忆——数据模型对照(材料五)

> 补齐材料四遗留的"记忆数据模型对照"缺口,直接支撑 §7 建议 13 的落地选型;来源链接见 §8 材料五分组。

| 产品 | 存储单元 | 引用溯源 | 逐条删除 |
|---|---|---|---|
| Muse(Meta) | 用户 VM 内可查看 / 编辑 / 下载的文件,官方帮助页明确含 **Memory.md** 及 Soul.md / Identity.md;另有「生活中每个人一页」per-person pages,由后台进程**约每小时**分析更新 | 第三方报道(WIRED 转述,系经 techtimes.co.uk 二手转引、清单未列 WIRED 原文):页面初始 sparse 逐步填充;溯源到「页面 / 条目」粒度的证据官方未公开(**待核实**) | 官方:Identity → Memory 直接编辑或删除 Memory 文件;可令 Muse 忘记某话题;Meta AI app 内 Settings → Memory 逐条删 |
| Grok(xAI) | 服务端记忆列表,无文件形态披露 | 回答标注引用了哪段过往对话;"Personalize with Memories"可查完整记忆清单 | 记忆条目图标逐条删除 + Data Controls 总开关;有分析指出删除粒度后演变为对话级 |
| Gemini CLI(GEMINI.md) | 三层 Markdown 拼接:`~/.gemini/GEMINI.md`(全局)→ 仓库 / 父目录 → JIT 子目录(工具触达时向上扫到 trusted root);`@file.md` import 支持相对/绝对路径;文件名可经 settings.json `context.fileName` 改(可配数组) | **无条目级溯源**——所有层级 concat 后随每次 prompt 整体下发,仅页脚显示已加载文件数 | 无逐条删除概念;靠手改文件 + `/memory show`(查看拼接结果)/ `/memory reload`(重扫) |
| Qwen Code(Auto-Memory) | **one-file-per-memory**:每条记忆一个文件 + MEMORY.md 紧凑索引;位置 `~/.qwen/projects/<project>/memory/`(按 worktree 隔离);团队记忆 `.qwen/team-memory/`(git 共享);`pinned/` 一级目录受保护;每文件可带 **frontmatter**(category、keywords、usage scenarios,结构化召回开关) | frontmatter 元数据 + `search_memory` 工具按需拉全文;**无对话级溯源**(与 Grok 相反) | `/forget <text>` 按描述匹配删除;`/remember <text>` 立即写;删除 `pinned/` 被工具边界封死;`/memory` 面板浏览文件夹 |
| Aider(repo-map) | **无持久记忆**:每轮按需从代码库派生有向图(tree-sitter 抽 definitions + references,文件为节点、引用为边);聊天轮次间缓存 | 无"记忆来源"概念;重要性来自 NetworkX PageRank + personalization(在聊文件高 restart 权重、被点名的标识符 +boost、已加聊天文件的出边 ×50、显式提及 / 长标识符 ×10) | 不适用;只受 token 预算约束(`--map-tokens` 默认 1k,未加文件时显著扩大) |

**对照结论(面向 §7 建议 13)**:
1. **存储范式三极**:单文件拼接(GEMINI.md / Muse Memory.md)vs 条目文件 + 索引(Qwen one-file-per-memory,天然支持逐条删除)vs 派生图(Aider,无持久化)。要"逐条删除 + 引用溯源",**Qwen 的条目文件 + frontmatter 是最接近可抄的数据模型**;Grok 的"回答标注来源对话"是溯源交互参照,但其服务端实现未公开(**待核实**)。
2. **溯源粒度谱系**:Grok = 对话级引用;Muse = 人 / 页面级 + 小时级后台进程(第三方报道);Qwen = frontmatter 元数据(无对话来源);GEMINI.md / Aider = 零溯源(纯拼接 / 派生)。
3. **加载预算先例**:Qwen 索引正文与 prompt 加载共享 **200 行 / 25,000 UTF-16 code units** 上限,超限整条跳过、不截断链接、文件尾部保留丢弃警告——可直接作为记忆面板预算策略。
4. **删除语义陷阱**:Qwen 明确「索引被省略 ≠ topic 文件被删」「手改索引会在重建后丢失」;Muse / Grok 则有产品级逐条删除 UI——落地时需区分「从 prompt 移除」与「物理删除」两种语义。

---

## 4. 共性设计模式与趋势

**接入与协议**

1. **Headless 与交互 TUI 同构**:交互入口之外都有 headless 入口(claude -p / codex exec / copilot -p / cursor-agent -p / qwen -p / gemini -p),以 JSONL 事件流输出、本地会话文件持久化、支持 resume 与 fork;Claude Code 与 Codex 的 hooks 生命周期事件名高度相似(preToolUse / sessionStart / stop / preCompact 等),互相借鉴明显。
2. **SDK = 子进程驱动 CLI,不重写 loop**:Claude Agent SDK 官方明说封装 Claude Code 二进制,Codex TS SDK 明说 spawn CLI 经 stdin/stdout 交换 JSONL——第三方驱动统一走进程边界,天然隔离宿主环境。
3. **程序化接入呈三层**:任务级 REST API(Copilot POST /agents/.../tasks、Cursor POST /v1/agents)→ 会话级 SDK(Copilot 六语言 / Cursor TS / Qwen 三语言)→ MCP 工具派活(github-mcp-server 的 assign_copilot_to_issue、PR 评论 @cursor)。
4. **IM 收消息免公网通道全平台普及**:企微 aibot 长连接、钉钉 Stream、飞书长连接、Slack Socket Mode、Telegram 长轮询,且与 webhook 基本互斥、连接数受限(企微单机器人 1 连接、飞书 ≤50)——webhook 网关不再是必需件。
5. **IM 流式回复统一演进**:从"占位消息 + 节流编辑"走向平台原生专用 API(钉钉 AI 卡片 streamingUpdate、飞书 CardKit、Slack chat.startStream、Telegram sendMessageDraft、企微 aibot stream 模式),2025 年起为明显趋势。

**安全与权限**

6. **权限哲学两大流派**:应用层(Claude Code:模式 + allow/deny 规则 + canUseTool 回调,由宿主程序当权限审批人)vs 系统层(Codex:OS 沙箱 + 审批策略两维正交,headless 用 sandbox+never 把安全交给内核);IDE 双雄收敛为"分级模式 + 确定性 allowlist + LLM 判官"三件套(Copilot:Manual/Assisted/Allow all;Cursor:Auto-review/Allowlist/Run Everything),双方文档均自认 best-effort 非安全边界,硬边界靠 OS 级沙箱。
7. **执行隔离按受众分化**:开发者 CLI(Gemini CLI、Aider)默认直接改本地仓库,靠 git 与 checkpointing 兜底;自主任务平台(OpenHands)强制容器沙箱并用 warm 池压冷启动成本。

**会话与上下文**

8. **上下文管理是 harness 分化最大的层**:静态 repo-map + token 预算(Aider)、事件溯源 + Condenser(OpenHands)、可配置 history processor(SWE-agent)、层级记忆 + /compress(Gemini CLI)是同一问题的四种答案;压缩都自动化、可配置且做成可 hook 的生命周期节点(Claude Code PreCompact / Codex preCompact)。
9. **会话持久化 + resume/fork 成标配,云端派活统一形态**:本地侧 JSONL/会话文件 + 命名 / 分叉 / 后台 attach;云端侧收敛为"任务 API + 独立分支 + PR 交付 + waiting_for_user 状态"(Copilot POST /agents/.../tasks、Cursor POST /v1/agents 跟进用 delivery:"steer")。
10. **工具形状影响成功率 + 研究侧反向简化**:"给模型专用接口而非裸 shell"成共识——SWE-agent 的 ACI(linter 门禁编辑、限行查看器)与 OpenHands 结构化 Action/Observation 事件流,与 Claude Code 精修内置工具是同一思路;mini-swe-agent 以 100 行达到与全量版相当的成绩,说明 harness 价值在接口与上下文设计,而非系统复杂度。

**模型侧(国产)**

11. **国产接入标准动作 = Anthropic 兼容 Messages API + 服务端模型名映射**:DeepSeek、智谱、Moonshot(Kimi 经 api.moonshot.cn/anthropic)均只需改 `ANTHROPIC_BASE_URL` 即可把 Claude Code 切到自家模型。智谱把"借 harness"做成商业模式(订阅 + 映射文档 + 工具白名单 + AutoClaw 收口),DeepSeek 反向选择纯 API 路线;阿里是唯一自研全形态框架的厂商。会话与上下文管理能力都在 harness 侧而非模型侧(DeepSeek 无任何服务端会话语义,连 cache_control 都被忽略);Coding 订阅计费从按次 prompts 转向 token 积分制 + 5 小时滚动窗口 + 非高峰五折;agent 场景的 API 缺口(如中途注入工具调用)靠补 Anthropic / Responses 协议解决而非增强 OpenAI 协议(DeepSeek 官方明确建议)。

**IM 接入架构**

12. **AI Agent 接入五层固定模式**:平台适配层(webhook / 长连接收消息)→ 会话映射(平台 chat/thread → Agent session key)→ 单会话串行队列(去抖 / 排队防并发编辑)→ 流式适配器(原生流式 API 优先、节流编辑兜底)→ 频控退避层(429 / Retry-After 重试)。频控共同规律是"收严发宽":发送普遍压到单会话 1 条/秒量级(企微 30 条/分/会话、钉钉自定义 20 条/分、飞书同群 5 QPS、Telegram 单 chat 1 msg/s、Slack 1 msg/s/channel);群聊 / 单聊差异集中在消息可见性、能力限制、会话键三处。

13. **ACP(Agent Client Protocol)正在成为第三方 harness 接入的第二标准面**(补充轮):OpenCode 原生 ACP(JetBrains AI Assistant 2026-10 接入)、Qoder CLI 列 ACP、WorkBuddy `codebuddy --acp` 原生 ACP 服务端且扩展了轮次 ID / 工具代理 / Agent Teams 事件;与 MCP(工具面)相对,ACP 解决的是"客户端驱动 agent 会话"面——本项目 8 个适配器中 qoder(stdio ACP 契约)恰处在这条收敛线上,workbuddy 的 stream-json 方言与 opencode 的 HTTP+SDK 路线则是尚未对齐的两例。

14. **个人 agent 把"主动性、记忆、信任、触达"产品化为主轴**(材料四):主动性收敛为「后台异步执行 + 定时控制中心」——ChatGPT Pulse 并入 Scheduled Tasks(2026-06)、Manus Schedules 2.0 支持定时 + 事件触发,主动推送统一由用户可管理的任务面板控制;长期记忆从设置项升级为基础设施,且普遍允许查看与修正(星野记忆图谱、Genspark SecondBrain、Grok 的"引用溯源 + 逐条删除"、Muse 记忆面板);执行信任边界趋同「云端沙箱 + 监看 / 接管 + 敏感操作审批」(ChatGPT Agent Mode 虚拟计算机、Manus 云 VM、Muse Secure VM)——与编码 agent 的 OS 沙箱流派(§4.6)同向,但守门者从内核 / 规则升级为独立模型(Muse Sentinel 模型外守门);多渠道触达出现三条路线(App/Web/浏览器、AI 替身电话 Genspark Call For Me、端侧进手机豆包),而陪伴类仍困在 App 内——"触达广度与情感深度呈负相关"系由星野 / Talkie 与 Muse / Grok 两三例归纳的初步观察(反向张力假设,非统计结论)。IM 渠道是个人 agent 的分发咽喉:Muse 靠 WhatsApp 直达("上线 10 天登顶美区 App Store 免费榜"为材料四口径、待核实,§2.14),ChatGPT 因 Meta 政策 2026-01 退出 WhatsApp——与 §2.12 / §4.4-5 / §4.12 的 IM 生态结论(渠道即入口、主动推送受 24h 窗口约束)互为印证。

15. **个人 agent 接入两极分化,"人—agent—专属 VM"三层架构出现**(材料四):任务执行型开放生态(Manus REST API、ChatGPT Apps SDK / MCP、xAI Agent Tools API、Meta Model API 三协议兼容)vs 陪伴型完全封闭(星野 / Talkie 无 API);架构上 Muse 与 Grok Bot 均采用「人—agent—专属云端 VM」三层设计:agent 不住手机而住每用户隔离 VM,多端(App / 网页 / IM)只是同一驻留体的入口,关应用任务继续——与本项目 broker detached 进程(§5.5)形态同构,只是驻留体从本机 broker 换成云 VM;Grok Bot 的多 Bot 群聊共享上下文与"演示一次存为 routine"自动化,与 §6.3 的 CodeBuddy Agent Teams、本项目 CollaborationService 互为对照。

16. **动作边界的下一层收敛:守门工程化 + 声明式策略**(材料五):Muse Sentinel 把"模型外守门"做成可复制的进程拓扑(systemd-nspawn cell + 独立安全 systemd unit + Unix domain socket SO_PEERCRED 内核认证 IPC + surrogation 凭据代换,§2.15),并用内核级污点追踪(tainted egress)治理审批噪音——"把摩擦放在 consent 真正重要的地方";端侧则出现声明式策略协议 SAEP(AGRP-Policy/1.0 JSON):App 声明三级作用域(App / Activity / Intent)、系统四档决策(ALLOW / BLOCK / CALL_USER / CLARIFY)、审计内建(60 天 / 100MB / 10 万条滚动删除,§2.16)——与 §4.6 的"应用层审批 vs OS 沙箱"两流派合流为"守门进程 + 声明策略"的第三形态;对照本项目:审批目前是 harness 内 request-approval(§5.2),两条路线都指向 broker 侧独立守门与声明式能力边界(§7 建议 14、16)。

17. **记忆数据模型三极与溯源粒度谱系**(材料五):个人 agent 与编码 agent 的记忆收敛为三种存储范式——单文件拼接(GEMINI.md / Muse Memory.md)、条目文件 + 索引(Qwen one-file-per-memory + frontmatter)、派生图(Aider repo-map,无持久化);溯源粒度从对话级(Grok)到零溯源(GEMINI.md / Aider)成谱系(表 6);"加载预算"(Qwen 200 行 / 25k code units 先例)与"从 prompt 移除 ≠ 物理删除"是记忆面板的两个必答题——支撑 §7 建议 13 的选型。

---

## 5. 本项目实现现状摘要(customer-agent / AgentRoam)

> 本章内容来自材料二(项目现状 JSON),关键 file:line 已按 §5.7 抽查校正。

### 5.1 分层与包

TypeScript + Bun monorepo,把本机 AI Agent 统一进一个可远程访问的工作台:自研 customer-agent ReAct 引擎与 8 种外部运行时(codex / claude-code / opencode / deepseek-harness / qoder / zcode / workbuddy / copilot)共享同一套会话、事件与控制协议。

| 包 | 角色 |
|---|---|
| packages/core | 领域引擎(无 UI):AgentLoop ReAct 循环(domain/agent/AgentLoop.ts:133,AutoCompact 阈值 0.6、steer/mailbox)、模型/工具/技能/MCP/LSP 注册表、SQLite 存储、协作群 / 监督 / 并行会话 / 目标队列领域、SSE 帧协议 |
| packages/native-runtime | 外部运行时适配层:9 种 AgentType 中除 customer-agent 外的 8 个适配器 + UnifiedSessionService + NativeRuntimeBrokerHost/Client(unix socket 单写者,native-runtime-broker.ts:101/1395/2535) |
| packages/messaging | IM 消息接入领域包:intake → 识别(recognition)→ 路由(routing)→ 执行(dispatch,经 Execution 端口)→ 回发(delivery),当前渠道为企业微信(channels/wecom,python reader/sender 驱动本地库,assets/wecom/{reader.py,native_sender.py,codec.py}) |
| packages/server | Next.js 14 中心服务 + ws-server.mjs:REST/SSE API、按会话 ID 前缀路由到 broker 或 agent-host、协作 / 监督 / 并行会话 / 消息接入服务组装、PTY WS、配对鉴权、AIHub 中继、远程控制 |
| packages/webapp | React PWA:会话 / 终端 / 远程桌面 / 群聊 UI,经 agent-http-gateway(infrastructure/http/agent-http-gateway.ts:71-87)调 run / stream / steer / abort / answer |
| packages/desktop | Electron 壳:AIHub 内嵌浏览器驱动、语音、远程桌面采集/输入(webrtc-live)、配对;main/shared-service.ts 经 HTTP + desktop token 访问本地 server(不再直连 broker) |
| packages/mobile | Capacitor Android/iOS 壳:打包 webapp 产物,远端 server 地址、扫码配对、安全存储 |
| packages/sdk | Lit 3 Web Components 嵌入式 SDK:<agent-chat> / <agent-fab> + HTTP/SSE 客户端,仅消费 server 协议 |
| packages/cli | agentroam 启动器:平台 Node 运行时启动 server、Cloudflare/Pinggy 隧道、launchd/计划任务服务化、一次性配对码 |

支撑包:computer-use、voice-service、phone-agent、tui、website 及 cloudflared-* / runtime-* / tui-* 预编译二进制包。运行:`bun run dev` 同起 core / messaging / server / desktop;发布形态 `npx agentroam` 常驻服务 + HTTPS 隧道。

**维护提示(材料二)**:docs 两文(2026-07/09)已落后代码——broker 与适配器已从 desktop/main/agent-runtime 下沉到 packages/native-runtime,messaging 已独立成包,适配器由 4 种扩为 8 种。

### 5.2 两条消息流

- **客户端线**:webapp / desktop / mobile 经 HTTPS 调 `POST /api/agent/run`;route.ts:59 调 startRun,**`runtime:` 前缀分流实际经 isNativeSessionId 判定**(native-runtime-service.ts:653-658 定义、startRun 链内消费)——`runtime:` 前缀走 NativeRuntimeService → Broker → 各适配器(codex 等),否则走 server agentHost 内的 customer-agent AgentLoop(审读修订:材料二原写 route.ts:61,实测该行是 reasoningEffort 参数展开行,非分流点);native 事件经 agentHost.publishExternal 统一复用,`GET /api/agent/stream` 以 SSE(runId:sequence 游标 + 快照重放)回传 UI。
- **IM 线**:企微本地库经 python reader 采集进 messaging 包,识别路由后 ServerMessagingExecution 强制 request-approval 并 enqueueMessage 进同一 runtime,结果经 native_sender.py 写回企微。
- ws-server 同端口另载 PTY / 远程桌面 / AIHub。

### 5.3 会话 / 并行 / 协作 / 监督

- **统一会话 ID**:native 会话为 `runtime:<agentType>:<base64url(nativeId)>`,customer-agent 为本地 SQLite 会话(agent-runtime/session-id.ts:9-19,实测与该实现一致)。
- **持久化与恢复**:目标队列与排队消息持久在 broker 侧(enqueueSessionGoal / enqueueSessionMessage);断线续跑、换设备 handoff / 快照续看。
- **并行会话**:≥2 个不同 agent 在同一 cwd 各建独立会话组成组,转录留在各自 runtime(core/domain/session/ParallelSessions.ts:6-14,实测为 ParallelSessionGroup 接口;server/lib/parallel-sessions.ts)。
- **协作群**:CollaborationService 编排群主拆解 / 成员执行 / mention 路由,任务按需用 git worktree 隔离(server/lib/collaboration/runtime.ts:32-59),成员 30 分钟超时。
- **监督**:SupervisionService 每 10s 巡检、60s 验证、最多 2 次自动恢复(**实测路径为 packages/core/src/application/supervision/SupervisionService.ts:6-9,CHECK_MS=10_000 / VERIFY_MS=60_000 / MAX_RECOVERIES=2**);决策 observe / complete / continue / handoff / decision(**实测 core/src/domain/supervision/types.ts:36-41**);server 端单例每秒 tick(lib/supervision/service.ts:10-11,实测吻合);全程落 SupervisionMessage / Incident。

### 5.4 八个外部 runtime 适配器现状

| 运行时 | 接入方式 | 主要缺口 | 关键文件 |
|---|---|---|---|
| codex | JSON-RPC app-server 协议,三种启动模式依次回退:复用 Codex Desktop 端点 → `app-server daemon start`+proxy → `app-server --stdio`;配合 ~/.codex/sessions rollout JSONL、会话兼容性服务(readerVersion 0.153.0)、Windows desktop app-tools 桥与桌面续跑通道;二进制经 AGENT_CODEX_BIN / resolveExternalCli 解析 | 只支持 archiveSession 无 delete(codex-runtime-adapter.ts:1223,实测吻合);占用判定是 advisory(native-runtime-broker.ts:1721),桌面占用会话靠 fork-and-forward 补偿;线程首次 turn 前不在 thread/list,需 server 端 pendingCreations 投影(packages/server/lib/native-runtime-service.ts:170);历史图片内联曾达 30MB/14s,靠 1.5MB 字节预算截断降级(codex-runtime-adapter.ts:84,实测为 CODEX_CORE_INLINE_IMAGE_BUDGET_BYTES=1_500_000) | codex-runtime-adapter.ts、codex-app-server-client.ts、codex-app-server-launcher.ts、codex-session-compatibility.ts、codex-rollout-activity.ts |
| claude-code | 直接内嵌 @anthropic-ai/claude-agent-sdk(query / listSessions / forkSession / deleteSession 等),事件经 AsyncEventQueue 投影;历史读 ~/.claude 转录 JSONL 并自实现分页与查询索引。能力面最完整:fork / delete / steer / getSessionPaged / getQueryIndex 全有 | 模型列表靠静态别名 sonnet/opus/haiku 兜底,supportedModels 仅在 live Query 上可得(claude-runtime-adapter.ts:92-96);转录 cwd 扫描有 2MB 上限(TRANSCRIPT_CWD_SCAN_LIMIT),超限历史识别受限 | claude-runtime-adapter.ts |
| deepseek-harness | 经 dsh 的 HTTP RPC + WebSocket remote.mux 流:先借已有桌面/Web Host,否则 spawn `dsh web --port 0` 并在空闲时 handoff 回桌面;凭证走 dsh 输出的 cookie;支持原生 goal(goals/create-edit-cancel 乐观并发)、权限预设(经 commands/execute `/permission`)、agentPresets 模式、后台 job 列表/输出/停止、subagent 子会话地址 | 无 fork / delete / getSessionPaged / getQueryIndex / getSessionToolResult;全量历史靠 session/page 手工回溯(adapter:141-166);子会话 one-shot 只读、不能单独换模型/设目标;权限与模式切换要求 writer 激活且仅 blank 会话可切模式(adapter:190-222);正在修复历史消息顺序(见 §5.7) | deepseek-harness-runtime-adapter.ts、deepseek-harness-client.ts、deepseek-harness-codec.ts、deepseek-harness-endpoint.ts、deepseek-harness-jobs.ts |
| copilot | 复用运行中的 VS Code Agent Host:只读发现 owner-protected 本地 socket 端点(copilot-vscode-discovery.ts),用官方 @microsoft/agent-host-protocol(AHP 1.x)经 WebSocket 订阅 ahp-root / session / chat 频道,reducer 维护状态;发送等宿主 authoritative echo、绝不重发不确定写入;占用 / 权限 / 模型 / 凭证全部留在 VS Code | reasoningEffort 明确不支持、getSessionWatchPath 恒为 null、canDelete=false;只读 / 隐藏会话拒发(copilot-client.ts:223,298);依赖 VS Code 版本支持 AHP 1.x,旧协议 / 失效窗口直接剔除;审批语义实测:反射原生请求、never auto-approve(copilot-approvals.ts:15 注释),权限选项"跟随 VS Code"(copilot-client.ts:103,nativePermissions.currentValue;**审读修订**:材料二原写 adapter:103 失效——copilot-runtime-adapter.ts 全文仅 29 行且无 approval 字样);2026-11-04-copilot-session-recovery.md 记录审批恢复、插入消息被提前消费、重复轨迹等刚修复的问题 | copilot-runtime-adapter.ts、copilot-client.ts、copilot-ahp-connection.ts、copilot-vscode-discovery.ts、copilot-approvals.ts |
| zcode | 自研严格 NDJSON RPC over stdio:`zcode app-server`(resolveNativeCliCommand 从 .app 包 zcode.cjs / PATH 解析,注入 ZCODE_*_PROVIDER_CONFIG_FILE);session/subscribe + session/send 可回放事件流、AskUserQuestion 工具转审批卡、ZCodeSteering 中途插话、ZCodeDesktopBridge 读桌面运行状态并对桌面自有会话做纯文字 external guide | fork / delete / getSessionPaged / getQueryIndex 均无(走 in-memory 分页回退);native mode 切换注释写明 "intentionally not exposed"(zcode-client.ts:138);桌面 external guide 仅文字,图片和 goal 均抛 OPERATION_NOT_SUPPORTED(zcode-client.ts:259-260);插话 / 问答依赖 10 分钟超时兜底(zcode-client.ts:363);连接失败即清空模型缓存与 loaded/resumes(zcode-client.ts:91-94) | zcode-runtime-adapter.ts、zcode-client.ts、zcode-steering.ts、zcode-desktop-bridge.ts、native-cli-command.ts |
| qoder | stdio ACP 契约:`qodercli --acp`(AGENT_QODER_BIN 可覆盖),经 NativeRpcClient 请求/通知;工作区目录与历史分别由 QoderWorkspaceCatalog、QoderSessionHistory 旁路读取;adapter 仅继承 StdioNativeRuntimeAdapter,无任何覆写 | 无 steer / fork / delete / 分页 / 查询索引;凭证注释明确 "No CA provider profile or native credential is copied";运行中插话等增强依赖 native 侧能力,当前只有权限审批回调 | qoder-runtime-adapter.ts、qoder-client.ts、qoder-workspace-catalog.ts、qoder-session-history.ts |
| workbuddy | Claude Code 风格 stream-json 但"不是 ACP":`codebuddy --print --input-format stream-json --output-format stream-json --include-partial-messages`,每 run 独立 NativeStdioChannel,控制应答按 response.request_id 关联;会话目录 WorkBuddySessionCatalog 读取;注入 CODEBUDDY_FORCE_LITE_WB_BUNDLE 与桌面产品配置 | 无 steer / fork / delete;zero-token 本地认证失败需逐条字符串匹配才转 AUTHENTICATION_* 错误(workbuddy-client.ts:39-46,实测吻合);macOS 上若桌面配置未加载直接拒绝运行(native-cli-command.ts:98-100) | workbuddy-runtime-adapter.ts、workbuddy-client.ts、workbuddy-session-catalog.ts、workbuddy-desktop-config.ts |
| opencode | spawn 常驻 `opencode` server(OpenCodeServerClient),经 @opencode-ai/sdk + v2 传输层调用,全局事件流监听权限 / 问题 / 中断;支持分页历史、查询索引、fork、steer;版本下限 1.18.27 与 CLI 同步(opencode-runtime-adapter.ts:65) | 依赖 PATH 中 opencode 可执行;AGENT_OPENCODE_RUNTIME_ERROR 缺失时以 spawn ENOENT 兜底诊断(server 端 applyRuntimeError);无 delete / archive;权限 / 问题卡片走自研 question 协议(OPENCODE_QUESTION_ASKED / RESOLVED),与官方协议演进有耦合 | opencode-runtime-adapter.ts、opencode-server-client.ts、opencode-v2-transport.ts、opencode-v2-codec.ts、opencode-questions.ts |

> 注:上表中 opencode / qoder / workbuddy / zcode 四家的官方侧画像、服务化接口与升级风险标注见 §2.13 与 §3 表 4(补充轮新增)。

### 5.5 共享基础设施

- **统一端口**:AgentRuntimeAdapter 统一端口 + RuntimeSessionError 错误码体系(types.ts:219-306);8 个 adapter 在组合根 createNativeRuntimeBrokerHostRuntime 注册(native-runtime-broker.ts:3020-3066,实测函数签名在 3020 行)。
- **Broker**:detached 独立进程持有 Unix socket(win32 命名管道)native-runtime.sock,SQLite 持久化 run / 占用锁(occupancyRevision)/ goal 与消息队列 / 导入工作区,web/desktop 双 controller 与 handoff,断线重连靠 snapshotRevision + runId(native-runtime-broker.ts 共 3708 行,实测吻合)+ detached-native-runtime-host.ts 锁文件单实例。
- **StdioNativeRuntimeAdapter 公共门面**:workspace 由 cwd/parent 链推导、draft 恢复、running 集合、占用投影,被 zcode / qoder / copilot / workbuddy 复用;AsyncEventQueue / image-input / native-rpc-client / native-stdio-channel / resolveNativeCliCommand(覆盖变量为 **AGENT_QODER_BIN / AGENT_ZCODE_BIN / AGENT_WORKBUDDY_BIN 三变量**——native-cli-command.ts:20 的 OVERRIDES 常量;app bundle 探测 + node 包装走 AGENT_NATIVE_NODE_BIN,native-cli-command.ts:105)为通用进程/协议件。**审读修订(2026-11-07)**:材料二原写的合并变量 AGENT_QODER_ZCODE_WORKBUDDY_BIN 全仓 grep 命中 0(仅本文档自身),照配不生效,已更正。
- **UnifiedSessionService + AgentWorkspaceIndexService**:adapter 注册表、详情缓存、分页(offset cursor)与 Codex 会话兼容性补充;core 侧提供 AgentType 注册表(core/src/domain/agent/agent-type.ts)、AgentEvent / Message 模型、SessionHistory / SessionQueryIndex / SessionQueryIndexCache、mergeReasoningSummaryDelta。
- **消费端统一入口**:packages/server/lib/native-runtime-service.ts(NativeRuntimePort + 错误→HTTP 状态映射 + pendingCreations)与 packages/desktop/main/agent-host.ts、main/ai-hub/relay.ts;messaging 包仅在 domain/routing、model-router 消费 AgentType 做项目/Agent 路由。

### 5.6 痛点(材料二原文转写)

1. **投影调和逐 agent 特判堆积**:mergeProjectionMessages 内逐 agent 特判持续堆积——preserveNativeOrder 现覆盖 harness + qoder + zcode + workbuddy + copilot(native-runtime-broker.ts:3159,实测吻合),zcode 还要过滤旧版 AskUserQuestion 原始工具(native-runtime-broker.ts:3158-3204),刚为 harness 加了 text_done / tool_result 重置逻辑——每个新 runtime / 协议变化都改这一处。
2. **外部桌面占用治理是反复出问题的主轴**:codex 占用 advisory + fork-and-forward、zcode external-guide 纯文字桥、copilot "占用不算锁"——三个计划(2026-11-05-zcode-desktop-guide-bridge、2026-11-04-zcode-mid-turn-steering、2026-11-05-zcode-interruption-message-refresh)都在补"不能产生第二个 resident / 不重发不确定写入"的约束。
3. **发送链路时延与稳定性**:2026-11-05-codex-send-latency(目录刷新导致连接超时 / 重复扫描)、2026-11-05-remote-desktop-latency(仍有未完成 checkbox)、2026-11-04-mobile-session-list-performance;Codex 历史图片负载曾实测 30MB/14s,靠硬编码字节预算缓解。
4. **跨端状态恢复对账复杂**:2026-11-05-codex-mobile-questions(手机刷新后异步问答状态)、2026-11-04-copilot-session-recovery(审批 / 插入消息 / 重复轨迹)、2026-10-26-agent-rail-native-runtimes——运行态在 broker 快照、原生历史与各端缓存间的对账复杂度高。
5. **能力面极不均衡且不可发现性弱**:codex / claude / opencode 有分页 + 索引 + fork,其余只能整段 getSession 内存分页;copilot / harness 的模型与权限规则各不相同,最终大量以中文报错串硬编码在 adapter 内(OPERATION_NOT_SUPPORTED / SESSION_OCCUPIED 场景),且 qoder / workbuddy / zcode 各有一套 stdio 方言需逐个适配。

### 5.7 本次代码抽查记录(实测,非材料转写)

命令:`for f in <27 个材料引用文件>; do [ -f ... ]`、`sed -n '<行段>p'`、`grep -n`、`wc -l`、`git diff --stat`(2026-11-07 执行)。结果:

- 27 个引用文件中 26 个存在;唯一 MISSING 是材料所写 `packages/server/application/supervision/SupervisionService.ts`,实际位于 **packages/core/src/application/supervision/SupervisionService.ts**(行号 5-8 → 实测 6-9 为 CHECK_MS/VERIFY_MS/MAX_RECOVERIES 常量,数值 10s/60s/2 与材料一致)。
- native-runtime-broker.ts 实测 3708 行(与材料一致);session-id.ts:9-19(base64url 统一会话 ID)、ParallelSessions.ts:6-14(组接口)、broker:3020(组合根)、broker:3159(preserveNativeOrder 五家特判)、codex-runtime-adapter.ts:84(1.5MB 图片预算)与 :1223(archiveSession)、workbuddy-client.ts:39-46(逐条字符串匹配认证错误)、agent-http-gateway.ts:71-87(run/stream/steer/abort/answer 网关)均实测吻合。
- 监督决策枚举实测在 core/src/domain/supervision/types.ts:36-41(observe / complete / continue / handoff / decision),材料标注 26-32 有数行漂移。
- harness 消息顺序修复实测:未提交 diff 存在(git diff --numstat:deepseek-harness-codec.ts **+11/-1**,native-runtime-broker.ts **+11/-3**;**审读修订**:本文首版误把 git diff --stat 的总变更行数 12/14 写作增删行数,已按 numstat 口径更正);`__native_harness_context` 标记实测在 codec.ts 出现 1 次、broker 0 次;`.superpowers/plans/2026-11-07-harness-message-order.md` 存在,且有未跟踪测试文件 deepseek-harness-message-order.test.ts。
- messaging 企微 Python 件实测:packages/messaging/assets/wecom/{reader.py, native_sender.py, codec.py} 存在,与材料"python reader/sender 驱动本地库"一致。
- 补充轮代码锚点复核(2026-11-07,材料三声称实读的 6 处,`sed -n` / `grep -n` 实测):实质内容全部吻合,但行号全部漂移,已按实测修正——opencode-v2-transport.ts:createOpencodeClient 在 :9(材料三写 :4)、legacy SSE 注释在 :10(写 :8)、手工覆盖 global.event 走 /global/event 在 :11-13(写 :9-10);qoder-client.ts:new NativeRpcClient(() => resolveNativeCliCommand("qoder")) 在 :55(写 :8,:8 实为 import 行);workbuddy-client.ts:channel: NativeStdioChannel 在 :13(写 :8,:8 实为 import 行);zcode-desktop-bridge.ts:Descriptor `{version: 1; protocol; hostId; pid; port; token}` 在 :15、"Borrow the desktop owner. This client never resumes or spawns its session." 注释在 :19、`~/.zcode/v2/desktop-bridges` 目录在 :25(材料三写 :21 / :23-24 / :30)。
- 审读修订复核(2026-11-07 第二轮,`grep -rn` / `sed -n` / `wc -l` / `git diff --numstat` / `claude --help` 实测):AGENT_QODER_ZCODE_WORKBUDDY_BIN 全仓命中 0,OVERRIDES 实测在 native-cli-command.ts:20、AGENT_NATIVE_NODE_BIN 在 :105(审读意见写 :24,亦有漂移);copilot-runtime-adapter.ts 共 29 行、approval 匹配 0,copilot-client.ts:103 为 nativePermissions"跟随 VS Code",copilot-approvals.ts:15 为 never auto-approve 注释;numstat 实测 11/1 与 11/3;route.ts 的 startRun 调用在 :59,isNativeSessionId 定义在 native-runtime-service.ts:653-658;claude 2.1.319 --help 的 permission-mode choices 为 acceptEdits / auto / bypassPermissions / manual / dontAsk / plan。外部复核:github.com/deepseek-ai/deepseek-harness README 实抓(dsh 三条英文原句),docs.github.com 现行 Agent Merge 页实抓(无材料三逐字引文)。

---

## 6. 逐项对比:本项目 vs 业界

> 路由说明:本表以编码 agent 与 IM 平台为主要对照面;材料四 / 五(个人 agent)的对照已并入 §4.14-17 与 §7 建议 12-16,下表仅补两条受其直接影响、且与本项目现状强相关的维度行(长期记忆、审批 / 守门)。

### 6.1 对比总表

| 维度 | 业界代表做法(材料一) | 本项目现状(材料二) | 判定 |
|---|---|---|---|
| 统一多 runtime 抽象 | 无对等物:各家 SDK / 协议互不兼容,第三方只能逐家对接 | AgentRuntimeAdapter 统一端口 + 错误码体系,8 个 runtime 共享会话 / 事件 / 控制协议,Broker 统一持久化与断线重连 | **领先** |
| 监督巡检 | Copilot Agent Merge "Watch and fix"(现行文档:监视选定的 Actions 失败 / 合并冲突阻塞项并自动开工;59 分钟单仓库上限为材料一口径,"批准前不触发 workflows"待复核,见 §6.3-5);Anthropic Managed Agents 把"事件日志 + 无状态 harness"做进平台层(非巡检语义) | SupervisionService:10s 巡检 / 60s 验证 / 最多 2 次自动恢复,5 种决策(observe/complete/continue/handoff/decision),全程落 SupervisionMessage / Incident | **领先(已有同构对照,见 §6.3)** |
| 多 agent 协作 | CodeBuddy/WorkBuddy Agent Teams(ACP `_meta` 事件级,官方文档)、Cursor Cloud Agents 无上限并行 + 7 入口、OpenHands Cloud API 多会话编排 | 协作群:群主拆解 / 成员执行 / mention 路由 / worktree 隔离 / 30 分钟超时;并行会话组(≥2 agent 同 cwd) | **领先(协议级同构对照=CodeBuddy Agent Teams,见 §6.3)** |
| IM × Agent 融合 | IM 平台原生 bot API 与编码 agent 是两套世界 | 企微消息经 messaging 包进同一 runtime 执行(enqueueMessage),强制 request-approval 审批 | **领先(方向)** |
| 断线续跑 / 跨端 | Codex resume/fork、Cursor `&` 一键上云、Copilot 云沙箱跨 CLI/Mobile 接续 | broker 快照 + runId 断线重连、换设备 handoff / 快照续看、goal 与消息队列持久 | **对齐**(方向一致,实现路线不同) |
| Steering / 中途注入 | Claude stream-json 双向输入流、Codex /queue、Cursor API 级 steer(202 steered/queued) | ZCodeSteering 中途插话 + enqueueSessionMessage 排队;仅部分 runtime 支持(zcode 有、qoder / workbuddy 无) | **部分对齐** |
| 会话 fork / delete / 分页 / 索引 | Claude Code / Codex 全有且官方文档化 | 仅 codex / claude-code / opencode 支持,其余内存分页回退;能力不可发现,靠中文报错串 | **差距** |
| 权限与沙箱 | Codex OS 沙箱默认开 + 审批正交;Claude 六档模式 + 可选沙箱;Copilot / Cursor 分级模式 + allowlist + OS 沙箱 | request-approval 审批(企微线强制);无 OS 级沙箱、无确定性 allowlist | **差距** |
| 事件投影归一 | 各家自守统一事件模型(OpenHands 事件溯源、Codex 协议 schema) | mergeProjectionMessages 逐 agent 特判堆积(preserveNativeOrder 五家),每接新 runtime 改同一处 | **差距(自选难题)** |
| 外部实例占用治理 | 云沙箱天然隔离(Cursor 隔离 VM、Copilot cloud sandbox),无共享宿主问题 | 本地共享宿主:codex advisory 占用 + fork-and-forward、zcode 纯文字 external guide、copilot "占用不算锁" | **差距(路线成本)** |
| IM 渠道完整度 | 五平台均有免公网通道 + 原生流式 API + 频控退避协议 | 仅企微一个渠道,经本地库 Python 驱动(非官方 aibot 长连接);材料二未描述流式适配与频控退避层(落地前需核对代码) | **差距** |
| 发送链路性能 | 云 agent 历史在服务端,无此类负载问题 | Codex 历史图片曾 30MB/14s(1.5MB 预算截断缓解)、目录刷新致连接超时 | **差距** |
| 长期记忆基础设施 | 个人 agent 记忆面板(查看 / 溯源 / 逐条删除:Grok / Muse)+ 条目文件模型(Qwen Auto-Memory,表 6);编码 agent 侧为层级记忆 / repo-map | customer-agent 有 memory 注册表,材料二未描述跨会话记忆面板、溯源与逐条删除(落地见 §7 建议 13) | **差距(可低成本补)** |
| 审批 / 守门 | Muse Sentinel 模型外守门(surrogation + tainted egress,§2.15)、SAEP 声明式策略(§2.16) | harness 内 request-approval(messaging 强制);无独立守门进程、无声明式策略面(§7 建议 6 / 14 / 16) | **差距(方向明确)** |

### 6.2 三个关键判断展开

**领先点的本质:本项目的核心差异化不是任何一个单独 runtime,而是"8 个 runtime 上面的统一层"。** 业界每家都把自己的会话 / 事件 / 审批协议做成私有形态(Copilot AHP、Codex app-server、Claude SDK、OpenCode server、各家 stdio 方言),第三方统一层在业界缺席——Cursor / Copilot 的"统一"是自家的 IDE-云-移动三端统一,不是跨 harness 统一。本项目把它做成了产品主轴(broker detached 进程 + SQLite + 统一端口),这个位置目前没有直接竞品。**对照 §4.13 限定该判断**:ACP 演进(OpenCode / WorkBuddy 原生支持、JetBrains 2026-10 接入)确实在催生跨 harness 的客户端,但它收敛的是"客户端 ↔ 单个 agent 会话"的驱动协议,不覆盖本项目统一层的另一半——多 runtime 的 broker 持久化与断线重连、外部占用治理、投影归一、能力声明,且 ACP 客户端仍需逐家接协议、不消解 8 套方言并存。代价同样来自这里:§5.6 的五个痛点全部是"抹平异构"的成本,业界尚无对等的跨 harness broker / 投影层产品。

**最痛的差距是"能力面不可发现",且它同时伤害 UX 与代码健康。** 业界的做法是把能力显式化:Cursor API 文档化每个端点、Codex app-server 附 JSON Schema 生成、Claude Code flags 全量文档。本项目 fork / delete / steer / 分页 / 索引能力散落在 8 个 adapter 内部,消费端与 UI 无法查询,只能靠运行期撞上中文报错串;每加一个 runtime,preserveNativeOrder 特判与报错串再堆一层。这是一个纯增量可解的结构问题(见 §7 建议 1、3)。

**安全模型是唯一"业界已收敛、本项目未跟进"的整层。** 两大流派(应用层审批 vs OS 沙箱)业界都已成熟,且 IDE 双雄都明示 allowlist 只是 best-effort、硬边界必须 OS 沙箱。本项目审批只有 request-approval 一档、无 allowlist、无沙箱;考虑到本项目会驱动任意 harness 在本机执行 Bash,这一层的风险敞口比单机 CLI 更大(多 runtime 共享宿主),建议至少先补 allowlist 与审批作用域(§7 建议 6),OS 沙箱放 P2 评估。

### 6.3 多 agent 协作 / 监督巡检:补充轮对照样本(材料三)

首轮判定本维度"缺对照样本"(§6.1 两行判定已随本节更新);补充轮取得以下一手对照,每条附对照点:

1. **Anthropic Claude Managed Agents**(官方公测):全托管 agent 基础设施(托管 harness + 沙箱 + 会话),文档入口 platform.claude.com——本轮抓取被地区拦截(307 到 app-unavailable-in-region),细节以官方工程博客为准。架构细节(官方工程博客 2026-04-08,实抓):会话 = append-only 事件日志("the append-only log of everything that happened");harness 无状态化(崩溃后 `wake(sessionId)` / `getSession(id)` 恢复);沙箱统一为 `execute(name, input) → string`;凭据入 vault,"The harness is never made aware of any credentials";解耦后 p50 TTFT 约 -60%、p95 >-90%;"many brains / many hands";Managed Agents 是 meta-harness("Claude Code is an excellent harness that we use widely across tasks")。**对照点**:Anthropic 把"状态外置为事件日志 + 无状态 harness"做进平台层,本项目监督是应用层轮询 / 巡检——借鉴价值为事件日志切片(getEvents())与凭据不进 harness 的安全边界设计,与 §7 建议 1、3 同向。
2. **Cursor 多任务编排(Cloud Agents)**:官方明确 "You can run as many agents as you want in parallel",每 agent 独立云端 VM(克隆仓库 / 依赖 / secrets),7 种入口(iOS app / Web / 桌面 / Slack @cursor / GitHub·Bitbucket PR 评论 / Linear / API);支持多仓库协同开 PR;环境由 `.cursor/environment.json` Dockerfile + 快照预构建;hooks 在 VM 内仅仓库级(用户级不可用);分享为只读 URL;Free / Plus 套餐不含。**对照点**:CollaborationService 的并行会话 vs Cursor 的"无上限云端 VM 并行 + 统一入口矩阵"——Cursor 把"入口接入面"产品化,正是本项目 native-runtime 多运行时矩阵的同构物。
3. **OpenHands 多会话编排(Cloud API)**:`POST /api/v1/app-conversations`(创建,含 initial_message + selected_repository)、stream-start(流式启动状态)、start-tasks(轮询 WORKING → WAITING_FOR_SANDBOX → PREPARING_REPOSITORY → SETTING_UP_SKILLS → READY/ERROR)、search(分页列出);execution_status 含 waiting_for_confirmation(需 UI 确认)与 stuck 终态;并发会话有限流——超限时旧会话自动暂停(提额需联系官方);V0 API 已于 2026-04-01 移除(initial_user_msg → initial_message、同步返回 → 异步 start task)。**对照点**:异步 start-task + 状态机 + 确认阻塞语义与本机会话编排的消息驱动模型可逐项映射,并印证 §7 建议 5 的 waiting_for_user 建模方向。
4. **CodeBuddy/WorkBuddy Agent Teams 与 Multitask**(协议级,官方一手):Agent Teams 经 ACP `session_info_update` 的 `_meta['codebuddy.ai/teamUpdate']` 推送成员状态与 team_created / deleted,成员消息经 `_meta['codebuddy.ai/memberEvent']` 路由到成员时间线,loadSession 自动重放;Multitask 协调器在 ACP / `--serve` 模式被入口守卫拒绝,能力发现走 `agentCapabilities.multitaskSupport`。**对照点**:与本项目 CollaborationService 最接近的协议级竞品样本——同为"监督者把成员消息分流到各自时间线"的模型。
5. **GitHub Copilot Agent Merge "Watch and fix"**(审读修订:材料三所引 zh 操作文档 URL 已 404,逐字引文在现行页未能复核,以下按现行文档改写):现行文档《Getting pull requests ready to merge with Agent Merge》原文 "It watches a pull request for blockers you choose and starts work automatically when it finds one.",阻塞项即 Fix failed Actions workflows / Resolve merge conflicts 两类;启用方式为 PR merge box 的 Watch and fix。材料三另称 Actions 会话单次 59 分钟、仅单仓库、人工批准前不触发 workflows——现行 how-to 页未复现这些细节(59 分钟 / 单仓库在 §2.3 由材料一的 about-copilot-coding-agent 文档独立支撑),"批准前不触发 workflows"标注待复核。**对照点**:SupervisionService 的"巡检 → 自动处置"语义与 Agent Merge 的"监视选定阻塞项 → 自动开工"同构,差异是 Copilot 的触发条件收敛在 CI 失败 / 冲突两类。
6. **Qwen Code Agent Teams 定性不变**:未找到官方文档专页(qwenlm.github.io 文档站搜索无命中,官方 auth 页亦未涉及),信息仅见社区日报与 issue——维持"仅社区层面、官方未文档化"定性,不升级为对照样本;同类对照改用 CodeBuddy Agent Teams(官方文档,见上条)。

---

## 7. 可借鉴点与落地建议

工作量口径(作者粗估):**小** = 单点 / 单文件级(约 1–3 天)、**中** = 模块级(约 1 周)、**大** = 跨模块 / 协议级(数周)。按 优先级 × 工作量 排序:

| # | 优先级 | 借鉴什么(业界来源) | 改本项目哪里 | 工作量 |
|---|---|---|---|---|
| 1 | P0 | 能力面显式声明:Cursor Cloud Agents API 端点级文档、Codex app-server JSON Schema | types.ts 的 AgentRuntimeAdapter 端口增加 capabilities 元数据(fork / delete / steer / 分页 / 索引 / 换模型 / 权限模式),在组合根(native-runtime-broker.ts:3020-3066)逐 adapter 集中声明;server/lib/native-runtime-service.ts 把 OPERATION_NOT_SUPPORTED / SESSION_OCCUPIED 的中文报错串收敛为错误码 → HTTP 状态 → UI 直接禁用不可用操作 | 中 |
| 2 | P0 | IM 接入五层模式之流式适配器 + 频控退避层(§4.12;五平台原生流式 API + 429/Retry-After + "收严发宽") | messaging 包 delivery 层与 channels/wecom:补流式适配器(企微 aibot req_id stream 原生流式优先、节流编辑兜底、10 分钟 finish 约束)+ 单会话串行队列 + 令牌桶 + 429 退避。注意:材料二未描述该两层现状,动手前先核对现有实现 | 小-中 |
| 3 | P0 | 投影归一管道化:OpenHands 统一不可变事件日志 + 状态重建的思路 | native-runtime-broker.ts mergeProjectionMessages(3158-3204):把 preserveNativeOrder 逐 agent 布尔特判改为每 runtime 声明自己的 normalizer / 投影策略插件。先合入当前 harness message-order 修复(未提交 diff,§5.7)再重构,避免边修边改 | 中-大 |
| 4 | P1 | 企微官方智能机器人长连接(免公网 IP、原生流式、官方 SDK @wecom/aibot-node-sdk) | messaging/channels/wecom:在现有本地库 reader/sender 之外新增 aibot WebSocket 通道,评估单连接互踢(单机器人 1 连接)与现链路的并存策略 | 中 |
| 5 | P1 | waiting_for_user 状态显式建模(Copilot 任务 API 的 waiting_for_user、Cursor runs 状态机) | broker run / 队列状态机 + server API + mobile UI:把"等待审批 / 等待回答"升为一等可查询状态,直接对治 §5.6-4 跨端状态恢复对账痛点 | 小-中 |
| 6 | P1 | 审批作用域 + 确定性 allowlist(Copilot Allow Once/Session/Always + 正则 allowlist;承认 best-effort、硬边界另配沙箱) | core 审批端口 + messaging request-approval 链:给审批加作用域记忆,给命令类操作加正则 allowlist | 中 |
| 7 | P1 | 会话压缩统一控制面(Claude / Codex 把压缩做成可配置、可 hook 的生命周期) | native-runtime 透传各家 compact 配置(Claude `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、Codex `model_auto_compact_token_limit`),在 UI 与文档暴露;GLM 用 1000000 窗口配合 1M 上下文是现成参考 | 小 |
| 8 | P2 | OS 级沙箱(Codex Landlock+seccomp / Claude Seatbelt+bubblewrap + 域名白名单代理;`sandbox_mode × approval_policy` 两维正交模型) | core customer-agent 的 Bash / 工具执行层:先做 macOS Seatbelt 试点,与无沙箱模式显式二分;8 个外部 runtime 的沙箱由各自 harness 负责,不在本项目范围 | 大 |
| 9 | P2 | repo-map(Aider:tree-sitter 符号图 + PageRank + token 预算动态扩缩) | core AgentLoop 上下文组装:大仓库低成本低成本注入,替代"整文件塞上下文" | 中 |
| 10 | P2 | Condenser(OpenHands:近窗口丢旧事件 + LLM 摘要) | core AutoCompact(0.6 阈值)补充"丢旧 + 摘要"两级策略,及对订阅型 LLM 禁压缩场景的兜底(OpenHands 反例,§2.7) | 小-中 |
| 11 | P2 | 官方协议面替代自研方言(补充轮 §2.13 / 表 4):OpenCode 原生 ACP、Qoder Cloud Agents REST / SDK、WorkBuddy `codebuddy --acp` ACP;现状三者均为 stdio 方言 / SDK 手工适配直连 | opencode-v2-transport、qoder-client、workbuddy-client 各自传输层:逐个评估官方 ACP / REST 作为第二传输面或迁移目标,降低随版本升级的方言维护成本(WorkBuddy 两镜像版本不同步、ZCode desktop-bridge 未文档化更凸显此风险) | 中-大(逐个迁移,可与现路线并行保留) |
| 12 | P1 | 个人 agent 的主动性产品化:后台异步执行 + 定时 / 事件触发的用户可管理控制中心(ChatGPT Pulse→Scheduled Tasks、Manus Schedules 2.0,§4.14) | core / broker:在 SupervisionService(10s 巡检)与 enqueueSessionGoal 目标队列之外,补"用户可见的定时任务中心"(定时 + 事件触发、主动推送开关);与 IM 主动推送组合成"定时任务→IM 触达"闭环——注意企微等平台主动推送的 24h 窗口约束(§2.12 / §4.12) | 中 |
| 13 | P1 | 长期记忆基础设施化:查看 / 编辑 / 遗忘面板 + 引用溯源 + 逐条删除(§4.14、§4.17);数据模型直接抄 **Qwen one-file-per-memory + frontmatter**,加载预算抄其 200 行 / 25k code units 先例,溯源交互参照 Grok 对话级标注(表 6) | core 记忆模型 + webapp UI:条目文件 + 索引存储(天然支持逐条删除),并区分「从 prompt 移除」与「物理删除」两种语义(表 6 结论 4);材料一 §4.8 已把记忆列为 harness 分化层,本项目 customer-agent 侧补面板即可,不必动 native 会话 | 小-中 |
| 14 | P2 | 敏感动作"模型外守门":独立守门 agent + **凭据代换 surrogation**(凭据对 agent 不可见)+ **tainted egress 污点追踪**治理审批噪音 + 审计日志(Muse Sentinel,工程细节 §2.15) | 与 §7 建议 6(审批作用域 + allowlist)合并演进:审批从 harness 内 request-approval 升级为 broker 侧独立守门进程;进程拓扑参照 §2.15(守门 / 凭据 / 分类器各自独立进程 + Unix domain socket SO_PEERCRED IPC),审批先做三档 allowed / denied / ask + 五种授权粒度(capability 语义);审计日志落 SQLite;本项目 messaging 已强制 request-approval,是雏形 | 中-大 |
| 15 | P2 | 多渠道触达矩阵复用(个人 agent 印证 IM 渠道价值,Muse WhatsApp 直达 vs ChatGPT 退出 WhatsApp 的正反例) | messaging 包已是渠道适配层:新增钉钉 / 飞书 / Slack 渠道直接套 §4.12 五层模式(与 §7 建议 2 协同);AI 替身电话(Genspark Call For Me)列远期观察;端侧进手机(豆包)已升级为专项调研——SAEP 协议(§2.16),落地见 §7 建议 16;教训:自持渠道与官方 bot 通道并重,防单平台政策钳制 | 按渠道小-中 |
| 16 | P2 | 端侧声明式策略 SAEP:App 以 AGRP-Policy/1.0 JSON 声明三级作用域,系统四档决策(ALLOW / BLOCK / CALL_USER / CLARIFY)+ 审计内建(§2.16) | packages/mobile(Capacitor 即标准 Android 工程):**静态接入只需 res/raw/agent_saep_policy.json + manifest meta-data,无需原生代码**;启动时 isRobotsEnabled 检测后回退;注意 Activity 级粒度对 Capacitor SPA(单 MainActivity)先天受限,页面细分只能靠 Intent 级声明或 H5 路由自建守门(后者为本文推断);正式 SDK 未发布,先跟踪 bytedance/SAEP-demo | 小(静态接入)/ 观望(细粒度) |

**前三条展开**:

1. **能力声明注册表**是性价比最高的一项:它不改任何运行行为,只把 §5.6-5 的"不可发现性"从报错串变成数据。做完后 UI 可以按 runtime 灰显 fork / steer / 删除,messaging 与 server 的路由决策也可以按能力分流,后续每个新 runtime 的接入清单自动多出一栏要填的声明,相当于给"8 套方言"立了总账。
2. **IM 流式 + 频控**:材料一 §4.12 的五层模式是五家平台用各自方言收敛出的同一答案,本项目 messaging 主干(intake → routing → dispatch → delivery)已具备前三层,缺的是明示的流式适配与频控退避。企微侧参数都是现成的(30 条/分/会话、req_id stream、10 分钟 finish),实现时唯一要决策的是"占位消息 + 节流编辑"要不要保留为降级路径——业界答案是保留(Telegram / Slack 都如此)。
3. **投影管道化**:这是对 §5.6-1 的根治。判据很简单——如果下一个接入的 runtime 还要在 mergeProjectionMessages 里加 if 分支,就说明抽象还没到位;OpenHands 的启示是把"历史"建模为不可变事件日志、投影是纯函数式的状态重建,本项目可以把每 runtime 的顺序保持 / 工具过滤 / 分组重置都声明为该 runtime 的 normalizer,组合根注册时一并声明(与建议 1 的 capabilities 同一处)。

---

## 8. 参考来源汇总

材料二(项目现状)为内部代码与计划文档,无外部链接;内部计划文档引用:2026-11-07-harness-message-order、2026-11-05-zcode-desktop-guide-bridge、2026-11-04-zcode-mid-turn-steering、2026-11-05-zcode-interruption-message-refresh、2026-11-05-codex-send-latency、2026-11-05-remote-desktop-latency、2026-11-04-mobile-session-list-performance、2026-11-05-codex-mobile-questions、2026-11-04-copilot-session-recovery、2026-10-26-agent-rail-native-runtimes(.superpowers/plans/)。

### Claude Code

- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/channels
- https://github.com/anthropics/claude-code

### Codex CLI

- https://developers.openai.com/codex/sandbox
- https://github.com/openai/codex
- https://github.com/openai/codex/blob/main/docs/exec.md
- https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md
- https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- https://github.com/openai/codex/blob/main/sdk/python/README.md
- https://community.openai.com/t/how-to-turn-off-the-annoying-prompts-for-approval-in-codex-cli-vs-code/1358815
- https://github.com/openai/codex/issues/4776

### GitHub Copilot

- https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli
- https://code.visualstudio.com/docs/agents/run/approvals
- https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available
- https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available
- https://github.com/github/copilot-sdk
- https://docs.github.com/en/copilot/concepts/coding-agent/about-copilot-coding-agent
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
- https://docs.github.com/en/copilot/concepts/agents/copilot-coding-agent/assigning-tasks
- https://github.blog/changelog/2025-10-28-ask-copilot-coding-agent-to-make-changes-in-any-pull-request-with-copilot
- https://github.com/github/github-mcp-server

### Cursor

- https://cursor.com/docs/agent/overview
- https://cursor.com/docs/cloud-agent
- https://cursor.com/docs/cloud-agent/api/endpoints
- https://cursor.com/docs/reference/permissions
- https://cursor.com/docs/cli/overview

### Gemini CLI

- https://github.com/google-gemini/gemini-cli
- https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html
- https://google-gemini.github.io/gemini-cli/docs/cli/commands.html
- https://geminicli.com/docs/tools/mcp-server
- https://geminicli.com/docs/reference/commands
- https://medium.com/google-cloud/gemini-cli-tutorial-series-part-9-understanding-context-memory-and-conversational-branching-095feb3e5a43
- https://inventivehq.com/blog/gemini-cli-free-tier-guide

### Aider

- https://aider.chat/docs/repomap.html
- https://aider.chat/2023/10/22/repomap.html
- https://aider.chat/docs/scripting.html
- https://aider.chat/docs/troubleshooting/token-limits.html
- https://github.com/Aider-AI/aider/issues/3607

### OpenHands

- https://docs.openhands.dev/enterprise/architecture
- https://docs.openhands.dev/sdk/arch/events
- https://docs.openhands.dev/sdk/guides/context-condenser
- https://arxiv.org/abs/2510.19793
- https://docs.openhands.dev/sdk/guides/agent-server/api-sandbox
- https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents

### SWE-agent

- https://swe-agent.com/latest/
- https://swe-agent.com/0.7/background/aci/
- https://arxiv.org/abs/2405.15793
- https://swe-agent.com/latest/reference/history_processor_config/
- https://github.com/swe-agent/mini-swe-agent

### DeepSeek

- https://api-docs.deepseek.com/guides/anthropic_api
- https://api-docs.deepseek.com/guides/tool_calls
- https://api-docs.deepseek.com
- https://api-docs.deepseek.com/zh-cn/updates

### 智谱 GLM

- https://docs.bigmodel.cn/cn/guide/develop/claude
- https://docs.bigmodel.cn/cn/coding-plan/overview
- https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision
- https://bigmodel.cn/glm-coding
- https://www.oschina.net/news/409053

### Qwen Code

- https://github.com/QwenLM/qwen-code
- https://github.com/QwenLM/qwen-code/tree/main/docs/users/features
- https://github.com/QwenLM/qwen-code/tree/main/docs/users
- https://qwenlm.github.io/blog/qwen3-coder
- https://help.aliyun.com/zh/model-studio/qwen-code

### IM 平台

- 企微:https://developer.work.weixin.qq.com/document/path/101463 、/91770 、/93239(前缀 https://developer.work.weixin.qq.com/document/path)
- 钉钉:https://open.dingtalk.com/document/orgapp/configure-stream-push 、https://open.dingtalk.com/document/resourcedownload/Introduction-to-stream-mode 、https://open.dingtalk.com/document/development/api-streamingupdate 、https://open.dingtalk.com/document/development/typewriter-effect-streaming-ai-card 、https://open.dingtalk.com/document/isvapp/invocation-frequency-limit-1 、https://open.dingtalk.com/document/isvapp/robot-receives-message 、https://open.dingtalk.com/document/orgapp/types-of-messages-sent-and-received-by-robots 、https://open.dingtalk.com/document/development/how-to-process-api-throttling-on-the-dingtalk-server
- 飞书:https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN 、https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control 、https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview 、https://open.feishu.cn/document/feishu-cards/update-feishu-card?lang=zh-CN 、https://open.feishu.cn/document/server-docs/im-v1/message/reply
- Telegram:https://core.telegram.org/bots/faq 、https://core.telegram.org/bots/api 、https://gramio.dev/updates/webhook
- Slack:https://docs.slack.dev/apis/web-api/rate-limits 、https://docs.slack.dev/changelog/2025/10/7/chat-streaming 、https://docs.slack.dev 、https://www.conferbot.com/limits/slack 、https://www.reddit.com/r/openclaw/comments/1rpvv7r/openclaw_slack_in_2026_the_rate_limit_problem

### 补充轮(材料三)新增来源

- OpenCode:https://docs.opencode.ai/docs/server/ 、https://opencode.ai/v2/docs/cli/acp 、https://api.github.com/repositories/975734319/releases 、https://www.jetbrains.com/help/ai-assistant/acp.html 、https://agentclientprotocol.org
- Qoder:http://docs.qoder.com/zh/product-series/what-is-qoder 、https://docs.qoder.com/zh/cli/overview 、https://docs.qoder.com/cli/sdk/cloud-agent 、http://docs.qoder.com/zh/cloud-agents/api/conventions/overview 、https://changelog.qoder.com
- WorkBuddy / CodeBuddy:https://www.workbuddy.ai/docs/zh/cli 、https://www.workbuddy.ai/docs/zh/cli/acp 、https://intl.cloud.tencent.com/document/product/1316/84434
- ZCode:https://zcode.z.ai/en/docs/welcome 、https://zcode.z.ai/en/docs/agents 、https://zcode.z.ai/en/releases 、https://github.com/kingsword09/zcode-cli(非官方,含官方仓库结构说明)
- DeepSeek 回源:https://api-docs.deepseek.com/ 、https://api-docs.deepseek.com/guides/tool_calls 、https://api-docs.deepseek.com/news/news250929(V3.2-Exp 公告) 、https://github.com/deepseek-ai/deepseek-harness(README 实抓:dsh 定位、developer preview、"THERE WILL BE COMPATIBILITY-BREAKING CHANGES.";原引 quickstart 页实为 Web UI 指南,不支撑 dsh 定位引语)
- Qwen 额度回源:https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth 、https://github.com/QwenLM/qwen-code/issues/1726 、https://github.com/QwenLM/qwen-code/issues/3267 、https://github.com/QwenLM/qwen-code/issues/3203 、https://www.reddit.com/r/LocalLLaMA/comments/1mu0djr/qwen_code_cli_has_generous_free_usage_option
- Slack 回源:https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps 、https://docs.slack.dev/reference/methods/conversations.history 、https://docs.slack.dev/apis/web-api/rate-limits
- 多 agent 对照样本:https://www.anthropic.com/research/managed-agents 、https://platform.claude.com/docs/en/managed-agents/overview(地区拦截未直读) 、https://cursor.com/docs/cloud-agent 、https://docs.openhands.dev/openhands/usage/cloud/cloud-api 、https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent 、https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests(现行页;原 zh ready-for-merge 链接已 404,见 §6.3-5)

### 补充轮(材料四)新增来源:个人助理 / 陪伴类 Agent

- Muse(Meta):https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent 、https://ai.meta.com/muse 、https://www.meta.com/zh-cn/help/subscriptions/1021145227643680/ 、https://www.datacamp.com/zh/tutorial/meta-muse-tutorial 、https://dev.meta.ai/docs/overview 、https://about.fb.com/news/2026/10/introducing-muse-wonder-models 、https://research.meta.ai/blog/muse-wonder 、https://www.reuters.com/business/meta-launches-ai-agent-that-can-access-other-apps-send-emails-make-payments-2026-09-08
- Grok Bot(xAI):https://x.ai/news/introducing-grok-bot 、https://x.ai/news/grok-4-1-fast 、https://docs.x.ai/overview 、https://x.ai/news/grok-3 、https://x.ai/news/grok-4 、https://x.ai/api 、https://techcrunch.com/2025/04/16/xai-adds-a-memory-feature-to-grok 、https://www.datacamp.com/blog/grok-vs-chatgpt 、https://apipass.dev/blogs/grok-vs-chatgpt-2026-guide
- ChatGPT:https://openai.com/zh-Hans-CN/index/introducing-chatgpt-pulse 、https://openai.com/index/introducing-chatgpt-agent 、https://help.openai.com/en/articles/11752874-chatgpt-agent 、https://openai.com/index/chatgpt-whatsapp-transition 、https://openai.com/index/introducing-apps-in-chatgpt 、https://itbrief.com.au/story/openai-expands-chatgpt-scheduled-tasks-with-new-hub
- Manus:https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus 、https://manus.im/docs/integrations/manus-api 、https://open.manus.ai/docs/v1/create-task 、https://manus.im/blog/manus-schedules 、https://manus.im/docs/features/wide-research
- Genspark:https://openai.com/index/genspark 、https://www.genspark.ai/helpcenter/secondbrain 、https://www.genspark.ai/tools/ai-phone-call 、https://aimagazine.com/news/genspark-how-the-ai-workspace-hit-at-us-2-6bn
- 星野 / Talkie:https://www.talkie-ai.com 、https://play.google.com/store/apps/details?id=com.weaver.app.prod 、https://www.moomoo.com/hans/news/post/72486374 、https://www.cls.cn/detail/2095611

### 补充轮(材料五)新增来源:守门工程 / 端侧触达 / 记忆数据模型

- Muse Sentinel:https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse(官方工程博客《How We Built Safety Into Muse》,2026-09-08) 、https://www.impart.ai/blog/meta-sentinel-ai-agent-security(二手分析,单方陈述)
- 豆包 / SAEP:https://o.doubao.com/SAEP_Protocol(官方接入文档,本轮实抓全文) 、https://github.com/bytedance/SAEP-demo 、https://gitee.com/ByteDance/SAEP-demo 、https://blog.csdn.net/qq_44810930/article/details/155892192(第三方逆向分析,非官方) 、https://zhuanlan.zhihu.com/p/1990899214201418306(端侧路线分析,搜索摘要,原文未抓取)
- 记忆数据模型对照:Muse https://www.meta.com/help/superintelligence/2225571704857152/ 、https://www.techtimes.co.uk/meta-muse-ai-profiles-users-contacts-1808986 ;Grok https://techcrunch.com/2025/04/16/xai-adds-a-memory-feature-to-grok 、https://www.reddit.com/r/grok/comments/1k6pbrj/ ;Gemini CLI https://geminicli.com/docs/cli/gemini-md ;Qwen https://qwenlm.github.io/qwen-code-docs/en/users/features/memory 、https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md ;Aider https://aider.chat/2023/10/22/repomap.html 、https://aider.chat/docs/repomap.html 、https://anishgandhi.com/aider-pagerank-codebase-ranking ;TDCommons https://www.tdcommons.org/cgi/viewcontent.cgi?article=13949&context=dpubs_series(PDF 被 Cloudflare 挑战页拦截,未读原文)

### 待核实项与剩余风险(随调研轮次滚动更新,2026-11-07 补充轮后)

首轮三项"待核实"已回源处理:DeepSeek V3.2 tool calls(前半句成立、失败反馈查无官方出处,见 §2.9)、Qwen Code 免费额度(旧口径过时,见 §2.11)、Slack 读历史限制(官方一手 changelog 确认,见 §2.12)。当前剩余:

- 版本号两处不同步:WorkBuddy 最新版本 workbuddy.ai(v2.162.0)与腾讯云文档(v2.173.0,来自搜索摘要)不一致,差异原因待核实;OpenCode changelog 页直抓超时,发版节奏以 GitHub Releases API 为准。
- 两处"官方未文档化":ZCode desktop-bridge 描述符协议(本项目 zcode-desktop-bridge.ts:25 依赖);DeepSeek Harness(dsh)开发者预览且官方预告破坏性变更——升级风险需在矩阵中跟踪(见 §3 表 4)。
- 取证缺口:Wayback Machine 两轮查询均返回空,旧版 DeepSeek function_calling 指南快照未取到;platform.claude.com 对本轮抓取环境地区拦截(307),Managed Agents 定价 / beta 细节依赖官方博客与搜索摘要。
- 审读补充(2026-11-07 第二轮):Agent Merge 逐字引文("With Agent Merge, Copilot watches a pull request and works on the blockers you select...")所依托的 zh 操作文档已 404,现行页措辞不同,该引文未能在现存页面复核(§6.3-5 已按现行页改写);Telegram sendMessageDraft / sendRichMessageDraft 原生草稿 API 因抓取超时未获独立核验,§2.12 / 表 3 沿用材料一口径。
- 材料四(个人 agent)内置待核实项:星野六机制出处未取原文链接(搜索摘要引述);Manus 会话分享 / 中断续跑细节待核实、公司主体 Butterfly Effect 未单独核实;Genspark 公开 API / SDK 未见待核实;Grok 4.5 移除语音人格(2026-07 报道)待核实。
- 材料五(2026-11-07 第四轮)内置待核实项:Muse 审批"四档"未在官方原文逐字出现(已按三档 allowed / denied / ask + 五种授权粒度更正,疑对应四层放行来源);Sentinel pending approval 持久化、Confidential VM 密钥托管 / attestation 协议官方未披露;豆包"行业首款系统级 GUI Agent"定义与四进程 / signature 权限为非官方逆向来源;SAEP 的 CLARIFY 档语义、正式 SDK 未公开;TDCommons《Receipt-Gated Staged Execution》PDF 被 Cloudflare 拦截未读原文;"155 款 App 集体拒绝授权"仅为搜索摘要。
- 第三轮审读复核(2026-11-07):材料四多条量化 / 转述论断无 §8 来源条目支撑,已原位标注待核实——『10 天登顶美区 App Store 免费榜』『Meta 股价单月涨约 20%』『WSJ 有信任问题专文』『Secure VM 约 8GB 内存』『Stripe Link』『仅美加后扩新加坡』『Atlas 被整合裁撤』『Genspark 9 LLM / 80 工具、Agent 365 启动伙伴、Twilio 合作』『Grok Bot "Cursor 系套餐"(疑转写笔误,x.ai 抓取被拒未回源)』『grok-4.7 500k 上下文』;发布稿实抓确认日期 / Spark / Secure VM / Sentinel / WhatsApp / AI 眼镜预告吻合,但无 "Your Personal AI Agent" 口号(实抓标题 The World's First Personal AI Agent Built for Everyone)、无订阅定价(定价锚 §8 meta.com 订阅帮助页);research.meta.ai 与 x.ai 本轮抓取失败未能在线复核。
