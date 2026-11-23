# Magpie Prompt Diary

Prompt Diary 在 Magpie 中展示 T3 Code 用户提交的原文，支持搜索、收藏、标签、模板和按需复盘。一次用户提交对应一条记录，同一条提交的工具续跑、模型重试和供应商切换共用原来的消息 ID。

记录以明文保存在本机。手动生成复盘时，所选范围内的 Prompt 文本会发送给所选模型。产品功能见 [产品文档](docs/product.md)，开发和反馈见 [贡献指南](CONTRIBUTING.md) 与 [安全策略](SECURITY.md)。

## 安装与启用

需要 Magpie、T3 Code 和支持 JSON 输出的 `sqlite3`。插件由 Magpie 的 Bun 宿主运行。从本地代码安装时，先在项目目录执行 `npm ci` 安装 Markdown 解析器，再注册插件和指定 T3 数据目录。该目录应包含 `userdata/statev2.sqlite`。

```sh
npm ci
magpie plugin add .
magpie plugin options mag-review "{\"t3DataDirectory\":\"$HOME/.t3\",\"port\":3479}"
```

如果安装名称不同，以 `magpie plugin list` 为准。设置选项时请保留已配置的 `directory`、`port` 和 `reviewModel`。配置后在 Magpie 的插件侧栏打开「Prompt 日记」。源码变更后关闭再启用插件以重新加载。

## 采集与存储

- 页面服务启动后立即同步，之后每 15 秒读取一次 T3 的本地数据库。数据库以只读方式打开。消息来源以 T3 保存的结构化作者和提交渠道为准，目前覆盖 Web 和 Mobile 用户提交。T3 中使用 Codex、Pi 或 Claude，均走这条链路。
- 记录的身份由来源、T3 会话 ID 和消息 ID 决定。正文和附件来自用户提交，时间按原始提交时间显示为本机时区。两次内容相同的独立提交会保留两条。
- 日记和模板卡片按 Markdown 渲染正文，包括代码块、行内代码、列表和表格。复制原文时保留 Markdown 文本。图片预览使用 T3 提交自带的附件。
- 时间线、搜索和复盘共用 `~/.local/share/magpie-prompt-diary/.submissions.json`。可用 `directory` 指定其他目录。快照在同步成功时原子替换，读取失败时页面继续使用最近一次成功结果。T3 中删除的会话在下次成功同步后退出时间线。
- 旧的每日 Markdown 和 `.history.json` 仍可在原目录查阅。新版根据 T3 重建日记，旧记录的 ID 不参与新快照，旧卡片的收藏、标签和复盘引用需按新记录重建。已保存的模板使用独立文本。
- 纯附件提交也会入库。T3 图片引用会显示为行内标识，其他附件显示在卡片下方。点击可预览的图片标识后，可用左右按钮、方向键或滑动浏览当前卡片的图片。支持 T3 附件目录中不超过 5 MiB 的 PNG、JPEG、GIF、WebP。文件不可读取时仍显示标识。复制原文时保留原始引用。
- 当前来源范围是已配置的 T3 数据目录。独立运行的 Codex、Pi 或 Claude Code，以及只有 Magpie 请求日志的客户端，需要有可确认提交来源的适配器才能纳入。

页面服务只监听 `127.0.0.1`，默认端口 `3479`，可用 `port` 设置。关闭插件会停止同步；本地快照、标注和复盘存放在日记目录。

## 复盘与导出

侧栏的「复盘与沉淀」可选择按天或近 7 天生成报告。近 7 天报告要求同一提醒至少出现在两个日期和两个会话。报告引用原始记录，只在手动生成时发送文本。图片和其他附件文件留在本机。

按本机日期导出 Markdown。可在日期之后追加自定义日记目录。

```sh
npm run --silent export-day -- 2026-11-23 > prompt-2026-11-23.md
```

## 开发验证

```sh
npm test
npm run verify-history -- "$HOME/.t3"
```

测试使用 Node.js 20 及以上和本地 `sqlite3`，测试数据均为虚构。`verify-history` 将指定 T3 数据目录和日记快照按消息身份对照，只输出计数，可在参数末尾追加自定义日记目录。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
