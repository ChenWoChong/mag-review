# Magpie Prompt Diary

一个 Magpie 请求钩子：把网关观察到的用户文本按天保存为本地 Markdown，适用于经过 Magpie 网关的 Agent，优先面向 Codex、Pi 和 Claude Code。插件不会修改模型请求，也不会调用模型生成摘要。

## 安装

需要已安装并运行支持异步请求钩子的 Magpie；插件通过 Magpie 自己的 Bun 插件宿主运行，不需要单独安装 Node 或 Bun。

在本项目目录执行：

```sh
magpie plugin add .
magpie plugin list
```

列表中应显示 `async gateway hook onRequest`。在使用对应 Agent 前，确保它的模型请求经过 Magpie 网关；例如，Magpie 的 switch-only 模式会绕过网关，无法记录。发出一条测试消息后，查看本地日期对应的文件：

```sh
ls ~/.local/share/magpie-prompt-diary
```

Magpie 窗口侧边栏的「插件」分组中会出现「Prompt 日记」页面，可切换日期、按卡片查看记录和复制 Prompt。卡片底部展示可读取的图片。

插件启动时会在后台同步 Magpie 已索引且允许读取的 Codex、Pi 和 Claude 原生会话；也可点击页面顶部「刷新历史」重新同步。历史记录保存在日志目录的 `.history.json`，与实时记录分开保存，页面会合并显示，不会删除原有 Markdown。首次同步可能需要一些时间，页面会显示进度和无法完整读取的数量。

同步通过 Magpie 会话搜索索引和 `magpie sessions show` 获取允许读取的记录，再从原始会话文件匹配消息时间。它依赖 Magpie 和 `sqlite3` 可用；压缩的 Codex 会话需要支持 zstd 的插件宿主。Magpie 未索引、未授权读取、无法匹配原始时间的消息，以及其他 Agent 的原生会话不会导入。Magpie 截断的长会话只导入可读取的部分，因此不能保证包含全部历史。

页面服务只监听本机 `127.0.0.1:3479`，因此应在运行 Magpie 的同一台电脑上查看；远程 Magpie Web 不支持访问此页面。本机其他程序也可能访问该端口，请保护电脑的本地访问权限。若端口被占用，可在插件选项中设置 `port`（1024–65535）。更改源码后需要重新加载插件配置；可通过将插件关闭再启用来触发重新加载。

## 输出与配置

默认存放在 `~/.local/share/magpie-prompt-diary/YYYY-MM-DD.md`，日期和记录时间以运行插件宿主的电脑本地时区为准。每条记录包含首次观察时间、可识别的 Agent、工作目录和文本。Markdown 文件中的 HTML 注释是用于去重的指纹。

可在 Magpie 的已安装插件选项中设置 `directory` 为绝对路径，也可以使用 CLI（插件名以 `magpie plugin list` 显示的名称为准）：

```sh
magpie plugin options mag-review '{"directory":"/绝对路径/prompt-diary","port":3479}'
```

上例中的 `mag-review` 是当前目录安装时的插件名；从其他目录安装时请使用 `magpie plugin list` 显示的名称。`directory` 和 `port` 也可以分别设置，保存选项时应保留需要的其他设置。

新建目录的权限为 `0700`，日志文件为 `0600`。自行指定已有目录时，请检查目录权限及同步、备份设置；记录内容可能包含敏感信息。删除对应 Markdown 文件可以删除记录。停止记录可在 Magpie 中关闭插件，或使用 `magpie plugin off <插件名>`。

## 范围和限制

- 只记录 Magpie 标记为来自本机（`local` 或 `magpie-key`）的请求，跳过远程、未知来源和子 Agent 请求。旧版 Magpie 如果没有提供来源，将不会记录。
- 使用 Magpie 的 `ctx.query`，它是 Magpie 提取的最新用户文本，不包括图片、工具结果以及被 Magpie 排除的客户端环境或指令提示。插件不能保证还原所有原始输入。
- 对带文本的请求，尝试保存同一用户消息中的 PNG、JPEG、GIF、WebP 内嵌图片，单张不超过 5 MiB；仅图片的请求、远程图片链接以及其他 Agent 格式可能无法记录。图片保存在记录目录的 `attachments/`，删除 Markdown 不会自动删除图片。
- 对已有的 T3 Code 附件路径，页面尝试读取 `~/.t3/userdata/attachments` 下的图片；文件被移动、删除或超过 5 MiB 时，页面保留路径文字。不会访问远程图片链接或其他任意本地路径。
- 去重使用 Agent、工作目录、会话 ID 和请求中的用户文本历史。重试及工具循环通常只记录一次；缺少会话 ID、Agent 只发送增量消息、历史被压缩或 Agent 修改消息格式时，可能漏记或重复。首次接入某个 Agent 时请实际核对结果。
- 时间是网关首次观察到请求的时间，不是输入框中的原始提交时间；重启或跨天后仍会从现有日志读取指纹。手动修改或删除日志后，重新加载插件使内存中的去重索引更新。
- 日志为本地明文，不做密钥识别或脱敏。不要将日志目录提交到 Git 或设置为自动同步，除非你确认接受这一行为。
- 记录依赖请求钩子成功执行；宿主重启、超时或文件写入失败时可能漏记，Magpie 仍会继续处理原请求。插件不保证审计级完整性，也不支持多个插件宿主同时写入同一目录。

## 开发验证

```sh
npm test
```

测试使用 Node.js 20 及以上，不依赖网络或真实账号。测试数据模拟 Responses 和 Messages 请求；要确认具体 Agent 版本的行为，仍需通过已连接 Magpie 的真实 Agent 做端到端验证。

也可运行 `npm run verify-history`，对照 Magpie 本地搜索索引中的原生会话和当前日记记录。脚本使用 `sqlite3` 和 Magpie CLI，只输出计数；长会话可能被 Magpie 的 transcript 接口截断，索引本身也可能尚未包含所有会话。该命令不导入历史记录。
