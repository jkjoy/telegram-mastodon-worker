import { TELEGRAM_API_BASE, VALID_VISIBILITIES } from './constants.js';
import { requireEnv } from './utils.js';

export async function sendTelegramMessage(fetchFn, env, chatId, text, replyToMessageId, replyMarkup = null) {
  requireEnv(env, 'TELEGRAM_BOT_TOKEN');

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (replyToMessageId) payload.reply_parameters = { message_id: replyToMessageId };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const response = await fetchFn(`${TELEGRAM_API_BASE}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram API HTTP ${response.status}: ${errorBody}`);
  }
}

export async function answerCallbackQuery(fetchFn, env, callbackQueryId, text = '') {
  requireEnv(env, 'TELEGRAM_BOT_TOKEN');

  const response = await fetchFn(`${TELEGRAM_API_BASE}${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram answerCallbackQuery HTTP ${response.status}: ${errorBody}`);
  }
}

export async function sendBindMenu(fetchFn, env, chatId, replyToMessageId) {
  await sendTelegramMessage(fetchFn, env, chatId, '点击下面按钮绑定或修改当前用户的 Mastodon token：', replyToMessageId, {
    inline_keyboard: [
      [{ text: '绑定/修改当前用户', callback_data: 'bind:user' }],
      [{ text: '退出修改', callback_data: 'bind:cancel' }],
    ],
  });
}

export async function sendVisibilityMenu(fetchFn, env, chatId, replyToMessageId, prefix = 'visibility', callbackSuffix = '') {
  await sendTelegramMessage(fetchFn, env, chatId, prefix === 'post_visibility' ? '请选择这条嘟文的可见性：' : '请选择 Mastodon 可见性：', replyToMessageId, visibilityKeyboard(prefix, callbackSuffix));
}

export function visibilityKeyboard(prefix, callbackSuffix = '') {
  const values = [...VALID_VISIBILITIES];
  const suffix = callbackSuffix ? `:${callbackSuffix}` : '';
  const keyboard = [
    values.slice(0, 2).map((value) => ({ text: value, callback_data: `${prefix}:${value}${suffix}` })),
    values.slice(2, 4).map((value) => ({ text: value, callback_data: `${prefix}:${value}${suffix}` })),
  ];

  if (prefix === 'visibility') {
    keyboard.push([{ text: '退出修改', callback_data: 'bind:cancel' }]);
  }

  return { inline_keyboard: keyboard };
}

export function helpText() {
  return [
    'Telegram → Mastodon 转发机器人',
    '',
    '可用命令：',
    '/ping - 测试机器人',
    '/post 文本 - 准备发布，并选择可见性后发送',
    '/bind - 交互式绑定/修改当前用户 Mastodon token',
    '/bind access_token [可见性] - 快捷绑定当前用户',
    '/replies - 查看最近 5 条别人对你的回复，并可继续回复',
    '/timeline_on - 开启关注时间线推送',
    '/timeline_off - 关闭关注时间线推送',
    '/timeline_status - 查看时间线推送状态',
    '/config - 查看当前用户绑定',
    '/unbind - 解除当前用户绑定',
    '/help - 查看帮助',
    '',
    '可见性：public / unlisted / private / direct',
    '私聊窗口直接发送文本，机器人会先让你选择可见性，再转发到 Mastodon。',
  ].join('\n');
}
