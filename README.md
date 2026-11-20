# MemoryV1.3-Breathe（预览版）

本地、可审计、可纠正的个人记忆容器插件，运行在 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端。

**这是预览版（preview）**，不是稳定版。接口、数据格式与 UI 都可能变化。

## 它能做什么

- **本地优先**：记忆以 Markdown + JSON 存在你自己的磁盘上，不经任何服务器。
- **五关写入**：模型推断只能进候选区，人工确认后才转正；不进检索、不进常驻注入。
- **衰减（Breathe）**：超过半衰期自动降层；只改渲染，不删原文；可撤销。
- **手动记忆链**：把条目串成链，支持新建、改名、删除、操作记录与回滚。
- **三种视图**：知识球 / 关系图 / 列表，支持搜索与编辑。

## 安装

见 [INSTALL.md](INSTALL.md)。安装前请先备份，并确认 DSH 版本 >= 0.2.2。

## 隐私

- 不联网、不上传；唯一的外部请求由你使用的模型通道发起，与本插件无关。
- 调试用的 UI 探针在新版中默认关闭，不写任何事件日志。
- 记忆容器里有你的个人信息，请自行做好磁盘备份与访问控制。

## 已知限制（预览版）

- 当前只在 macOS + DSH 0.2.2-rc.3 上实测过。
- 插件要求宿主提供 `webserver/index-inject` 与 `ctx.on`；宿主过旧时 token 无法注入页面，GUI 会返回 401。
- 不自带构建产物之外的依赖；`pnpm install` 仅用于开发。

## 开发

```bash
npm run build      # tsc + tsdown（需要 devDependencies）
npm run typecheck
npm test
```

## 许可证

MIT，见 [LICENSE](LICENSE)。


## 版权与原创声明

本项目由 Yang Tianyu 原创并维护，以 MIT License 发布；第三方组件（Tabler Icons，MIT）与使用边界见 [NOTICE.md](NOTICE.md)。

不使用本项目名称或作者名义为衍生品背书，不将本项目包装为他人原创作品。
