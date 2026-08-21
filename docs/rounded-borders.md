# DynamicBorder 圆角化调研

> 目标：把 pi TUI 里成对出现的 `────` 分隔线（/reload 提示框、What's New、各 selector 等）改成圆角 `╭──╮` / `╰──╯`，与 pi-editor 扩展已有的圆角输入框风格统一。

调研对象版本：`@earendil-works/pi-coding-agent` **0.84.2** / `@earendil-works/pi-tui` **0.84.2**。

## 1. 结论先行

| # | 方案 | 覆盖范围 | 成本 | 结论 |
| --- | --- | --- | --- | --- |
| A | 上游 PR：`DynamicBorder` 加 `position` 参数（或新增 `RoundedBorder`） | 全部 ~53 处调用点 | 中（53 处机械标注 + PR 沟通） | **正路，长期解** |
| B | 本地 patch 用户实际运行的 dist 文件（fnm 全局目录） | 同 A，但升级即丢 | 低（脚本化 ~100 行） | **短期立即可用，推荐先做** |
| C | 纯扩展 API 实现 | 几乎为零 | — | **不可行**，API 无此钩子（见 §4） |

推荐路径：**B（立即）→ A（长期）**。B 的 patch 内容与 A 的上游改动保持同一形态，将来 PR 合并后直接删 patch。

## 2. DynamicBorder 是什么

pi 本体组件，**不在本仓库**：

```
node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/dynamic-border.js
```

完整实现（0.84.2，共 20 行）：

```js
import { theme } from "../theme/theme.js";

export class DynamicBorder {
    color;
    constructor(color = (str) => theme.fg("border", str)) {
        this.color = color;
    }
    invalidate() {}
    render(width) {
        return [this.color("─".repeat(Math.max(1, width)))];
    }
}
```

要点：

- `render(width)` 每帧以视口宽度重画一条 `─` 线，颜色由构造参数 `color` 决定（默认主题 `border` 色）。
- 组件本身**无状态**：不知道自己是上边还是下边，也无法感知配对的另一条线——这是圆角化必须逐调用点标注的根本原因。
- 已从 `@earendil-works/pi-coding-agent` 主入口导出（CHANGELOG: "Exported all UI components for extensions"），扩展可以 import，但拿到的是 jiti 独立模块缓存里的**另一份类**（见 §4），patch 它不影响 pi 本体。

## 3. 全部出现位置（"两条线"都在哪）

### 3.1 interactive-mode.js（12 处 `new`）

| 位置 | 用户可见场景 | 说明 |
| --- | --- | --- |
| `handleReloadCommand()` L4807 / L4811 | **/reload 提示框**（用户主要诉求） | `reloadBox` = border + spacer + "Reloading…" text + spacer + border，塞进 `editorContainer` |
| `showStartupNoticesIfNeeded()` L537 / L550 | 启动时 What's New 公告 | chatContainer |
| `handleChangelogCommand()` L5152 / L5156 | `/changelog` | chatContainer |
| 键盘快捷键列表 L5275 / L5279 | `/keys` | chatContainer |
| `showNewVersionNotification()` L3430 / L3440 | "Update Available" 通知 | chatContainer，`warning` 色 |
| `showPackageUpdateNotification()` L3448 / L3450 | "Package Updates Available" 通知 | chatContainer，`warning` 色 |

### 3.2 组件内（20 个文件，每个 2 处 `new`，tree-selector 3 处）

| 组件 | 用户可见场景 |
| --- | --- |
| `model-selector.js` | /model 模型选择 overlay |
| `session-selector.js` | 会话选择 overlay |
| `tree-selector.js`（**3 处**，L1199/L1203/L1208） | 会话树；第 3 条是中间分隔线，**不是配对框**——自动配对策略在此失效的实证 |
| `settings-selector.js`、`config-selector.js` | /settings 等 |
| `thinking-selector.js`、`theme-selector.js`、`show-images-selector.js`、`scoped-models-selector.js` | 对应 overlay |
| `extension-selector.js`、`extension-input.js`、`extension-editor.js` | 扩展 UI（`ctx.ui.select` / `input` / `editor` 底层） |
| `trust-selector.js`、`first-time-setup.js`、`login-dialog.js`、`oauth-selector.js`、`user-message-selector.js` | 信任/首启/登录 overlay |
| `bash-execution.js` L32/L43 | **bash 工具执行框**（chat 流内，每条命令一个框） |
| `bordered-loader.js` L13/L27 | 扩展 loader 包装（`ctx.ui.custom` 默认边框） |
| `earendil-announcement.js` | 官方公告 |

合计 ~53 处 `new DynamicBorder(...)`，**几乎全部是"上边一条 + 下边一条"的成对模式**，唯一例外是 tree-selector 的中间线。

## 4. 为什么现在只有编辑器是圆角、reload 时会"退化"

### 4.1 pi-editor 的圆角是"渲染后处理"，只覆盖编辑器自身

`extensions/pi-editor/index.ts` 的 `roundedBorder()`（L68-91）继承 `CustomEditor`，在 `render()` 里把框架画好的首/末两行 `────` 替换成 `╭──╮` / `╰──╯`，侧边 rail 用 `│`。它只能管自己 render 出来的行。

### 4.2 /reload 流程（圆角丢失的直接原因）

`handleReloadCommand()`（interactive-mode.js L4795）：

1. `editorContainer.clear()` —— 把我们的 `PiEditor`（圆角）从容器里移除；
2. `editorContainer.addChild(reloadBox)` —— 换上 pi 本体拼的 `reloadBox`（两条**直角** `DynamicBorder`）；
3. `await session.reload()` —— 期间旧扩展 runtime 收到 `session_shutdown(reason: "reload")`，新 runtime 收到 `session_start(reason: "reload")`，`PiEditor` 重新 install；
4. `dismissReloadBox(this.editor)` —— 恢复编辑器，圆角回归。

所以 reload 窗口期显示的框 100% 由 pi 本体绘制，扩展代码完全不参与。

### 4.3 扩展 API 能力边界（方案 C 不可行的证据）

`ExtensionUIContext`（`core/extensions/types.d.ts`）提供的 UI 钩子：`setFooter` / `setHeader` / `setEditorComponent` / `setWidget` / `custom` / `select` / `notify` / `setStatus` …——**没有任何钩子能触达 `chatContainer` / `editorContainer` 内由本体 `addChild(DynamicBorder)` 的行**。selector overlay 也是本体组件直接画的。

进一步，运行时猴子补丁（import 后改 `DynamicBorder.prototype.render`）同样无效：`dynamic-border.js` 顶部注释明确写了 *"When used from extensions loaded via jiti, the global `theme` may be undefined because **jiti creates a separate module cache**"* —— 扩展经 jiti 拿到的是重新求值的另一份模块，与 pi 本体 ESM import 的**不是同一个类对象**，原型补丁打不到本体实例。该注释本是为 `theme` 全局变量写的，这里恰好成为双模块实例的官方证据。

## 5. 推荐方案设计

### 5.1 统一改动形态（上游 A 与本地 B 共用）

给 `DynamicBorder` 增加可选 `position`，默认不传 = 现状直角线，**完全向后兼容**：

```js
// dynamic-border.js（patch 后）
export class DynamicBorder {
    color;
    position; // undefined | "top" | "bottom"
    constructor(color = (str) => theme.fg("border", str), position) {
        this.color = color;
        this.position = position;
    }
    invalidate() {}
    render(width) {
        const line = "─".repeat(Math.max(1, width));
        if (!this.position || width < 2) return [this.color(line)];
        const [l, r] = this.position === "top" ? ["╭", "╮"] : ["╰", "╯"];
        return [this.color(`${l}${line.slice(1, -1)}${r}`)];
    }
}
```

调用点机械标注（每对的第一处 `, "top"`、第二处 `, "bottom"`）：

```js
reloadBox.addChild(new DynamicBorder(borderColor, "top"));
...
reloadBox.addChild(new DynamicBorder(borderColor, "bottom"));
```

与 `pi-editor` 现有 `roundedBorder()` 的退化处理保持一致：`width < 2` 时回退直线；颜色继续走 `color` fn，**无需改任何主题**（`╭╮╰╯` 与 `─` 同属 box-drawing 字符，宽度均为 1，主流终端字体均等宽支持）。

### 5.2 本地 patch（方案 B，立即生效）

用户实际运行的 pi 在 fnm 全局目录（不是本仓库 node_modules，两份是独立拷贝）：

```
/Users/wangsong/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/
```

步骤：

1. 在本仓库 `scripts/` 增加 `patch-pi-borders.mjs`：
   - 改写上述目录下 `dist/modes/interactive/components/dynamic-border.js`（§5.1 的新实现）；
   - 对 20 个组件文件 + `interactive-mode.js` 做成对 `new DynamicBorder(...)` 的正则标注：同一构造函数作用域内第 1 处补 `, "top"`，第 2 处补 `, "bottom"`；`tree-selector.js` 的第 3 处（L1208 中间线）**跳过**；带自定义 color 参数的（`warning` 色通知、`accent` 色公告）同样处理，只追加 position 参数；
2. patch 前先做内容校验（匹配 0.84.2 的既有片段），版本不符即报错退出，防止升级后错改；
3. 手动执行一次即可看到效果；pi 升级后需重跑（可在文档/脚本注释里写明）。

风险点：正则标注依赖 0.84.2 的代码形态，脚本必须先校验再改、失败即退出，不做模糊匹配。

### 5.3 上游 PR（方案 A，长期）

- 仓库：`github.com/earendil-works/pi`（package 目录 `packages/coding-agent`，见 package.json `repository` 字段）。
- 改动即 §5.1：`dynamic-border.ts` 加 `position` + 53 处调用点标注 + tree-selector 中线保持不变。
- 卖点：默认行为零变化（不传参数 = 直线），是纯增量 API；顺手解决扩展作者用 `DynamicBorder` 自绘 UI 时无法画圆角的问题（该组件已导出给扩展用）。
- PR 被拒的备选：只请求导出 `RoundedBorder` 新组件，调用点替换留给维护者。

### 5.4 本仓库侧的收尾（无论 A/B）

- `pi-editor` 的 `roundedBorder()` 保持不动（编辑器路径已正确）。
- 若 patch 后 bash-execution 等框也变圆角，视觉上与编辑器风格统一，无需额外适配。

## 6. 验证清单

- [ ] `/reload`：提示框上下线变 `╭╮`/`╰╯`，reload 完成后编辑器圆角无回归；
- [ ] `/changelog`、`/keys`、启动 What's New：两线圆角；
- [ ] `/model`、`/settings`、会话树等 overlay：圆角；tree-selector **中间第三条线仍为直线**；
- [ ] Update Available / Package Updates 通知：圆角且保持 `warning` 色；
- [ ] bash 工具执行框：圆角，颜色随 thinking/bash 模式变化无异常；
- [ ] 终端窄至 1-2 列时回退直线（`width < 2` 分支）；
- [ ] `pi --version` 升级后 patch 失效的安全降级（回直线，不报错）。

## 7. 附：关键文件索引

| 文件 | 作用 |
| --- | --- |
| `…/pi-coding-agent/dist/modes/interactive/components/dynamic-border.js` | 组件本体（唯一需要改的类） |
| `…/pi-coding-agent/dist/modes/interactive/interactive-mode.js` L4795-4871 | /reload 全流程 |
| `…/pi-coding-agent/dist/core/extensions/types.d.ts` | 扩展 API 边界（无 border 钩子的依据） |
| `extensions/pi-editor/index.ts` L68-91 | 本仓库已有的圆角后处理实现（参照） |
| fnm 全局 `…/node_modules/@earendil-works/pi-coding-agent/` | 用户实际运行的 pi（patch 落点） |
| `~/.pi/agent/git/github.com/m77can/pi-extensions/` | 本仓库在 pi 侧的安装副本（git 包，push 后更新） |
