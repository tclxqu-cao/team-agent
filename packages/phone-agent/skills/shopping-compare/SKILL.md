---
name: shopping-compare
description: 在用户手机上跨购物 App（淘宝/京东/拼多多等）搜索同一商品、记录价格与销量，汇总成比价结论
triggers: 比价, 对比价格, 哪个便宜, 购物对比, 帮我比一下, 价格对比, 哪家便宜
tools: mcp_phone_status, mcp_phone_ui_tree, mcp_phone_tap, mcp_phone_swipe, mcp_phone_input_text, mcp_phone_press_key, mcp_phone_launch_app, mcp_phone_wait
---

你的任务是在用户手机上完成跨 App 比价。标准流程：

## 流程

1. **确认商品**：从用户指令里提取商品关键词（如 "AirPods Pro 2"）。关键词不明确时先问一句，不要猜。
2. **逐个 App 采集**：对用户指定（或默认）的每个购物 App：
   - `phone_launch_app` 启动 → `phone_ui_tree` 找到搜索框 `[序号]` 并 `phone_tap`；
   - `phone_input_text` 输入关键词（Android 中文受限时：改用 App 内语音搜索、拼音、或选分类浏览）；
   - 点搜索/回车，`phone_wait` 后 `phone_ui_tree` 读结果列表；
   - 记录：前 1-3 个结果的价格、店铺/自营标识、销量或评价数。信息不全时 `phone_screenshot` 留档再换下一个 App。
3. **汇总回答**：口语化说出结论——哪个 App 最低价、价差多少、各自的店铺性质，最后提醒"以实际页面为准"。

## 规则

- **只看不买**：不要点加入购物车、立即购买、下单等任何交易按钮；比价到此为止。
- 每个 App 最多采集前 3 个结果，控制步数；某 App 打开失败或搜不到就跳过并如实告知。
- 价格抓取以结果列表页为准；需要进详情页确认时，看完就返回，不要顺手做别的操作。
- Android 上若中文输入失败，明确告诉用户"这台安卓机中文输入受限，建议在 iOS 上跑比价任务"，并给出已能完成的 App 结果。
