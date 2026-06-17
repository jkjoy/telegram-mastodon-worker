# Telegram → Mastodon Cloudflare Worker

这是一个基于 Cloudflare Workers 的 Telegram 机器人转发到 Mastodon 程序。

当前版本已经加入 Cloudflare KV：可以在 Telegram 机器人里绑定 Mastodon 实例和 access token，配置会保存到 KV。

## 功能

- 接收 Telegram Bot Webhook
- 校验 Telegram Webhook secret token
- 只允许 Telegram 私聊使用，不处理群组和频道消息
- Cloudflare KV 保存 Mastodon 绑定配置
- `/bind` 交互式绑定或修改当前 Telegram 用户的 Mastodon 默认实例账号 token
- `/replies` 查看最近 5 条别人对你的回复，并可在 Telegram 里继续回复
- `/timeline_on` 开启关注时间线推送，只从开启后的新嘟文开始推送
- `/timeline_off` 关闭关注时间线推送
- `/timeline_status` 查看时间线推送状态
- 时间线推送支持回复、转发、喜欢、打开原文
- `/config` 查看绑定状态，不回显 token
- `/unbind` 解除绑定
- `/ping` 测试命令
- `/help` 帮助命令
- `/post 文本` 准备发布嘟文，随后通过按钮选择可见性再发布
- 私聊窗口直接发送文本，会先返回可见性选择按钮，点击后发布到 Mastodon
- 支持 Telegram 私聊 `message` 和按钮回调 `callback_query`
- 发布成功后在 Telegram 回复 Mastodon 链接
- Mastodon visibility 可配置
- 超长文本自动截断

## 配置优先级

发布时会按下面顺序查找 Mastodon 配置：

1. 当前 Telegram 用户绑定：`/bind ...`
2. Worker 默认配置：`DEFAULT_MASTODON_INSTANCE` + `DEFAULT_MASTODON_ACCESS_TOKEN`

如果没有设置 `DEFAULT_MASTODON_INSTANCE`，程序内置默认实例为：

```text
https://jiong.us
```

如果没有任何绑定，也没有默认 token，发布会失败并提示先绑定。

## 项目结构

```text
telegram-mastodon-worker/
  src/index.js          Worker 入口与路由
  src/handlers.js       Telegram update / command / callback 处理
  src/telegram.js       Telegram Bot API 封装和按钮菜单
  src/mastodon.js       Mastodon 配置解析与发帖 API
  src/storage.js        KV key 和会话存储工具
  src/utils.js          通用工具函数
  src/constants.js      常量
  test/worker.test.js   Vitest 测试
  wrangler.toml         Cloudflare Workers 配置
  package.json          npm 脚本与依赖
```

## 本地测试

```bash
cd /data/telegram-mastodon-worker
npm test
```

当前验证结果：

```text
Test Files  1 passed (1)
Tests       15 passed (15)
```

## 创建 KV namespace

部署前需要先创建 KV：

```bash
cd /data/telegram-mastodon-worker
npx wrangler kv namespace create CONFIG_KV
```

命令会返回类似：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

把返回的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

## wrangler.toml 配置

```toml
[vars]
DEFAULT_MASTODON_INSTANCE = "https://jiong.us"
MASTODON_VISIBILITY = "public"
MAX_STATUS_LENGTH = "500"
STATUS_PREFIX = ""
STATUS_SUFFIX = ""
```

本项目不使用白名单配置，只允许 Telegram 私聊 `chat.type = private` 的消息。群组和频道消息会直接返回 403。

## Cloudflare Secrets

必须设置：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

可选默认 Mastodon 配置：

```bash
npx wrangler secret put DEFAULT_MASTODON_ACCESS_TOKEN
```

如果你希望所有用户都通过 Telegram 私聊里的 `/bind` 自行绑定 Mastodon，可以不设置默认 Mastodon token。

说明：

- `TELEGRAM_BOT_TOKEN`：BotFather 给你的 Telegram Bot Token
- `TELEGRAM_WEBHOOK_SECRET`：你自定义的一串随机密钥，用于校验 Telegram Webhook 请求头
- `DEFAULT_MASTODON_ACCESS_TOKEN`：默认 Mastodon 账号访问令牌，可选

## 部署

```bash
cd /data/telegram-mastodon-worker
npx wrangler deploy
```

部署完成后会得到 Worker 地址，例如：

```text
https://telegram-mastodon-worker.your-subdomain.workers.dev
```

## 设置 Telegram Webhook

把下面命令中的变量换成你的实际值：

```bash
BOT_TOKEN="你的 Telegram Bot Token"
WORKER_URL="https://telegram-mastodon-worker.your-subdomain.workers.dev"
SECRET="你设置的 TELEGRAM_WEBHOOK_SECRET"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${WORKER_URL}\",\"secret_token\":\"${SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

检查 Webhook：

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

## 机器人命令

测试：

```text
/ping
```

查看帮助：

```text
/help
```

交互式绑定或修改当前 Telegram 用户的 Mastodon 账号：

```text
/bind
```

机器人会显示按钮，你按提示完成：

1. 点击“绑定/修改当前用户”
2. 输入 Mastodon access token
3. 点击选择可见性：`public` / `unlisted` / `private` / `direct`
4. 配置保存到 KV

也保留了快捷命令，适合私聊中直接使用：

```text
/bind access_token public
```

例如：

```text
/bind xxxxxxxxxxxxxxxxxxxx unlisted
```

查看绑定：

```text
/config
```

解除绑定：

```text
/unbind
```

准备发布一条嘟文：

```text
/post 你好 Mastodon
```

机器人会先保存这条待发布内容到 KV，并返回可见性按钮：

```text
public / unlisted / private / direct
```

点击其中一个可见性后，才会真正发布到 Mastodon。

在机器人私聊窗口里，也可以直接发文本：

```text
这是一条要同步到 Mastodon 的内容
```

同样会先让你选择可见性，点击后再发布。

查看别人对你的最新回复：

```text
/replies
```

机器人会读取当前绑定 Mastodon 账号的最近 5 条 `mention` 通知，显示回复内容，并给每条回复提供按钮：

```text
回复 1
打开
```

点击“回复 N”后，机器人会提示：

```text
请输入要回复 @用户 的内容：
```

你输入回复文本后，Worker 会调用 Mastodon API 发布一条带 `in_reply_to_id` 的真正回复。

注意：读取回复需要 Mastodon token 至少具有读取通知的权限。建议 token 权限包含：

```text
read:notifications
read:statuses
write:statuses
write:favourites
```

开启关注时间线推送：

```text
/timeline_on
```

设计选择是 A：开启时只记录当前首页时间线最新嘟文，不立即推送旧嘟文；从下一轮 Cloudflare Cron 开始，只推送之后出现的新嘟文。

关闭推送：

```text
/timeline_off
```

查看状态：

```text
/timeline_status
```

推送的新嘟文会带按钮：

```text
回复
转发
喜欢
打开
```

- 回复：进入回复会话，输入文字后发布 `in_reply_to_id` 回复
- 转发：调用 Mastodon reblog API
- 喜欢：调用 Mastodon favourite API
- 打开：打开原嘟文链接

时间线推送由 Cloudflare Cron 每 5 分钟检查一次：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

## 获取 Mastodon Access Token

在你的 Mastodon 实例中：

1. 打开 设置 / 开发 / 新建应用
2. 权限建议至少选择：`read:notifications`、`read:statuses`、`write:statuses`、`write:favourites`
3. 复制访问令牌
4. 在 Telegram 里发送：

```text
/bind 你的access_token public
```

可见性支持：

```text
public
unlisted
private
direct
```

## 安全建议

- `TELEGRAM_WEBHOOK_SECRET` 使用足够随机的字符串。
- 不要公开泄露 `TELEGRAM_BOT_TOKEN`。
- Mastodon access token 会保存在 Cloudflare KV 中；只在私聊中使用 `/bind` 输入 token。
- 群组和频道消息会被拒绝，不会转发。
- 第一版仍然只处理文本，不处理图片、视频和文件。

## 后续可扩展功能

- 图片转发到 Mastodon
- 图片 caption 转发
- 多图媒体组聚合
- KV 防重复投递
- Telegram 消息 ID 与 Mastodon 状态 ID 映射
- 支持 Content Warning
- 支持命令指定可见性，例如 `/post public 文本`
- 绑定配置加密存储
