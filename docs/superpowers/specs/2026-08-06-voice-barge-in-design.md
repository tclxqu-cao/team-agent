# Voice Barge-In Design

## Goal

唤醒产生的双向语音会话中，AI 正在播报时检测到用户开口，应立即停止旧播报，继续录完整句话并自动作为同一会话的下一轮输入；下一轮回答完成后继续播报。

## Architecture

Swift helper 增加 `barge-in` 模式。TTS 开始时主进程不再让麦克风完全停机，而是重启 helper 到该模式；helper 开启 voice processing，并在连续人声达到门限时先发 `BARGE_IN`，随后继续录制同一 CAF 片段直到静音，再输出 `TEXT/FINAL`。主进程收到 `BARGE_IN` 立即终止当前 `say`，把后续 final 转成现有 `wake:command`，从而复用同 session 的 conversation 路由。

键盘发送和点击输入框麦克风也立即调用 `tts:stop`，作为确定性打断入口。Web Speech fallback 行为不变。

## State Flow

1. `tts:speak` 启动 `say`，设置 `ttsSpeaking=true`，helper 切换为 `barge-in`。
2. helper 使用 voice processing、较严格门限和连续帧判定过滤 TTS 回声。
3. 检测到用户开口后发送 `BARGE_IN`，继续保留当前录音。
4. main 终止旧 `say`，清理 grace timer，保持 helper 和录音不变，并进入 follow-up capture。
5. helper 在用户停顿后输出 `FINAL`；main 通过 `wake:command` 自动发送同一轮输入。
6. 新回答完成后现有 autoSpeak 再次调用 `tts:speak`。

## Error Handling

- voice processing 无法启用时记录 `ERROR voice-processing`，仍保留键盘发送和麦克风按钮打断。
- 只有 conversation 模式中的 TTS 启用自动抢话，普通手动播报不自动把环境声音发送成消息。
- 旧 `say` 的 exit 回调必须通过进程身份校验，不能结束或重启新一轮 TTS/helper。
- TTS 回声不得触发 `BARGE_IN`；连续人声判定在单元测试中固定验证，真人扬声器链路再做最终验收。

## Verification

- 纯状态测试：TTS + conversation + `BARGE_IN` 会停止旧播报并保留捕获；无 conversation 时忽略自动抢话。
- Swift 编译及 helper 协议测试：`BARGE_IN` 先于该片段的 `FINAL`。
- renderer 测试：发送文字或开始 dictation 会调用 `ttsStop`。
- 运行态：启动长 TTS，真人中途说新问题，日志证明旧 `say` 被终止、同一句 final 进入同 session，下一轮回答重新播报。
