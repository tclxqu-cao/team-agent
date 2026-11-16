# Bot 专项调研:IM 平台 Bot 与对话型 / 个人 Bot(2026-11)

> **本文为「Bot 专项精简版」**,从 2026-11-07 的全量调研 `docs/research/bot-landscape-and-comparison.md`(Bot 生态调研与本项目对比,材料一至材料五)中提取重组。**编程 Agent 部分的调研见原文档**(§2.1-2.11 Claude Code / Codex CLI / GitHub Copilot / Cursor / Gemini CLI / Aider / OpenHands / SWE-agent / DeepSeek API / GLM Coding Plan / Qwen Code,§2.13 OpenCode / Qoder / WorkBuddy / ZCode,表 1 / 2 / 4)。
>
> **收录口径**:IM 平台 Bot 体系(企业微信 / 钉钉 / 飞书 / Telegram / Slack)+ 对话型 / 个人 Bot(Muse、Grok Bot、ChatGPT Pulse / Agent Mode、Manus、Genspark、星野 / Talkie)及其工程延伸(Muse Sentinel 守门深挖、豆包手机助手与 SAEP 端侧触达)。
>
> **消歧说明**:DeepSeek 在原文档中仅以「模型 API / 编码 harness 兼容」口径出现(原文档 §2.9,明确"无官方 CLI / IDE / 云端 agent"),**没有**以对话型 / chatbot 形态的独立画像,本文不收录、不另编。Museland(上海逐鹿行)为 AI 角色扮演 / 陪伴类,与星野 / Talkie 同类,原文档口径为"陪伴类已由星野 / Talkie 代表"故不单列。
>
> **忠实性约定**:事实、「待核实」标注、来源 URL 均忠实转写原文档并原样保留,未新增事实;「—」表示源文档未提及该维度。

---

## 1. Bot 逐个画像

### 1.1 IM 平台 Bot(企微 / 钉钉 / 飞书 / Telegram / Slack)

#### 企业微信智能机器人

- **定位 / 形态**:双轨——「消息推送」(原群机器人,单向 webhook 群播)与「智能机器人」(双向 API 机器人,webhook 或 WebSocket 长连接)。
- **通道与流式**:长连接 `wss://openws.work.weixin.qq.com`,aibot_subscribe 订阅、30s 心跳、单机器人仅 1 连接、新连踢旧连;回复透传 req_id 做 stream 流式上屏、**10 分钟内须 finish**;enter_chat 事件 5 秒内回欢迎语。
- **频控与约束**:单会话回复+推送合计 30 条/分、1000 条/时;主动推送前提是用户先发过消息(**24h 窗口**);image / voice / file / video 仅单聊可收;非超管创建的机器人回调 userid 加密需转明文。
- **强项**:微信生态触达、长连接免公网 IP、原生流式、模板卡片等企业交互。
- **弱项**:媒体仅单聊、主动推送受限、长连接单实例互踢且无官方多连接负载方案。
- **来源**(原文档 §8「IM 平台」,URL 原样保留):https://developer.work.weixin.qq.com/document/path/101463 、/91770 、/93239(前缀 https://developer.work.weixin.qq.com/document/path)

#### 钉钉机器人

- **定位 / 形态**:三形态——自定义机器人(群 webhook 单向,需关键词 / 加签 / IP 白名单三选一)、企业内部应用机器人(双向单聊+群聊)、AI 助理(开箱即用智能体平台)。
- **通道与流式**:Stream 模式(dingtalk-stream SDK 反向 WebSocket)无需公网 IP / 域名 / 证书 / 内网穿透;AI 回复用 AI 卡片 streamMode:创建卡片 → streamingUpdate 增量写入 → 终止,配 typingAction 打字机效果。
- **频控与约束**:自定义机器人 20 条/分钟、超限罚停 10 分钟且只能发群;服务端 API 标准版 20 QPS、IP 维度 20 秒 1 万次即封 5 分钟;单聊仅企业内部应用机器人支持。
- **强项**:接入门槛全场最低、官方 AI 卡片流式 + AI 助理开箱即用、组织内审批 / 日程 / 待办联动深。
- **弱项**:自定义机器人限频罚停、单聊能力限企业内部应用机器人。
- **来源**(原文档 §8「IM 平台」,URL 原样保留):https://open.dingtalk.com/document/orgapp/configure-stream-push 、https://open.dingtalk.com/document/resourcedownload/Introduction-to-stream-mode 、https://open.dingtalk.com/document/development/api-streamingupdate 、https://open.dingtalk.com/document/development/typewriter-effect-streaming-ai-card 、https://open.dingtalk.com/document/isvapp/invocation-frequency-limit-1 、https://open.dingtalk.com/document/isvapp/robot-receives-message 、https://open.dingtalk.com/document/orgapp/types-of-messages-sent-and-received-by-robots 、https://open.dingtalk.com/document/development/how-to-process-api-throttling-on-the-dingtalk-server

#### 飞书机器人

- **定位 / 形态**:自建 / 商店应用机器人(双向)+ 自定义机器人(群 webhook 单向)。
- **通道与流式**:事件订阅走 webhook(公网 URL + 验签解密)或 SDK 长连接(WebSocket 全双工,仅自建应用,每应用 ≤50 连接,集群模式随机单点投递、不支持广播);事件须 3 秒内处理完否则重推;AI 回复走 CardKit v1:创建卡片 → 流式更新文本 → 完成,**卡片 14 天内可更新——五家中最完整的专用 AI 流式 API**。
- **频控与约束**:同用户 5 QPS、同群全体机器人共享 5 QPS;自定义 webhook 单租户单机器人 100 次/分、5 次/秒;长连接仅自建应用(商店应用必须 webhook);消息 / 群组类接口明确不支持自行提频。
- **强项**:CardKit 流式、长连接免公网免验签、卡片组件第一梯队。
- **弱项**:长连接仅自建应用、集群随机投递不支持广播、明确不支持自行提频。
- **来源**(原文档 §8「IM 平台」,URL 原样保留):https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN 、https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control 、https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview 、https://open.feishu.cn/document/feishu-cards/update-feishu-card?lang=zh-CN 、https://open.feishu.cn/document/server-docs/im-v1/message/reply

#### Telegram Bot

- **定位 / 形态**:官方 Bot API,无企业组织模型,AI Agent 最常用的一线接入入口。
- **通道与流式**:getUpdates 长轮询与 setWebhook HTTPS 回调二选一互斥(webhook 仅 443/80/88/8443 端口、需 SSL、secret path 鉴权);webhook 响应体内联 API 调用;流式回复用 Bot API 9.5+ `sendMessageDraft` / 10.x `sendRichMessageDraft` 原生草稿(注:该组 API 因原文档抓取超时未获独立核验,沿用材料一口径,**待核实**),或 editMessageText 节流编辑。
- **频控与约束**:单 chat 1 msg/s、群 20 msg/min、广播约 30 msg/s,超限 429 + retry_after,付费广播可提至 1000 msg/s(0.1 Stars/条,需 10 万 Stars 余额 + 10 万 MAU);群聊默认 privacy mode 只收命令 / 回复 / 经本 bot 发送的消息。
- **强项**:接入零门槛、原生流式草稿 API、生态与第三方库最丰富。
- **弱项**:无企业权限体系、发送阈值未文档化、文件下载 ≤20MB / 发送 ≤50MB。
- **来源**(原文档 §8「IM 平台」,URL 原样保留):https://core.telegram.org/bots/faq 、https://core.telegram.org/bots/api 、https://gramio.dev/updates/webhook

#### Slack App

- **定位 / 形态**:bot 即 Slack App,Bolt 框架 + Events API / Socket Mode + Web API tier 限流 + Block Kit。
- **通道与流式**:Events API HTTP 回调(限 30,000 events/workspace/app/60 分钟)或 Socket Mode(app-level token 调 apps.connections.open 换动态 WebSocket URL,免公共端点);AI 流式用 2025-10 新增 chat.startStream / appendStream / stopStream(+2026-04 streaming blocks)。
- **频控与约束**:chat.postMessage 特殊 tier 每 channel 1 msg/s(允许短突发),429 + Retry-After;读历史限制已回源官方一手 changelog(2025-05-29):仅 conversations.history / conversations.replies 降为每请求 15 条、每分钟 1 次(limit 最大/默认同步降为 15),2025-05-29 后新建 app 及所有"新安装"立即生效,既有外部分发安装不受影响、内部自建应用完全豁免、Marketplace 应用不受限,官方理由点名防敏感会话数据外泄与 "unsanctioned data scraping"(AI 风险);另:bot token 只能读其已加入的会话(not_in_channel 仅 user token 可越),标准 Tier 3 为 50+/分钟。
- **强项**:Socket Mode 免公网 + 官方 AI 流式最完整、Block Kit 与企业 SaaS 生态最强、按 method×workspace×app 限流清晰可预期。
- **弱项**:postMessage 1 msg/s/channel 偏紧、读历史收紧影响上下文回填、官方文档站迁移老链接大量 404(材料实测 api.slack.com 与 docs.slack.dev 旧 Socket Mode 链接均 404)。**落地含义**:若本项目 Slack 接入使用 2025-05-29 之后新建的自建 app,读历史会命中 15 条/1rpm 限制。
- **来源**(原文档 §8「IM 平台」+ 材料三 Slack 回源,URL 原样保留):https://docs.slack.dev/apis/web-api/rate-limits 、https://docs.slack.dev/changelog/2025/10/7/chat-streaming 、https://docs.slack.dev 、https://www.conferbot.com/limits/slack 、https://www.reddit.com/r/openclaw/comments/1rpvv7r/openclaw_slack_in_2026_the_rate_limit_problem 、https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps 、https://docs.slack.dev/reference/methods/conversations.history

### 1.2 对话型 / 个人 Bot

#### Muse(Meta)

- **定位**:Meta 2026-09-08 发布的消费级个人 AI Agent(第三轮审读实抓发布稿标题为 **"The World's First Personal AI Agent Built for Everyone"**;"Your Personal AI Agent" 口号改锚 ai.meta.com/muse 落地页,**待核实**),iOS / Android / Mac App + muse.ai 网页 + WhatsApp 多端形态,定位"不是聊天机器人,而是能替用户真实执行任务的智能体",扎克伯格称之为个人超级智能的消费级入口。
- **架构**:Muse Spark 模型(现 1.3)驱动;每用户独享一台云端隔离 Linux 虚拟机 Muse Secure VM(含完整浏览器;"约 8GB 内存"为材料四口径,**待核实**);同机独立 Sentinel agent 审批所有出站动作并按需向用户请示(工程细节见下节);凭据存于 agent 不可见的加密存储(surrogation 机制,见下节),支付走一次性卡号(材料四称 Stripe Link,**待核实**),全程活动审计日志;已宣布 Windows 原生版(微软 MXC 沙箱)与 AI 眼镜版。
- **会话与记忆**:App / 网页 / WhatsApp / Mac 触达同一驻留 VM 的 agent,**关掉应用任务继续**;纠正会沉淀为跨会话记忆,可在"记忆"面板查看 / 编辑或令其遗忘;审批档位(**材料五更正**):官方决策三档 allowed / denied / ask,批准为 capability、支持五种授权粒度(one-time / session-scoped / task-scoped / time-bounded / perpetual)——材料四"单次 / 本任务 / 本站点 / 始终四档"未在官方原文逐字出现;已知缺陷:上下文压缩会丢失确认规则。
- **接入**:个人 agent 本体无 API;Meta Model API(dev.meta.ai)开放 Muse Spark / Wonder 推理,兼容 Responses / Chat Completions / Messages 三种格式;Muse Connector 平台(2026-09-18 起)开放第三方连接器接入;Muse Code 编码 agent 可对接 Claude Code / Codex / OpenCode,可被第三方程序间接驱动。
- **强项**:分发与入口极强(WhatsApp / IG / Meta 账号直接触达;"上线 10 天登顶美区 App Store 免费榜""Meta 股价单月涨约 20%"为材料四口径、无媒体来源条目,**待核实**);执行与安全架构完整(持久 VM + Sentinel 模型外守门 + 一次性支付卡 + 审计日志);主动性强(跨应用连接器、后台持续任务、主动记忆与未请求建议 Active Memory / Active Focus)。
- **弱项**:隐私信任危机(多起越权访问报告——未经同意同步数据、读取私信;材料四称 WSJ 专文"有信任问题"、无对应来源条目,**待核实**);实操硬伤(2FA 保护的账户不可用、亚马逊拦截、CAPTCHA 卡死、日历时间出错、推荐已停业餐馆);覆盖受限("仅美加、后扩新加坡"与免费档周用量限额为材料四口径,**待核实**;订阅 Power $20 / 月、Maximum $100 / 月,锚 §8 meta.com 订阅帮助页——审读实抓发布稿无定价)。
- **来源**(原文档 §8「材料四 Muse」+「材料五 Muse Sentinel / 记忆」,URL 原样保留):https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent 、https://ai.meta.com/muse 、https://www.meta.com/zh-cn/help/subscriptions/1021145227643680/ 、https://www.datacamp.com/zh/tutorial/meta-muse-tutorial 、https://dev.meta.ai/docs/overview 、https://about.fb.com/news/2026/10/introducing-muse-wonder-models 、https://research.meta.ai/blog/muse-wonder 、https://www.reuters.com/business/meta-launches-ai-agent-that-can-access-other-apps-send-emails-make-payments-2026-09-08 、https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse 、https://www.impart.ai/blog/meta-sentinel-ai-agent-security 、https://www.meta.com/help/superintelligence/2225571704857152/ 、https://www.techtimes.co.uk/meta-muse-ai-profiles-users-contacts-1808986

##### Muse Sentinel「模型外守门」工程深挖(原文档 §2.15,一手来源为 Meta 官方工程博客《How We Built Safety Into Muse》2026-09-08)

- **定位与信任边界**:Sentinel 是独立于 Muse 的宿主侧(host-side)agent,是「connector 动作 + 全部网络出站」的**唯一权限权威**(sole permission authority);Muse 只能 propose,不能自我审批、不能覆盖 Sentinel;官方架构母题是 "one box, two isolated security domains"。
- **两条拦截路径**:① Connector 路径——向 Sentinel 提交结构化请求(connector 标识、method、动作类别、scope、用户请求上下文)→ 生成用户可见"用途说明"并对照 connector policy 判定;② 网络出站路径——所有请求经正向代理(Linux 网络控制面强制:userns、veth 边界、eBPF 过滤)→ L4+L7 双层评估(hostname、DNS 解析后最终目的 IP、端口、协议、HTTP method、path、**解码后的实际请求体**),内置 SSRF 限制。
- **凭据代换(surrogation)**:runtime cell 内代码只见 authd 铸造的 surrogate token;请求获准后 Sentinel 在**网络边界**才换成真凭据——prompt injection 逼 agent 交出真实密钥在原理上无效。
- **tainted egress 污点追踪**:每个工具执行进程从 clean 状态启动,**一旦读取用户数据即被污染**;clean 进程命中窄边界 auto-allow 策略且通过出站 URL 检查的请求直接放行;tainted 或不可验证进程丧失 auto-allow、回落人工审批。实现:eBPF cgroup 程序做网络拦截与进程归因 + 挂到自制 Linux Security Module hook 的 eBPF 程序做污点传播。设计原则:"把摩擦放在 consent 真正重要的地方"。
- **审批档位与状态(修正材料四)**:官方决策为**三档 allowed / denied / ask**;ask 时创建 pending approval、执行停止,请求直达 Muse 客户端以**系统级 dialog** 呈现(明确不是聊天消息);**批准即能力(capability)而非对话承诺**:严格绑定 connector/目的地 + 用例,**五种授权粒度:one-time、session-scoped、task-scoped、time-bounded、perpetual**;pending approval 的持久化细节官方未披露(**待核实**)。
- **进程拓扑**:runtime cell 用 **systemd-nspawn**(cell 内 root 映射为宿主非特权用户、独立 rootfs、独立虚拟网卡、系统调用过滤禁 io_uring、裁剪 CAP_SYS_PTRACE / CAP_NET_ADMIN);cell 外安全服务各自独立 systemd unit:**hatch-safety**(防 prompt injection)、**privsep**(最小权限执行内置 connector 逻辑)、**hatch-authd**(凭据存储 + surrogation)、Sentinel、推理/遥测代理;**全部 IPC 走 Unix domain socket + SO_PEERCRED + peer ACL**;浏览器 CDP 由 cell 外 broker 管理,浏览器子 agent 只见**可访问性树快照而非原始 DOM**、无脚本执行能力。
- **Confidential VM(用户自持密钥)**:承诺"**密码学上且可验证地**"阻止 Meta 访问 VM 内数据,计划年内交付;密钥托管位置 / 恢复机制 / attestation 协议 / 是否基于 TDX 或 SEV-SNP **官方未公开——待核实**。
- **二手分析(单方陈述)**:impartment 营销博客称 Sentinel 是"意图与效果之间的授权层",弱点包括只保护 Meta 自家环境、Meta 同时拥有两端、审批疲劳。

#### Grok Bot(xAI)

- **定位**:xAI 的个人 AI 代理家族:X 内置 Grok(导航栏 / @grok)与独立 App(grok.com / iOS / Android)是通用个人助理;2026-08-11 beta 推出的 Grok Bot 是『有自己云电脑的常驻 AI 队友』,订阅制(SuperGrok 等套餐——材料四原文"Cursor 系套餐"疑为转写笔误,x.ai 抓取被拒未回源,**待核实**,疑似应为 Premium+ / SuperGrok Heavy 等档位,企业走 waitlist)。
- **架构**:消费端 DeepSearch 将查询拆解、并行搜索并综合,支持多 agent;API 端 Agent Tools API 提供服务端工具(X 搜索、网页浏览、远程代码执行、文档检索),模型自主决定、跨轮并行调用,全托管于 xAI 基础设施;**Grok Bot 为每个 Bot 配独立云电脑,直接登录用户应用 UI 操作,无需 API / MCP,仅在需审批时中断**。
- **会话与记忆**:记忆功能(2025-04 beta)跨会话记住偏好,**可查看回答引用了哪些历史会话并逐条删除**;Grok Bot 记住对话与偏好、可把演示过的工作流存为 routine 复跑;会话线程手机 / 桌面接续,Bot 间在群聊中共享上下文;模型侧上下文 2M(grok-4.1-fast);grok-4.7 的 500k 上下文无对应来源条目,**待核实**。
- **接入**:OpenAI 兼容 API(api.x.ai/v1):可用 OpenAI SDK、Python xai_sdk、@ai-sdk/xai 与 Responses API,含 tool calling / 结构化输出;Agent Tools API 按成功调用计费(约 $5 / 千次);另有 Voice / Imagine API;Grok Bot 本体无公开 API,仅 iOS / 桌面 App 内订阅使用。
- **强项**:独家实时 X 数据与社交情报,DeepSearch agentic 搜索基准(Research-Eval / FRAMES / X Browse)领先 GPT-5 与 Claude Sonnet 4.5 且 API 更便宜;每实例配独立云电脑、跨应用 UI 操作端到端交付,多 Bot 群聊协作;记忆透明可控(查引用来源、逐条删除)。
- **弱项**:生态成熟度、企业集成与产品打磨不及 ChatGPT;新功能推送不均且地区受限(记忆初期排除欧盟 / 英国,Grok Bot 限高级订阅 beta 且用量单独计量);迭代激进有功能回撤(2026-07 有报道称 Grok 4.5 移除语音人格,**待核实**);依赖 X 数据的优势在非社交场景减弱。
- **来源**(原文档 §8「材料四 Grok Bot」+ 表 6 Grok 记忆链接,URL 原样保留):https://x.ai/news/introducing-grok-bot 、https://x.ai/news/grok-4-1-fast 、https://docs.x.ai/overview 、https://x.ai/news/grok-3 、https://x.ai/news/grok-4 、https://x.ai/api 、https://techcrunch.com/2025/04/16/xai-adds-a-memory-feature-to-grok 、https://www.datacamp.com/blog/grok-vs-chatgpt 、https://apipass.dev/blogs/grok-vs-chatgpt-2026-guide 、https://www.reddit.com/r/grok/comments/1k6pbrj/

#### ChatGPT(Pulse / Agent Mode)

- **定位**:OpenAI 的通用 AI 助手(App / Web / Atlas 浏览器),叠加 Agent Mode、Pulse 主动晨报与定时任务,是「主动个人助理」的事实标准形态。
- **架构**:闭源云端 harness:Agent Mode 由融合 Operator 与 Deep Research 的 agentic 模型驱动,在云端虚拟计算机中执行——图形+文本浏览器、终端、API 直连;登录 / 支付等敏感操作需批准,支持监看与接管;Pulse 夜间异步研究生成晨报。
- **会话与记忆**:记忆 = 保存记忆 + 引用历史聊天;Pulse 已并入统一 Scheduled Tasks 中心(2026-06);单会话可回溯,上下文压缩机制未公开;无并行多 agent。
- **接入**:消费端助手无官方 API 可被第三方驱动;程序化接入靠 Apps SDK(MCP 扩展,把交互式应用嵌入 ChatGPT)与 connectors;OpenAI API 属开发者产品线,与助手会话分离。
- **强项**:多渠道触达最广(App / Web / Atlas,曾借 WhatsApp 到达亿万用户);主动服务产品化最完整(夜间研究→晨报卡片→反馈闭环);连接器与应用生态规模最大(Apps SDK / MCP)。
- **弱项**:Agent Mode 额度低(Plus 40 次 / 月、Pro 400 次 / 月);闭源黑盒,上下文与记忆管理不可控;多渠道受平台政策钳制(因 Meta 政策 2026-01 退出 WhatsApp;"Atlas 亦被整合裁撤"无对应来源条目,**待核实**)。
- **来源**(原文档 §8「材料四 ChatGPT」,URL 原样保留):https://openai.com/zh-Hans-CN/index/introducing-chatgpt-pulse 、https://openai.com/index/introducing-chatgpt-agent 、https://help.openai.com/en/articles/11752874-chatgpt-agent 、https://openai.com/index/chatgpt-whatsapp-transition 、https://openai.com/index/introducing-apps-in-chatgpt 、https://itbrief.com.au/story/openai-expands-chatgpt-scheduled-tasks-with-new-hub

#### Manus

- **定位**:独立创业公司(原 Monica 团队,公司主体 Butterfly Effect 属公开报道、未单独核实)的云端通用 Agent:「给 Agent 一台云电脑」,自主执行研究、编码、生成应用等长任务并交付沙箱产物。
- **架构**:不微调模型,基于前沿模型(Claude 类)的 agent loop:模型从预定义动作空间选动作→云 VM 沙箱执行→观察追加回上下文;靠上下文工程驱动:KV-cache 命中率优先、append-only、todo.md 目标复述、logit mask 控制工具集、错误留上下文;Wide Research 以并行多 agent 处理批量任务。
- **会话与记忆**:append-only 上下文 + 文件系统当外部记忆,压缩可恢复(留 URL / 路径即可弃内容);Schedules 2.0(2026-05)支持定时 + 事件触发自动化;支持会话分享与中断续跑(细节**待核实**);任务中可补指令 steering。
- **接入**:官方 RESTful API(open.manus.ai 的 Create Task,单任务 prompt 约 5k token 上限);无 CLI 与本地 SDK;第三方程序可异步提交任务、取回产物,属可驱动型。
- **强项**:上下文工程方法论业界标杆(KV-cache、文件系统即上下文);云沙箱异步自主执行与产物交付最成熟;自动化(定时 / 事件)与 API 接入闭环完整。
- **弱项**:典型任务 50+ 次工具调用、输入输出 token 比约 100:1,成本与延迟高;依赖第三方前沿模型,无自有模型纵深;个人化 / 陪伴属性弱,更像任务执行器而非日常贴身助理。
- **来源**(原文档 §8「材料四 Manus」,URL 原样保留):https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus 、https://manus.im/docs/integrations/manus-api 、https://open.manus.ai/docs/v1/create-task 、https://manus.im/blog/manus-schedules 、https://manus.im/docs/features/wide-research

#### Genspark(Super Agent)

- **定位**:Genspark(2024 年从 AI 搜索引擎转型)的「超级代理」个人工作台(Web / 移动),零配置全自动:能打电话、做幻灯片、生成视频、管理文档。
- **架构**:Mixture-of-Agents:"编排 9 个专用 LLM(模型池 30+)+ 80 余个工具"为材料四口径、原文档来源清单无对应条目,**待核实**;电话功能双层架构——OpenAI Realtime API 实时对话 + shadow model 经消息队列监督纠偏;GPT-4.1 负责研究与严格 JSON 结构化输出。
- **会话与记忆**:SecondBrain 统一记忆:邮件、会议、文件、聊天与历史项目持续喂入,构建单一运行记忆;Second Brain Note(MagSafe 录音卡)把线下对话录入;产物沉淀为可复用项目资产。
- **接入**:C 端为主,Connectors & Integrations 管理第三方应用授权;"2025-11 成为 Microsoft Agent 365 启动伙伴"无对应来源条目,**待核实**;公开 API / SDK 未见(**待核实**),第三方程序化驱动受限。
- **强项**:多渠道触达独树一帜——AI 替用户真打电话(Call For Me 覆盖商家与个人电话;"与 Twilio 合作全球扩量"无对应来源条目,**待核实**);SecondBrain 记忆 + 硬件入口形成个人数据闭环;no-code 全自动,上手门槛最低。
- **弱项**:多模型编排成本高,可靠性依赖工具验证与打分;供应链依赖强(GPT / Twilio 等第三方);开放性不足,生态锁定在自家工作台内。
- **来源**(原文档 §8「材料四 Genspark」,URL 原样保留):https://openai.com/index/genspark 、https://www.genspark.ai/helpcenter/secondbrain 、https://www.genspark.ai/tools/ai-phone-call 、https://aimagazine.com/news/genspark-how-the-ai-workspace-hit-at-us-2-6bn

#### 星野 / Talkie(MiniMax)

- **定位**:MiniMax 的 AI 陪伴双产品(星野 = 国内、Talkie = 海外),移动 App 沉浸式角色陪伴与 UGC 角色社区,曾是国内外 AI 陪伴下载量第一梯队。
- **架构**:基于 MiniMax 自研模型(文本+语音)的角色陪伴 harness:角色卡 + 人设驱动对话,提供重说 / 回溯 / 记忆 / 重启 / 评价 / 事件簿六个机制把叙事进程控制权交给用户(机制出处为搜索摘要引述的星野万字长文,未取原文链接)。
- **会话与记忆**:「记忆图谱」可视化持久记忆,被行业竞相效仿;Talkie 把对话沉淀为可收藏交易的星念卡片;Talkie+ 宣传「扩展记忆」但长对话记忆重置仍是 2026 年常见投诉;无任务型会话与并行概念。
- **接入**:纯 C 端 App,无 API / SDK 对外开放;个性化靠自建角色与音色形象,不可被第三方程序驱动。
- **强项**:自研模型 + 语音 / 形象一体,沉浸式陪伴体验完整;数百万 UGC 角色共创生态与卡片交易;情感付费意愿强(女性用户付费更高)。
- **弱项**:长对话记忆重置仍是硬伤;监管风险高(2024-12 Talkie 从美国 App Store 下架,星野整改下架大批擦边智能体);热度回落明显(2025 Q4 月活环比降约六成)。
- **来源**(原文档 §8「材料四 星野 / Talkie」,URL 原样保留):https://www.talkie-ai.com 、https://play.google.com/store/apps/details?id=com.weaver.app.prod 、https://www.moomoo.com/hans/news/post/72486374 、https://www.cls.cn/detail/2095611

### 1.3 端侧触达:豆包手机助手与 SAEP 协议(原文档 §2.16)

- **产品定位**:豆包手机助手被定义为**行业首款「系统级 GUI Agent」**:深度耦合 OS 底层而非孤立 App、与手机厂商合作获取系统级权限,UI-TARS 支撑跨 App 长链路任务(定义来自搜索聚合转载页,**原文未直接抓取,待核实**)。
- **进程与权限(第三方逆向分析,非官方,谨慎引用)**:四个系统进程 aivoice(语音入口)/ assistantaiagent(助手)/ aikernel(本地推理内核,Native 堆约 160MB,Binder RPC 系统级服务)/ autoaction(屏幕捕获 + 指令执行);关键权限均为 **signature 级**:READ_FRAME_BUFFER(直读 GPU 渲染缓冲)、CAPTURE_SECURE_VIDEO_OUTPUT(突破银行类 App 截屏限制)、INJECT_EVENTS;端云分工:每 3–5 秒上传一帧约 250KB 压缩屏幕图、云端返回约 1KB 指令;7 种指令集;虚拟屏用 DisplayManager.createVirtualDisplay(headless 模式,后台操作不干扰用户)。
- **SAEP 协议(官方一手,原文档实抓全文)**:SAEP = Screen Automation Execution Protocol,面向 GUI Agent 操作第三方应用的**声明协议**——把 App 保护要求转为机器可解析策略,系统在操作前完成 **Agent 身份校验(包名、签名、UUID、可信等级)+ 策略决策**;系统基线(身份 / 能力 / 行为三类)优先于 App 声明与 Agent 自身判断;高风险动作(支付转账、账号认证、内容发布、删除、权限变更)可强制二次确认或拒绝。
- **声明格式**:JSON,schema 固定 **"AGRP-Policy/1.0"**(Android GUI Robots Policy);静态(推荐):策略文件放 **res/raw/agent_saep_policy.json** + AndroidManifest meta-data(`com.obric.agentrobots.POLICY_JSON`),系统在**安装 / 更新时读取缓存,不依赖 App 进程启动**;动态更新:ContentProvider 提交完整 JSON + 递增 version。
- **三级作用域**:App 级(global_disable / screenshot_disable / input_disable)、Activity 级(page_scope)、Intent 级(agent_intents,枚举 modify_content / post_content / delete_content / account_incentive 等)。
- **决策四档**:ALLOW / BLOCK / CALL_USER / CLARIFY(CLARIFY 语义"以目标 SDK 为准");多规则命中**取更严格值**;BLOCK 须停止自动操作、向用户说明限制、**不得换通道绕过**;CALL_USER 暂停等确认,"确认只覆盖所展示的具体步骤"。
- **审计内建**:日志含 decision_outcome、reason_code、agent_uuid、pkg_sha256、trust_level;App 只能查自身日志;留存 **60 天 / 100 MB / 10 万条**任一触发滚动删除。
- **接入与节奏**:接入六步以 `RobotsHelperStub.isRobotsEnabled(Context)` 检测开始;当前示例多为反射调用,**正式 SDK 尚未发布**;Demo:GitHub bytedance/SAEP-demo、Gitee ByteDance/SAEP-demo;开放节奏(新闻二手):30 天公示期后逐步放开三方操作权限,10-21 起对银行 / 支付 / 信托等金融类 App 主动限制自动化;此前 155 款主流 App 集体拒绝授权(搜索摘要,**待核实**)。
- **来源**(原文档 §8「材料五 豆包 / SAEP」,URL 原样保留):https://o.doubao.com/SAEP_Protocol(官方接入文档,原文档实抓全文) 、https://github.com/bytedance/SAEP-demo 、https://gitee.com/ByteDance/SAEP-demo 、https://blog.csdn.net/qq_44810930/article/details/155892192(第三方逆向分析,非官方) 、https://zhuanlan.zhihu.com/p/1990899214201418306(端侧路线分析,搜索摘要,原文未抓取)

---

## 2. Bot-only 横向对比矩阵

> 维度按消息通道能力(回调 / 长连接、流式回发、频控)、主动触达、记忆与个性化、程序化接入、生态开放度重组,拆为通道 / 触达与记忆 / 接入 / 生态两张表;内容全部取自上文画像(即原文档 §2.12 / §2.14-2.16),「—」= 源文档未提及。IM 平台行不提供产品级记忆 / 个性化,个性化由 Bot 侧自建。

### 矩阵 A:消息通道能力与主动触达

| Bot | 收消息通道(回调 / 长连接) | 流式回发 | 频控 / 限流 | 主动触达 |
|---|---|---|---|---|
| 企微智能机器人 | 双轨:单向群播 webhook;双向 API 机器人走 webhook 或 WebSocket 长连接(aibot_subscribe、30s 心跳);单机器人仅 1 连接、新连踢旧连 | 回复透传 req_id 走 stream 流式上屏,10 分钟内须 finish | 单会话回复+推送合计 30 条/分、1000 条/时 | 主动推送前提 = 用户先发过消息(24h 窗口);enter_chat 事件 5 秒内回欢迎语 |
| 钉钉机器人 | Stream 模式反向 WebSocket(dingtalk-stream SDK,免公网 IP / 域名 / 证书 / 内网穿透)或 HTTP 回调 | AI 卡片 streamMode:创建 → streamingUpdate 增量写入 → 终止,配 typingAction 打字机 | 自定义机器人 20 条/分、超限罚停 10 分钟且只能发群;服务端 API 标准版 20 QPS、IP 维度 20 秒 1 万次封 5 分钟 | —(源文档未提及) |
| 飞书机器人 | SDK 长连接(WebSocket 全双工,仅自建应用,每应用 ≤50 连接)或 webhook(公网 URL+验签解密);事件 3 秒内须处理否则重推 | CardKit v1:创建卡片 → 流式更新文本 → 完成,卡片 14 天内可更新(五家中最完整的专用 AI 流式 API) | 同用户 5 QPS;同群全体机器人共享 5 QPS;自定义 webhook 单租户单机器人 100 次/分、5 次/秒 | —(源文档未提及) |
| Telegram Bot | getUpdates 长轮询或 setWebhook HTTPS 回调(仅 443/80/88/8443、需 SSL、secret path 鉴权),二者互斥;webhook 响应体内联 API 调用 | Bot API 9.5+ sendMessageDraft / 10.x sendRichMessageDraft 原生草稿(未获独立核验,沿用材料一口径,待核实),或 editMessageText 节流编辑 | 单 chat 1 msg/s、群 20 msg/min、广播约 30 msg/s;超限 429 + retry_after;付费广播可提至 1000 msg/s(0.1 Stars/条,需 10 万 Stars 余额 + 10 万 MAU) | —(源文档未提及);群聊默认 privacy mode 限制接收范围 |
| Slack App | Events API HTTP 回调(限 30,000 events/workspace/app/60 分钟)或 Socket Mode(app-level token 换动态 WebSocket URL,免公共端点) | chat.startStream / appendStream / stopStream(2025-10;2026-04 streaming blocks) | chat.postMessage 每 channel 1 msg/s(允许短突发),429 + Retry-After;读历史 2025-05-29 起新 app 每请求 15 条、每分钟 1 次(既有外部分发安装 / 内部自建 / Marketplace 豁免) | —(源文档未提及) |
| Muse(Meta) | iOS/Android/Mac App、muse.ai、WhatsApp 触达同一驻留 VM agent;已宣布 Windows / AI 眼镜版 | —(源文档未提及) | 免费档周用量限额(材料四口径,待核实) | 关应用任务继续(驻留 VM);主动回访与未请求建议(Active Memory / Active Focus) |
| Grok Bot(xAI) | X 内置(导航栏 / @grok)+ 独立 App(iOS / Android / 桌面 / 网页);Bot 间群聊共享上下文 | —(源文档未提及) | 限高级订阅 beta 且用量单独计量(订阅档位口径待核实) | 常驻云电脑持续任务;演示过的工作流存 routine 复跑 |
| ChatGPT(Pulse / Agent Mode) | App / Web / Atlas 浏览器;曾借 WhatsApp(2026-01 退出) | —(源文档未提及) | Agent Mode 额度:Plus 40 次 / 月、Pro 400 次 / 月 | Pulse 并入统一 Scheduled Tasks 中心(2026-06),夜间异步研究→晨报 |
| Manus | Web / App;REST API 异步提交任务 | —(源文档未提及) | —(源文档未提及;API 侧单任务 prompt 约 5k token 上限见矩阵 B) | Schedules 2.0 定时 + 事件触发自动化;任务中可补指令 steering |
| Genspark(Super Agent) | Web / 移动;AI 替身电话(Call For Me) | —(源文档未提及) | —(源文档未提及) | 零配置全自动执行 |
| 星野 / Talkie(MiniMax) | 移动 App(星野 = 国内、Talkie = 海外) | —(源文档未提及) | —(源文档未提及) | 无(叙事陪伴) |
| 豆包手机助手 | 系统级 GUI:四进程(逆向口径)+ signature 级权限;每 3–5 秒上传一帧约 250KB 屏幕图、云端返回约 1KB 指令 | —(源文档未提及) | —(源文档未提及) | 跨 App 长链路任务;虚拟屏后台操作不干扰用户 |

### 矩阵 B:记忆与个性化、程序化接入、生态开放度

| Bot | 记忆与个性化 | 程序化接入 | 生态开放度 |
|---|---|---|---|
| 企微智能机器人 | —(平台未提供,源文档未提及) | 双向 API 机器人(webhook / 长连接);单向群播 webhook;媒体(image/voice/file/video)仅单聊可收;非超管机器人回调 userid 加密需转明文 | 微信生态触达、模板卡片等企业交互;弱项:长连接单实例互踢且无官方多连接负载方案 |
| 钉钉机器人 | —(平台未提供,源文档未提及) | 三形态:自定义机器人(群 webhook 单向,关键词 / 加签 / IP 白名单三选一)、企业内部应用机器人(双向单聊+群聊)、AI 助理(开箱即用智能体平台);单聊仅企业内部应用机器人 | 接入门槛全场最低;组织内审批 / 日程 / 待办联动深 |
| 飞书机器人 | —(平台未提供,源文档未提及) | 自建 / 商店应用机器人(双向)+ 自定义机器人(群 webhook 单向);长连接仅自建应用、商店应用必须 webhook;集群随机单点投递、不支持广播 | 卡片组件第一梯队;消息 / 群组类接口明确不支持自行提频 |
| Telegram Bot | —(平台未提供,源文档未提及) | 官方 Bot API,无企业组织模型,AI Agent 最常用的一线接入入口 | 接入零门槛、生态与第三方库最丰富;无企业权限体系、发送阈值未文档化、文件下载 ≤20MB / 发送 ≤50MB |
| Slack App | —(平台未提供,源文档未提及) | bot 即 Slack App:Bolt + Events API / Socket Mode + Web API tier 限流 + Block Kit;bot token 只能读其已加入的会话 | Block Kit 与企业 SaaS 生态最强;按 method×workspace×app 限流清晰可预期;官方文档站迁移老链接大量 404 |
| Muse(Meta) | 跨会话记忆面板(查看 / 编辑 / 遗忘);官方帮助页含 Memory.md 及 Soul.md / Identity.md、「生活中每个人一页」per-person pages(后台约每小时分析更新);已知缺陷:上下文压缩会丢失确认规则 | 本体无 API;Meta Model API 开放 Muse Spark / Wonder 推理(兼容 Responses / Chat Completions / Messages);Muse Connector 平台(2026-09-18 起);可经 Muse Code 间接驱动 | WhatsApp / IG / Meta 账号直接触达,分发极强;守门仅保护 Meta 自家环境(二手分析,单方陈述);隐私信任危机(越权访问报告,待核实项) |
| Grok Bot(xAI) | 跨会话记忆(2025-04 beta),回答标注引用的历史会话、可逐条删除 + Data Controls 总开关;工作流存 routine 复跑 | OpenAI 兼容 API(api.x.ai/v1,tool calling / 结构化输出);Agent Tools API(X 搜索 / 网页浏览 / 远程代码执行 / 文档检索,按成功调用约 $5/千次);Bot 本体无公开 API | 独家实时 X 数据与社交情报;企业集成与产品打磨不及 ChatGPT;记忆初期排除欧盟 / 英国 |
| ChatGPT(Pulse / Agent Mode) | 保存记忆 + 引用历史聊天 | 消费端无官方驱动 API;Apps SDK(MCP 扩展)+ connectors | 多渠道触达最广;连接器与应用生态规模最大;受平台政策钳制(2026-01 退出 WhatsApp) |
| Manus | append-only 上下文 + 文件系统当外部记忆,压缩可恢复(留 URL / 路径即可弃内容);会话分享与中断续跑(待核实) | 官方 RESTful API(Create Task,单任务 prompt 约 5k token 上限);无 CLI 与本地 SDK;可异步提交任务、取回产物 | 上下文工程方法论业界标杆;依赖第三方前沿模型,无自有模型纵深 |
| Genspark(Super Agent) | SecondBrain 统一记忆(邮件 / 会议 / 文件 / 聊天 / 历史项目持续喂入);Second Brain Note 录音卡把线下对话录入 | 公开 API / SDK 未见(待核实);Connectors & Integrations 管理第三方应用授权 | AI 替用户真打电话独树一帜;供应链依赖强(GPT / Twilio 等);生态锁定自家工作台 |
| 星野 / Talkie(MiniMax) | 「记忆图谱」可视化持久记忆;星念卡片可收藏交易;长对话记忆重置仍是常见投诉 | 纯 C 端 App,无 API / SDK,不可第三方驱动 | 数百万 UGC 角色共创生态与卡片交易;情感付费意愿强;监管风险高(2024-12 Talkie 美区下架) |
| 豆包手机助手 | —(源文档未提及) | SAEP 声明协议(AGRP-Policy/1.0 JSON,三级作用域,系统四档决策);正式 SDK 尚未发布,当前示例多为反射调用 | 与手机厂商合作获取系统级权限;金融类 App 主动限制自动化(10-21 起);155 款 App 集体拒绝授权(搜索摘要,待核实) |

**矩阵速读**:① 消息通道层面,五家 IM 平台已全部提供免公网收消息通道与原生 AI 流式 API,差异集中在连接数约束(企微 1 连接互踢 / 飞书 ≤50 / 钉钉与 Slack 纯出网 / Telegram 长轮询)与频控口径(见 §3)。② 主动触达层面,个人 Bot 已把「后台驻留 + 定时任务中心 + 主动推送」产品化(Muse / Grok Bot / ChatGPT / Manus),IM 平台仅企微明确 24h 主动推送窗口约束。③ 记忆层面,个人 Bot 两极分化:任务执行型(Muse / Grok / ChatGPT / Manus / Genspark)均建记忆基础设施且 Muse / Grok 支持溯源与逐条删除;陪伴型(星野 / Talkie)有记忆图谱但长对话重置未解;IM 平台侧记忆全靠 Bot 自建。④ 程序化接入两极分化:任务执行型开放(Manus REST、Meta Model API 三协议、xAI OpenAI 兼容 + Agent Tools API、ChatGPT Apps SDK/MCP),陪伴型完全封闭(星野 / Talkie、Grok Bot 本体、ChatGPT 消费端、Genspark 待核实);IM 平台全部开放官方 Bot API。

---

## 3. IM 平台 Bot 横向对比(整合精炼)

| 平台 | 收消息通道(免公网) | 原生 AI 流式 API | 发送频控 | 长连接约束 | 会话键 |
|---|---|---|---|---|---|
| 企微 | aibot WebSocket 长连接(aibot_subscribe)或 webhook(Token/AESKey 加解密) | req_id 透传 stream 流式上屏,10 分钟内须 finish | 单会话回复+推送合计 30 条/分、1000 条/时 | 单机器人仅 1 连接、新连踢旧连;30s 心跳 | 单聊/群聊;媒体仅单聊可收 |
| 钉钉 | Stream 模式反向 WebSocket(dingtalk-stream SDK)或 HTTP 回调(需公网) | AI 卡片 streamMode(创建 → streamingUpdate → 终止)+ typingAction | 自定义机器人 20 条/分(超限罚停 10 分钟);服务端 API 标准版 20 QPS | Stream SDK 纯出网 | conversationType 1 单聊 / 2 群聊;单聊仅企业内部应用机器人 |
| 飞书 | SDK 长连接(WebSocket 全双工,仅自建应用)或 webhook(验签解密) | CardKit v1 流式更新(卡片 14 天内可更新) | 同用户 5 QPS;同群全体机器人共享 5 QPS;自定义 webhook 100 次/分、5 次/秒 | 每应用 ≤50 连接;集群随机单点投递、不支持广播;事件 3 秒内须处理 | im.message.receive_v1(p2 事件模型) |
| Telegram | getUpdates 长轮询或 setWebhook(仅 443/80/88/8443、SSL) | sendMessageDraft(9.5+)/ sendRichMessageDraft(10.x,未获独立核验);editMessageText 节流兜底 | 单 chat 1 msg/s、群 20 msg/min、广播约 30 msg/s;429 + retry_after;付费广播 1000 msg/s | 长轮询 / webhook 互斥 | chat id;群聊默认 privacy mode |
| Slack | Socket Mode(动态 WebSocket)或 Events API(30,000 events/ws/app/60min) | chat.startStream / appendStream / stopStream(2025-10;2026-04 streaming blocks) | chat.postMessage 每 channel 1 msg/s(允许短突发);429 + Retry-After;读历史 15 条/请求、1rpm(2025-05-29 后新 app,豁免路径见 §1.1) | Socket Mode 免公共端点 | channel / thread |

**IM 接入共性结论**(转写自原文档 §4.4 / §4.5 / §4.12 / §4.14,均为 IM 平台章节可追溯内容):

1. **收消息免公网通道全平台普及**:企微 aibot 长连接、钉钉 Stream、飞书长连接、Slack Socket Mode、Telegram 长轮询,且与 webhook 基本互斥、连接数受限(企微单机器人 1 连接、飞书 ≤50)——webhook 网关不再是必需件。
2. **流式回复统一演进**:从"占位消息 + 节流编辑"走向平台原生专用 API(钉钉 AI 卡片 streamingUpdate、飞书 CardKit、Slack chat.startStream、Telegram sendMessageDraft、企微 aibot stream 模式),2025 年起为明显趋势。
3. **AI Agent 接入五层固定模式**:平台适配层(webhook / 长连接收消息)→ 会话映射(平台 chat/thread → Agent session key)→ 单会话串行队列(去抖 / 排队防并发编辑)→ 流式适配器(原生流式 API 优先、节流编辑兜底)→ 频控退避层(429 / Retry-After 重试)。频控共同规律是**"收严发宽"**:发送普遍压到单会话 1 条/秒量级(企微 30 条/分/会话、钉钉自定义 20 条/分、飞书同群 5 QPS、Telegram 单 chat 1 msg/s、Slack 1 msg/s/channel);群聊 / 单聊差异集中在消息可见性、能力限制、会话键三处。
4. **IM 渠道是个人 agent 的分发咽喉**:Muse 靠 WhatsApp 直达("上线 10 天登顶美区 App Store 免费榜"为材料四口径、待核实),ChatGPT 因 Meta 政策 2026-01 退出 WhatsApp——渠道即入口、主动推送受 24h 窗口约束(企微),与上两条互为印证。

---

## 4. 与 customer-agent 的对照(仅保留可追溯到 Bot 章节的借鉴点)

> 口径:每条注明来源 Bot 与机制;原文档中仅源自编程 Agent 的借鉴点(harness codec / stdio 协议、ACP、OS 级沙箱、repo-map、Condenser、能力声明注册表、会话压缩控制面、waiting_for_user 状态建模〔来源为 Copilot / Cursor〕等,原文档 §7 建议 1 / 3 / 5 / 7 / 8 / 9 / 10 / 11)**不带入**,见原文档。

| # | 借鉴点 | 来源 Bot 与机制 | 对 customer-agent 的落地(原文档锚点) |
|---|---|---|---|
| 1 | IM 回发流式适配 + 频控退避 | 五平台原生流式 API:企微 req_id stream(10 分钟 finish)、钉钉 AI 卡片 streamMode + typingAction、飞书 CardKit v1、Telegram sendMessageDraft / editMessageText 节流、Slack chat.startStream;频控协议:429 + Retry-After / 钉钉罚停 10 分钟;规律"收严发宽"(单会话 1 条/秒量级) | messaging 包 delivery 层与 channels/wecom 补流式适配器(企微 aibot req_id stream 原生流式优先、节流编辑兜底、10 分钟 finish 约束)+ 单会话串行队列 + 令牌桶 + 429 退避;"占位消息 + 节流编辑"保留为降级路径(业界答案:Telegram / Slack 都如此)(原文档建议 2) |
| 2 | 企微官方智能机器人长连接通道 | 企微 aibot:免公网 IP、原生流式、官方 SDK(@wecom/aibot-node-sdk);约束:单机器人 1 连接互踢、无官方多连接负载方案 | channels/wecom 在现有本地库 reader/sender 之外新增 aibot WebSocket 通道,评估单连接互踢与现链路的并存策略(原文档建议 4) |
| 3 | 会话映射与排队 | 原文档 §4.12 五层模式:平台 chat/thread → Agent session key 映射 + 单会话串行队列(去抖 / 排队防并发编辑) | messaging 主干(intake → routing → dispatch → delivery)已具备前三层,缺的是明示的流式适配与频控退避(原文档建议 2 展开);企微侧参数现成(30 条/分/会话、req_id stream、10 分钟 finish) |
| 4 | 主动性产品化:定时 / 事件任务中心 + IM 触达闭环 | ChatGPT Pulse 并入统一 Scheduled Tasks 中心(2026-06,夜间异步研究→晨报卡片→反馈闭环);Manus Schedules 2.0(2026-05)定时 + 事件触发;主动推送统一由用户可管理的任务面板控制 | core / broker 在 SupervisionService(10s 巡检)与 enqueueSessionGoal 目标队列之外,补"用户可见的定时任务中心"(定时 + 事件触发、主动推送开关),与 IM 主动推送组合成"定时任务→IM 触达"闭环;注意企微等平台主动推送的 24h 窗口约束(原文档建议 12) |
| 5 | 长期记忆基础设施化:查看 / 编辑 / 遗忘面板 + 引用溯源 + 逐条删除 | Muse 记忆面板(查看 / 编辑 / 令其遗忘;Memory.md / per-person pages);Grok 回答标注引用了哪些历史会话 + 逐条删除;星野「记忆图谱」可视化持久记忆;Genspark SecondBrain 统一记忆 | core 记忆模型 + webapp UI 补记忆面板;溯源交互参照 Grok 对话级标注、Muse 人 / 页面级;需区分「从 prompt 移除」与「物理删除」两种删除语义(原文档建议 13;注:数据模型选型〔one-file-per-memory + frontmatter、200 行 / 25k code units 加载预算〕源自编程 agent Qwen Code,见原文档表 6 / 建议 13,本文不展开) |
| 6 | 敏感动作「模型外守门」 | Muse Sentinel:独立宿主侧 agent 作为唯一权限权威;surrogation 凭据代换(凭据对 agent 不可见,prompt injection 在原理上无效);tainted egress 污点追踪治理审批噪音("把摩擦放在 consent 真正重要的地方");三档 allowed / denied / ask + 五种授权粒度(capability 语义);系统级 dialog 而非聊天消息;全程审计日志 | 审批从 harness 内 request-approval 升级为 broker 侧独立守门进程;进程拓扑参照 §1.2 Muse Sentinel 节(systemd-nspawn cell + 独立安全 systemd unit + Unix domain socket SO_PEERCRED IPC);审批先做三档 + 五种授权粒度;审计日志落 SQLite;messaging 已强制 request-approval,是雏形(原文档建议 14) |
| 7 | 多渠道触达矩阵 | Muse 靠 WhatsApp 直达 vs ChatGPT 因 Meta 政策 2026-01 退出 WhatsApp——正反例说明防单平台政策钳制、自持渠道与官方 bot 通道并重;Genspark Call For Me(AI 替身电话,双层:Realtime API + shadow model 纠偏) | messaging 包作为渠道适配层,新增钉钉 / 飞书 / Slack 渠道直接套 §3 五层模式(与借鉴点 1 协同);AI 替身电话列远期观察(原文档建议 15) |
| 8 | 端侧声明式策略 SAEP | 豆包手机助手 / SAEP:App 以 AGRP-Policy/1.0 JSON 声明三级作用域(App / Activity / Intent),系统四档决策(ALLOW / BLOCK / CALL_USER / CLARIFY)+ 审计内建(60 天 / 100MB / 10 万条滚动删除) | packages/mobile(Capacitor 即标准 Android 工程):静态接入只需 res/raw/agent_saep_policy.json + manifest meta-data,无需原生代码;启动时 isRobotsEnabled 检测后回退;注意 Activity 级粒度对 Capacitor SPA(单 MainActivity)先天受限;正式 SDK 未发布,先跟踪 bytedance/SAEP-demo(原文档建议 16) |
| 9 | 「人—agent—专属 VM」三层架构 | Muse(每用户 Muse Secure VM)与 Grok Bot(每 Bot 独立云电脑):agent 不住手机而住每用户隔离 VM,多端(App / 网页 / IM)只是同一驻留体的入口,关应用任务继续 | 与本项目 broker detached 进程形态同构,只是驻留体从本机 broker 换成云 VM(原文档 §4.15) |
| 10 | 多 Bot 群聊协作参照 | Grok Bot:多 Bot 群聊共享上下文 + "演示一次存为 routine"自动化 | 与本项目 CollaborationService 互为对照(原文档 §4.15) |

---

## 5. 参考来源汇总

> 仅列 Bot 相关分组,URL 自原文档 §8 原样保留;编程 Agent 相关分组(Claude Code / Codex CLI / GitHub Copilot / Cursor / Gemini CLI / Aider / OpenHands / SWE-agent / DeepSeek / 智谱 GLM / Qwen Code / 材料三新增来源)见原文档。

**IM 平台**

- 企微:https://developer.work.weixin.qq.com/document/path/101463 、/91770 、/93239(前缀 https://developer.work.weixin.qq.com/document/path)
- 钉钉:https://open.dingtalk.com/document/orgapp/configure-stream-push 、https://open.dingtalk.com/document/resourcedownload/Introduction-to-stream-mode 、https://open.dingtalk.com/document/development/api-streamingupdate 、https://open.dingtalk.com/document/development/typewriter-effect-streaming-ai-card 、https://open.dingtalk.com/document/isvapp/invocation-frequency-limit-1 、https://open.dingtalk.com/document/isvapp/robot-receives-message 、https://open.dingtalk.com/document/orgapp/types-of-messages-sent-and-received-by-robots 、https://open.dingtalk.com/document/development/how-to-process-api-throttling-on-the-dingtalk-server
- 飞书:https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN 、https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control 、https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview 、https://open.feishu.cn/document/feishu-cards/update-feishu-card?lang=zh-CN 、https://open.feishu.cn/document/server-docs/im-v1/message/reply
- Telegram:https://core.telegram.org/bots/faq 、https://core.telegram.org/bots/api 、https://gramio.dev/updates/webhook
- Slack:https://docs.slack.dev/apis/web-api/rate-limits 、https://docs.slack.dev/changelog/2025/10/7/chat-streaming 、https://docs.slack.dev 、https://www.conferbot.com/limits/slack 、https://www.reddit.com/r/openclaw/comments/1rpvv7r/openclaw_slack_in_2026_the_rate_limit_problem
- Slack 回源(材料三):https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps 、https://docs.slack.dev/reference/methods/conversations.history 、https://docs.slack.dev/apis/web-api/rate-limits

**Muse(Meta)**(含 Sentinel 与记忆)

- https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent 、https://ai.meta.com/muse 、https://www.meta.com/zh-cn/help/subscriptions/1021145227643680/ 、https://www.datacamp.com/zh/tutorial/meta-muse-tutorial 、https://dev.meta.ai/docs/overview 、https://about.fb.com/news/2026/10/introducing-muse-wonder-models 、https://research.meta.ai/blog/muse-wonder 、https://www.reuters.com/business/meta-launches-ai-agent-that-can-access-other-apps-send-emails-make-payments-2026-09-08
- Sentinel:https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse(官方工程博客《How We Built Safety Into Muse》,2026-09-08) 、https://www.impart.ai/blog/meta-sentinel-ai-agent-security(二手分析,单方陈述) 、https://www.tdcommons.org/cgi/viewcontent.cgi?article=13949&context=dpubs_series(TDCommons《Receipt-Gated Staged Execution for AI Agents》,PDF 被 Cloudflare 挑战页拦截未读原文)
- 记忆:https://www.meta.com/help/superintelligence/2225571704857152/ 、https://www.techtimes.co.uk/meta-muse-ai-profiles-users-contacts-1808986(WIRED 系经 techtimes 二手转引,原文档清单未列 WIRED 原文)

**Grok Bot(xAI)**(含记忆)

- https://x.ai/news/introducing-grok-bot 、https://x.ai/news/grok-4-1-fast 、https://docs.x.ai/overview 、https://x.ai/news/grok-3 、https://x.ai/news/grok-4 、https://x.ai/api 、https://techcrunch.com/2025/04/16/xai-adds-a-memory-feature-to-grok 、https://www.datacamp.com/blog/grok-vs-chatgpt 、https://apipass.dev/blogs/grok-vs-chatgpt-2026-guide 、https://www.reddit.com/r/grok/comments/1k6pbrj/

**ChatGPT(Pulse / Agent Mode)**

- https://openai.com/zh-Hans-CN/index/introducing-chatgpt-pulse 、https://openai.com/index/introducing-chatgpt-agent 、https://help.openai.com/en/articles/11752874-chatgpt-agent 、https://openai.com/index/chatgpt-whatsapp-transition 、https://openai.com/index/introducing-apps-in-chatgpt 、https://itbrief.com.au/story/openai-expands-chatgpt-scheduled-tasks-with-new-hub

**Manus**

- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus 、https://manus.im/docs/integrations/manus-api 、https://open.manus.ai/docs/v1/create-task 、https://manus.im/blog/manus-schedules 、https://manus.im/docs/features/wide-research

**Genspark**

- https://openai.com/index/genspark 、https://www.genspark.ai/helpcenter/secondbrain 、https://www.genspark.ai/tools/ai-phone-call 、https://aimagazine.com/news/genspark-how-the-ai-workspace-hit-at-us-2-6bn

**星野 / Talkie(MiniMax)**

- https://www.talkie-ai.com 、https://play.google.com/store/apps/details?id=com.weaver.app.prod 、https://www.moomoo.com/hans/news/post/72486374 、https://www.cls.cn/detail/2095611

**豆包 / SAEP(端侧触达)**

- https://o.doubao.com/SAEP_Protocol(官方接入文档,原文档实抓全文) 、https://github.com/bytedance/SAEP-demo 、https://gitee.com/ByteDance/SAEP-demo 、https://blog.csdn.net/qq_44810930/article/details/155892192(第三方逆向分析,非官方) 、https://zhuanlan.zhihu.com/p/1990899214201418306(端侧路线分析,搜索摘要,原文未抓取)

---

## 6. 待核实项(Bot 相关,转写自原文档 §8,2026-11-07 补充轮后)

- Telegram sendMessageDraft / sendRichMessageDraft 原生草稿 API 因抓取超时未获独立核验,原文档 §2.12 / 表 3 沿用材料一口径。
- 材料四(个人 agent)内置待核实项:星野六机制出处未取原文链接(搜索摘要引述);Manus 会话分享 / 中断续跑细节待核实、公司主体 Butterfly Effect 未单独核实;Genspark 公开 API / SDK 未见待核实;Grok 4.5 移除语音人格(2026-07 报道)待核实。
- 材料五内置待核实项:Muse 审批"四档"未在官方原文逐字出现(已按三档 allowed / denied / ask + 五种授权粒度更正,疑对应四层放行来源);Sentinel pending approval 持久化、Confidential VM 密钥托管 / attestation 协议官方未披露;豆包"行业首款系统级 GUI Agent"定义与四进程 / signature 权限为非官方逆向来源;SAEP 的 CLARIFY 档语义、正式 SDK 未公开;TDCommons《Receipt-Gated Staged Execution for AI Agents》PDF 被 Cloudflare 挑战页拦截未读原文(https://www.tdcommons.org/cgi/viewcontent.cgi?article=13949&context=dpubs_series);"155 款 App 集体拒绝授权"仅为搜索摘要。
- 第三轮审读复核(2026-11-07)中 Bot 相关项:『10 天登顶美区 App Store 免费榜』『Meta 股价单月涨约 20%』『WSJ 有信任问题专文』『Secure VM 约 8GB 内存』『Stripe Link』『仅美加后扩新加坡』『Atlas 被整合裁撤』『Genspark 9 LLM / 80 工具、Agent 365 启动伙伴、Twilio 合作』『Grok Bot "Cursor 系套餐"(疑转写笔误,x.ai 抓取被拒未回源)』『grok-4.7 500k 上下文』均无来源条目支撑,维持待核实;发布稿实抓确认日期 / Spark / Secure VM / Sentinel / WhatsApp / AI 眼镜预告吻合,但无 "Your Personal AI Agent" 口号、无订阅定价(research.meta.ai 与 x.ai 本轮抓取失败未能在线复核)。
