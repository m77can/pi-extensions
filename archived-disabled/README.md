# 存档（已停用）

本目录内的文件末尾统一带 `.disabled` 后缀，pi 不会装载它们。它们只作为历史存档保留在 git 中。

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `orca-agent-status.ts.disabled` | `~/.pi/agent/extensions/` | orca/omp 集成：向本地 hook 上报 agent 状态 |
| `orca-prefill.ts.disabled` | 同上 | orca 面板预填充 |
| `orca-titlebar-spinner.ts.disabled` | 同上 | orca 标题栏旋转指示 |
| `arouter.ts.disabled` | 同上（原本就叫 `.disabled`） | arouter 模型列表/显示名扩展 |

若要重新启用某个扩展：去掉 `.disabled` 后缀，并在根 `index.ts` 里显式导入即可。
