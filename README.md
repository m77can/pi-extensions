# pi-extensions

Pi 扩展集合，通过 `pi install git:...` 一个入口统一安装管理。

## 安装

```bash
pi install git:github.com/m77can/pi-extensions
```

## 扩展列表

| 模块 | 职责 | UI 槽位 |
| --- | --- | --- |
| `pi-header` | logo + model + effort + cwd + slash tips | `setHeader` |
| `pi-editor` | 圆角边框编辑器（Container + DynamicBorder，圆角由 pi-chrome 统一画）+ 光标样式 + 全屏滚轮 | `setEditorComponent` |
| `pi-footer` | cwd/git/runtime/context/tokens/扩展状态（tokens 块内显示最近一轮缓存命中率，provider 上报缓存 token 时） | `setFooter`（唯一 owner） |
| `pi-metrics` | 实时 tok/s（working indicator，pi-web 同款累计平均）+ 每轮 TTFT/stall/耗时/tokens 通知 + 累计 metrics | `setWorkingMessage` / `notify` |
| `pi-settings` | `/pi-tui` 设置面板，统一开关各模块 | 命令 `/pi-tui` |
| `pi-router-spec` | 首轮 Recon 侦察 → 全量续跑，按模型门控重构 payload | provider payload |
| `pi-ask` | `ask_user_question` 工具：圆角问卷 UI（Container + DynamicBorder，圆角由 pi-chrome 统一画），schema/envelope 对齐 rpiv-ask 契约 | 工具 + `ctx.ui.custom` 面板 |

## 目录结构

```
shared/       # 纯函数库：config/store/metrics/git/runtime/icons/utils/speed-tracker
extensions/   # 所有 pi-* 模块扩展入口（一目录一 index.ts）
docs/         # 设计文档
tests/        # 单元测试
```

## 结构与配置约定

- 根 `package.json` 的 `pi.extensions` 显式列出所有扩展入口，各自 `export default function(pi)`，无需构建。
- 扩展内部相对 import 统一写 `.js` 后缀，pi 的 jiti loader 自动映射到同目录 `.ts`。
- 配置统一存 `~/.pi/agent/pi-tui.json`，含 `modules`（各模块总开关）、`footerSegments`（footer 段开关）、`speed`（实时速度参数）、`telemetry`（遥测开关）等区块。
- footer 是单例（`setFooter` 互相覆盖），只有 `pi-footer` 调用它；实时速度走 `pi-metrics` 的 working indicator，与 footer 无冲突。
- 速度/遥测指标口径对齐 deepseek-harness 官方实现（详见 `docs/metrics-design.md`）。

## 本地开发

```bash
npm install
npm run typecheck
npm test

# 不安装直接试跑
pi -e ./extensions/pi-footer/index.ts
```

## 更新

```bash
pi update --extension git:github.com/m77can/pi-extensions
```

## Acknowledgements

本项目功能源自以下 MIT 许可的 Pi 社区项目：

- [pi-open-tui](https://github.com/OldSuns/pi-open-tui)
- [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)：`pi-ask` 的工具 schema 与 LLM 返回 envelope 契约对齐该项目，渲染层为自研圆角 UI
- [pi-haiku](https://github.com/nnocte/pi-haiku)
- [pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)
- [pi-zentui](https://github.com/lmilojevicc/pi-zentui)
- [pi-tps](https://github.com/monotykamary/pi-tps)

## License

[MIT](./LICENSE)
