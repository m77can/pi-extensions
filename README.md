# pi-extensions

pi 扩展集合，通过 `pi install git:...` 一个入口统一安装管理。

## 安装

```bash
pi install git:github.com/m77can/pi-extensions
```

## 扩展列表

| 路径 | 描述 | 状态 |
| --- | --- | --- |
| `pi-router-spec/` | 首轮 Recon 侦察（read + bash）→ 全量续跑，按模型门控重构 provider payload | 启用 |
| `pi-token-speed/` | 实时输出 token 速度（tok/s）：滑动窗口 + 消毒护栏 | 启用 |

## 结构约定

- 根 `package.json` 的 `pi.extensions` 显式列出所有扩展入口，各自一个 `index.ts`（每个 `export default` 一个 factory），无需构建。
- 扩展内部相对导入统一写 `.js` 后缀，pi 的 jiti loader 自动映射到同目录 `.ts`。

## 本地开发

```bash
# 不安装直接试跑
pi -e ./pi-router-spec/index.ts
pi -e ./pi-token-speed

# 本地安装（整个仓库作为单个 package）
pi install .
```

## 更新

```bash
pi update --extension git:github.com/m77can/pi-extensions
```
