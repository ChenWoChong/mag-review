# Magpie Prompt Diary

Prompt Diary 收录经过 Magpie 网关的模型请求中可识别的新输入。时间线支持 Markdown、图片预览、搜索、收藏、标签、模板和按需复盘。

## 安装与启用

需要支持异步模型请求钩子的 Magpie。本地源码安装使用 Node.js 22.13 或新版提供的 SQLite，运行时使用 Magpie 自带的 Bun。

```sh
npm ci
magpie plugin add .
magpie plugin list
```

插件列表应显示 `async gateway hook onRequest` 和 `Prompt Diary` 页面。默认页面端口为 `3479`，可在插件选项中设置 `port`。源码变更后关闭再启用插件以重新加载。

## 采集与存储

- 实时入口是 Magpie 的 `onRequest`，覆盖 Chat Completions、Responses、Anthropic Messages 和 Gemini。已实测本机 Magpie `0.1.4709` 的普通 HTTP、Codex HTTP 直通和两个 Responses WebSocket 入口。钩子返回原请求的控制权，模型失败也可保留已经观测到的输入。
- 默认只采集宿主标为 `local` 的请求。确认 `magpie-key` 只用于本人流量后，可设置 `captureManagedKeys: true`。共享密钥标记 `gateway-key`、远程及未知来源跳过。
- 每张卡片在数据库里都有至少一条网关观测。优先使用有作用域的客户端消息 ID。缺少 ID 时，以单条输入、Responses 增量或有序历史前缀判断新边界。歧义请求只记处理结果，卡片来源注明消息 ID 或网关输入边界。`role: user` 只能证明协议角色，归因受客户端提供的元数据限制。
- 系统指令、工具输出及已识别的自动请求不会写入正文。图片只保存网关请求实际带来的 PNG、JPEG、GIF、WebP 字节，单张最多 5 MiB。支持纯图片提交，外部链接和客户端本地路径不用于读取图片。
- SQLite 存在 `~/.local/share/magpie-prompt-diary/gateway-diary.sqlite`，可通过 `directory` 修改存储目录。记录使用网关观测时间显示为本机时区。旧 T3 快照和历史日志无法逐条证明网关来源，需单独保留备份。新日记从启用采集后开始累积。

记录以明文保存在本机。手动生成复盘时，所选范围内的 Prompt 文本会发送给选定模型。图片留在本机。产品功能见 [产品文档](docs/product.md)，采集设计见 [网关架构](docs/magpie-gateway-architecture.md)。

## 导出与验证

```sh
npm run --silent export-day -- 2026-11-23 > prompt-2026-11-23.md
npm test
npm run verify-history
```

导出和核对命令可在参数末尾追加日记目录。`verify-history` 检查 SQLite 完整性，以及所有卡片是否有对应的网关观测，输出只有统计数据。

开发和反馈见 [贡献指南](CONTRIBUTING.md) 与 [安全策略](SECURITY.md)。本项目采用 [MIT 许可证](LICENSE)。
