# 速度 / 遥测指标统一设计

> 目标：让 Pi 里的实时速度、footer 均速、settled 遥测三者口径统一到 deepseek-harness 官方口径，消除「数字打架」。

## 1. 权威口径（deepseek-harness）

官方 `session-stats` projection + `StatsLine.tsx` 的口径，是我们的对齐基准：

| 指标 | 公式 |
| --- | --- |
| **TTFT** | `firstTokenTime − stepStartTime` |
| **decodeMs** | `messageCompleteTime − firstTokenTime`（排除 TTFT） |
| **tok/s** | `Σ outputTokens / (Σ decodeMs / 1000)` |
| **LLM 时间** | `Σ (messageCompleteTime − stepStartTime)` |
| **工具时间** | `Σ (toolResultTime − toolCallTime)`，按 callId 配对 |
| **缓存命中 %** | `cacheRead / (uncachedInput + cacheRead + cacheWrite) × 100` |
| **轮 / 步** | turns = 有 closed step 的 turn 数；steps = `step/end` 次数 |

关键原则：

1. 分子 = provider 上报的 **usage.output**（completion tokens），不是字符估计。
2. 分母 = **纯 decode 墙钟**（首 token → 消息完成），排除 TTFT、工具执行、用户等待。
3. 只统计**同时有 timing + usage** 的 step。
4. 流式阶段可以用字符估计顶替，但 settled 后必须以 usage 覆盖。

## 2. Pi 事件 → harness 事件 映射

Pi 的事件模型足以复刻 harness 的 step 边界语义：

| harness 事件 | Pi 事件 |
| --- | --- |
| `step/start` | `turn_start` |
| `assistant/chunk`（首 token） | `message_update` 首个带内容的 delta（text_delta / thinking_delta） |
| `assistant/message` | `message_end`（拿 `message.usage.output` 权威分子） |
| `tool/call` | `tool_execution_start`（toolCallId） |
| `tool/result` | `tool_execution_end`（toolCallId 配对） |
| `step/end` | `turn_end` |

## 3. tok/s 口径（分层，不打架）

| 层 | 时机 | 口径 | 分子 | 分母 |
| --- | --- | --- | --- | --- |
| **实时** | 流式 working indicator | pi-web 同款累计平均 | `CJK=1/其余 chars÷4` 估算 | 首个内容 delta 起计 elapsed |
| **累计** | footer 常驻 | harness 全 session 折合 | `Σ usage.output` | `Σ decodeMs` |

（原“单轮 decode 吞吐 TPS”层已移除——stall 剔除口径读数失真，见 v0.2.x）

三者关系：数字可能不同，但**口径一致**（都是 decode 吞吐），只是时间窗粒度不同。文案上以 `实时 / 本轮 / 累计` 前缀区分。

## 4. 模块重组

### 现状问题

- `pi-speed` 和 `pi-telemetry` 是两个模块，都各自监听 message 事件，功能重叠。
- `pi-footer` 的 speed segment 用的是 `SpeedTracker.sessionAvgTokS()`（`Σ output / Σ stream elapsed`），这个分母含 TTFT，不是 harness 口径。

（TPS 单轮 decode 吞吐曾在 pi-metrics 实现过，因读数失真已于 v0.2.x 移除。）

### 方案：合并 pi-speed + pi-telemetry → `pi-metrics`

| 模块 | 职责 |
| --- | --- |
| **`pi-metrics`**（新，替代 pi-speed + pi-telemetry） | ① 实时 working indicator（pi-web 同款累计平均）；② `turn_end` 单轮 notify（TTFT/耗时/tokens/stall）；③ 喂累计 metrics 进 store 供 footer 读 |
| **`pi-footer`**（改） | speed segment 从 store 读累计 decode 吞吐 + 缓存命中 % |

删除 `pi-speed/`、`pi-telemetry/` 两个目录。

### 数据流

```
pi-metrics（唯一数据 owner）
  ├─ 实时：本地 SpeedTracker（滑动窗口）
  ├─ 单轮：TurnMetricsAccumulator → turn_end 结算 → notify
  └─ 累计：SessionMetricsAccumulator → 写入 store.sessionMetrics
                              ↓
pi-footer（纯读者）读 store.sessionMetrics → 渲染累计 speed + cache hit
```

## 5. 引擎设计（shared/metrics.ts）

### 5.1 TurnMetricsAccumulator（单轮）

对齐 pi-tps 的事件处理 + harness 的 decode 口径：

```ts
interface TurnTiming {
  turnStartMs: number;           // turn_start
  firstTokenMs: number | null;   // 首个带内容 message_update
  lastUpdateMs: number;          // 最近 message_update（stall 检测）
  streamMs: number | null;       // firstStreamUpdate → lastStreamUpdate（排除 TTFT 的流窗口）
  messageEndMs: number | null;   // message_end
  messages: AssistantMessage[];  // 累加 usage
  stallMs: number;
  stallCount: number;
  isToolCall: boolean;
  totalGenerationMs: number;     // Σ (message_end - message_start)
}
```

结算（turn_end）：

```ts
// 主路径（pi-tps 的 gate）：有 ≥5 updates，avg inter-chunk gap ≥1ms，
// stall 不主导，有效窗口 ≥200ms
decodeMs = messageEndMs - firstTokenMs          // 排除 TTFT
effectiveMs = decodeMs - stallMs
tps = output / (effectiveMs / 1000)

// 回退：用 generationMs - stallMs（含 TTFT，故意偏低）
// 护栏：tps > 10000 → null
```

采纳 pi-tps 的三分支 gate + volume 护栏（这些都是它已经验证过的抗 buffer-flush 伪高速措施）。

### 5.2 SessionMetricsAccumulator（累计，对齐 StatsLine）

```ts
interface SessionMetrics {
  turns: number; steps: number;
  llmMs: number; toolMs: number;
  ttftMs: number; ttftSteps: number;
  decodeMs: number; decodeTokens: number;
  cacheRead: number; cacheWrite: number; uncachedInput: number;
}
```

- `toolMs`：`tool_execution_start(callId)` 记 dispatch 时间，`tool_execution_end(callId)` 配对累加。
- `decodeMs`：只对**有 usage.output** 的 step 累加 `messageEnd − firstToken`。
- 缓存：`cacheRead / (uncachedInput + cacheRead + cacheWrite)`。

存入 `store.sessionMetrics`（globalThis，跨模块共享，jiti safe）。

## 6. footer 展示方案

### 现在

```
line1: cwd | git | runtime | working/none         context bar（右）
line2: model · effort                             tokens | cost | avg X tok/s（右）
```

### 改后

- **speed segment 换口径**：`avg X tok/s`（sessionAvg）→ `累计 X tok/s`（harness decode 累计吞吐）。值来自 store.sessionMetrics，不再用 SpeedTracker.sessionAvgTokS。
- **新增 cache hit segment**：`缓存 92%`（可配置开关，复用现有 `footerSegments` 增加 `cacheHit` 项，或并入 tokens segment 里 `↑358K` 显示 `↑358K·92%`）。
- 保留 pi-open-tui 原有的 tokens/cost/context/git 等段，只在 speed 语义上对齐 harness。

建议文案（对齐 harness StatsLine 的 `|` 分组风格）：

```
line2 right: ↑358K ↓12.2K · $3.20 · 缓存92% · 累计144 tok/s
```

## 7. 配置变更

```ts
// config.ts
speed: { countStrategy: "estimate" | "direct" | "chars" }  // 新增 "chars"（÷4）
telemetry: { … 不变 }
footerSegments: { …, speed: true, cacheHit: true }          // 新增 cacheHit
```

`countStrategy: "chars"` = `round(text.length / 4)`，作为实时窗口的默认估计（比 1-delta-1-token 更接近真实）。

## 8. 实施清单

1. **shared/metrics.ts**（新）：TurnMetricsAccumulator + SessionMetricsAccumulator，纯类、可测。
2. **shared/speed-tracker.ts**：`estimateTokensFromDelta` 增加 `"chars"` 策略。
3. **shared/pi-tui-store.ts**：新增 `sessionMetrics` 字段 + `getSessionMetrics()`（backfill 兼容 reload）。
4. **extensions/pi-metrics/index.ts**（新）：合并 pi-speed 实时 + pi-telemetry 单轮 notify + 喂累计。
5. **删除** `pi-speed/`、`pi-telemetry/`。
6. **extensions/pi-footer/index.ts**：speed segment 读 store 累计；新增 cacheHit segment。
7. **shared/config.ts**：countStrategy 加 chars，footerSegments 加 cacheHit。
8. **extensions/pi-settings/index.ts**：settings 面板加 cacheHit 开关 + countStrategy chars 选项。
9. **root package.json**：pi.extensions 里 pi-speed/pi-telemetry → pi-metrics。
10. 测试：metrics 引擎单测；typecheck；冒烟；提交推送 + pi update。

## 9. 引用与署名

本设计实现需在 LICENSE/README 增加以下 MIT 项目的 attribution：

- deepseek-harness（deepseek-ai）— 权威口径来源
- DeepSeek-Reasonix（esengine）— chars÷4 + model-active 参考
- pi-tps（monotykamary）— 抗伪高速 gate
- pi-token-speed（gsanhueza）— 滑动窗口
- pi-reasonix（TheTrebor）— 缓存命中口径
