# 技术沉淀自动捕获 — 设计规格

## 目标

让所有 AI 编码工具（Qoder、Claude Code、Codex 等）在完成实质性任务后，自动识别对话中的技术价值点，经用户确认后沉淀到 Obsidian wiki 的 `person/` 目录。

## 背景

- 统一规则文件 `~/.obsidian/wiki/references/ai-assistant-rules.md` 已通过软链接被所有 AI 工具共享
- Wiki 框架基于 [ar9av/obsidian-wiki](https://github.com/ar9av/obsidian-wiki)（Karpathy LLM Wiki 模式）
- 现有 `wiki-capture` 技能面向 wiki 主分类目录（synthesis/concepts 等），格式和写入位置与 `person/` 不匹配
- `person/` 目录已有独立的文章格式（参考 `claude-code-dynamic-workflow.md`）

## 架构

```
ai-assistant-rules.md（规则层 — 3 行触发规则）
    ↓ 自动触发
wiki-person-capture 技能（能力层 — SKILL.md）
    ↓ 写入
~/.obsidian/wiki/person/<slug>.md
```

### 设计原则

- **先软后硬**：先用规则驱动，观察模型遵守率，不够再加 Hook 强制
- **规则极简**：规则文件只加触发指令，所有逻辑在技能中
- **跨工具统一**：通过共享规则文件 + 技能软链接，所有工具行为一致

## Task 1：新建 wiki-person-capture 技能

### 文件位置

`~/.obsidian/wiki/skills/hot/wiki-person-capture/SKILL.md`

通过已有软链 `~/.qoder/skills → ~/.obsidian/wiki/skills/hot` 自动被 Qoder 加载。
Claude Code 和 Codex 通过 `ai-assistant-rules.md` 中的规则指引读取此文件。

### 技能核心逻辑

#### 触发时机

每次完成实质性任务后（非简单问答），AI 主动扫描本次对话。

#### 判断标准

命中任一条即触发：
- 可复用的架构设计或设计模式（如策略模式在特定场景的落地方式）
- 复杂问题的排查与解决过程（如内存泄漏定位链路）
- 框架/工具的隐藏机制或反直觉行为
- 性能优化方案与量化结果
- 技术选型对比与决策依据
- 踩坑经验与 workaround

不沉淀：
- 常规 CRUD 实现、标准 API 用法
- 可直接从官方文档查到的内容
- 纯业务逻辑，无技术通用性

#### 确认流程

1. AI 展示技术点摘要列表
2. 用户确认（可选择性沉淀部分）
3. 按模板写入文件

#### 文件格式

frontmatter（对齐现有 person/ 风格）：

```yaml
---
title: <中文标题>
summary: <一句话摘要，≤200字符>
base_confidence: <0.7-0.95，基于内容深度和可复用性>
lifecycle: active
provenance: ai-collaboration
source_author: <用户名>
source_date: <YYYY-MM-DD>
tags: [<2-5个英文标签>]
---
```

正文结构：

```markdown
# <标题>

> AI 协作沉淀 · <日期> · 来源项目：<项目名>

## 背景

<问题/场景简述，2-3 句话>

## 核心技术点

<方案/设计/机制的详细描述，这是文章的主体>

## 关键代码/配置（如有）

<代码片段或配置示例>

## 设计启示

<可复用的经验总结，bullet points>
```

#### 文件命名

`person/<english-kebab-case-slug>.md`

示例：`react-concurrent-batching-rules.md`、`sqlite-wal-mode-pitfalls.md`

## Task 2：更新统一规则文件

### 文件

`~/.obsidian/wiki/references/ai-assistant-rules.md`

### 新增内容

在现有 `Wiki Knowledge Base Rules` 章节之后追加：

```markdown
# 技术沉淀自动捕获
每次完成实质性任务后，主动检查本次对话是否包含值得沉淀到 person/ 的技术价值点（架构设计、踩坑经验、框架机制、性能优化等）。
如有，调用 `$wiki-person-capture` 技能执行沉淀；如当前工具不支持 skill 调用，则读取 `~/.obsidian/wiki/skills/hot/wiki-person-capture/SKILL.md` 按其流程执行。
```

## Task 3：验证与观察

- 在 Qoder 中验证技能是否被加载（通过 `~/.qoder/skills` 软链）
- 在 Claude Code / Codex 中验证规则是否触发自动检查
- 观察 1-2 周的模型遵守率
- 如遵守率不足，再追加 Claude Code / Codex 的 Stop Hook 强制触发

## 不做的事

- 不修改现有 `wiki-capture` 技能
- 不新增 Convention 文件（技能本身即 convention）
- 不配置 Stop Hook（先软后硬，观察后再决定）
