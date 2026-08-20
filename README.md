# pi-extensions

Wang Song's pi 扩展集合（或个人）的统一 Git 仓库，通过 `pi install git:...` 一个入口安装管理。

## 安装（git）

```bash
pi install git:github.com/m77can/pi-extensions
```

仓库根 `package.json` 的 `pi.extensions` 指向根目录 `index.ts`，作为唯一装载入口。

## 包列表

| 路径 | 描述 | 状态 |
| --- | --- | --- |
| `./index.ts` → `pi-router-spec/` | 首轮 Recon 侦察（read + bash）→ 全量续跑，按模型门控的重构 provider payload | 启用 |
| `pi-token-speed/` | 实时输出 token 速度（tok/s）：滑动窗口 + 消毒护栏 | 独立子包，本地/单独 git 安装 |
| `archived-disabled/` | orca/arouter 旧扩展存档（`.disabled` 后缀，永不装载） | 已停用 |

## 结构约定

- 仓库根是 **git 安装的装载入口**：`index.ts` 显式 re-export 需要启用的扩展。
- 每个扩展的文件内部用相对导入时统一写 `.js` 后缀，pi 的 jiti loader 会自动映射到同目录的 `.ts`。
- 停用但想保留历史的扩展放 `archived-disabled/`，文件名加 `.disabled` 后缀，并从根 `index.ts` 中移除导入。

## 本地开发

```bash
# 不安装直接试跑
pi -e ./pi-router-spec

# 本地安装（整个仓库作为单个 package）
pi install .

# 更新（git 安装后，推新提交再执行）
pi update --extension git:github.com/m77can/pi-extensions
```
