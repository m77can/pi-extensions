# pi-extensions

Pi 扩展集合。每个子目录是一个独立的 pi package，分别上传到 GitHub、通过 `pi install git:...` 安装管理。

## 包列表

| 目录 | 描述 | 状态 |
| --- | --- | --- |
| `pi-token-speed/` | 实时输出 token 速度（tok/s）：滑动窗口 + 消毒护栏，发布 `pi-token-speed` 状态供 footer 消费 | 开发中 |

## 本地开发

```bash
# 不安装直接试跑
pi -e ./pi-token-speed

# 本地安装
pi install ./pi-token-speed
```

## 发布

1. 每个子目录推到对应的 GitHub 仓库
2. 用户侧安装：`pi install git:github.com/<user>/pi-token-speed`