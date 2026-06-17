import { VALID_VISIBILITIES, SESSION_TTL_SECONDS, TIMELINE_ITEM_TTL_SECONDS } from './constants.js';
import { parseBindArgs, defaultMastodonInstance, resolveMastodonConfig, publishMastodonStatus, fetchMastodonNotifications, fetchHomeTimeline, reblogMastodonStatus, favouriteMastodonStatus } from './mastodon.js';
import { getKV, mastodonConfigKey, mastodonConfigKeyFromIds, bindSessionKey, pendingPostKey, putSession, replyItemKey, replySessionKey, timelineSubscriberKey, timelineItemKey } from './storage.js';
import { answerCallbackQuery, helpText, sendBindMenu, sendTelegramMessage, sendVisibilityMenu } from './telegram.js';
import { buildStatus, safeErrorMessage, json } from './utils.js';

export async function handlePing(fetchFn, env, message) {
  await sendTelegramMessage(fetchFn, env, message.chat.id, 'pong', message.message_id);
  return json({ ok: true, action: 'pong' });
}

export async function handleHelp(fetchFn, env, message) {
  await sendTelegramMessage(fetchFn, env, message.chat.id, helpText(), message.message_id);
  return json({ ok: true, action: 'help' });
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function handleReplies(fetchFn, env, message) {
  const mastodonConfig = await resolveMastodonConfig(env, message);
  const notifications = await fetchMastodonNotifications(fetchFn, mastodonConfig, 5);
  const mentions = notifications.filter((item) => item.type === 'mention' && item.status);

  if (mentions.length === 0) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, '最近没有新的回复通知。', message.message_id);
    return json({ ok: true, action: 'replies_empty' });
  }

  const lines = ['最近的回复：', ''];
  const keyboard = [];

  for (let i = 0; i < mentions.length; i += 1) {
    const item = mentions[i];
    const text = stripHtml(item.status.content || '').trim();
    const acct = item.account?.acct || 'unknown';
    const itemKey = replyItemKey(message.chat.id, message.from?.id, item.id);
    await putSession(env, itemKey, {
      notificationId: item.id,
      statusId: item.status.id,
      acct,
      visibility: item.status.visibility || mastodonConfig.visibility || 'public',
      url: item.status.url || '',
    });
    lines.push(`${i + 1}. @${acct}`);
    lines.push(text || '(空内容)');
    lines.push('');
    keyboard.push([
      { text: `回复 ${i + 1}`, callback_data: `reply:${item.id}` },
      { text: '打开', url: item.status.url || mastodonConfig.instance },
    ]);
  }

  await sendTelegramMessage(fetchFn, env, message.chat.id, lines.join('\n').trim(), message.message_id, {
    inline_keyboard: keyboard,
  });
  return json({ ok: true, action: 'replies_listed', count: mentions.length });
}

export async function startReplySession(fetchFn, env, callback, notificationId) {
  const message = callback.message;
  const itemKey = replyItemKey(message.chat.id, callback.from.id, notificationId);
  const item = await getKV(env).get(itemKey, 'json');
  if (!item) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, '这条回复已过期，请重新执行 /replies。', message.message_id);
    return json({ ok: true, ignored: true, reason: 'reply_item_expired' });
  }

  const sessionKey = replySessionKey(message.chat.id, callback.from.id);
  await putSession(env, sessionKey, item);
  await sendTelegramMessage(fetchFn, env, message.chat.id, `请输入要回复 @${item.acct} 的内容：`, message.message_id, {
    inline_keyboard: [[{ text: '退出回复', callback_data: 'reply:cancel' }]],
  });
  return json({ ok: true, action: 'reply_session_started' });
}

export async function cancelReplySession(fetchFn, env, callback) {
  const message = callback.message;
  const sessionKey = replySessionKey(message.chat.id, callback.from.id);
  if (env.CONFIG_KV) {
    await env.CONFIG_KV.delete(sessionKey);
  }
  await sendTelegramMessage(fetchFn, env, message.chat.id, '已退出回复。', message.message_id);
}

export async function maybeHandleReplySessionMessage(fetchFn, env, message, command) {
  if (!env.CONFIG_KV || !message.from?.id || command.name) return null;

  const sessionKey = replySessionKey(message.chat.id, message.from.id);
  const session = await env.CONFIG_KV.get(sessionKey, 'json');
  if (!session?.statusId) return null;

  const replyText = String(message.text || message.caption || '').trim();
  if (!replyText) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, '回复内容不能为空。', message.message_id);
    return json({ ok: true, action: 'reply_waiting_text' });
  }

  const mastodonConfig = await resolveMastodonConfig(env, message);
  const status = `@${session.acct} ${replyText}`.trim();
  const published = await publishMastodonStatus(fetchFn, mastodonConfig, status, session.visibility || mastodonConfig.visibility, session.statusId);
  await env.CONFIG_KV.delete(sessionKey);
  await sendTelegramMessage(fetchFn, env, message.chat.id, `已回复到 Mastodon：\n${published.url || published.id || '发布成功'}`, message.message_id);
  return json({ ok: true, action: 'reply_posted', id: published.id || null, url: published.url || null });
}

export async function handleTimelineOn(fetchFn, env, message) {
  const mastodonConfig = await resolveMastodonConfig(env, message);
  const latest = await fetchHomeTimeline(fetchFn, mastodonConfig, 1);
  const userId = message.from.id;
  const subscriber = { userId, chatId: message.chat.id, lastId: latest[0]?.id || null, enabled: true };
  await env.CONFIG_KV.put(timelineSubscriberKey(userId), JSON.stringify(subscriber));
  const subscribers = await getTimelineSubscribers(env);
  if (!subscribers.includes(userId)) subscribers.push(userId);
  await env.CONFIG_KV.put('timeline:subscribers', JSON.stringify(subscribers));
  await sendTelegramMessage(fetchFn, env, message.chat.id, '已开启时间线推送。从下一轮检查开始，只推送新嘟文。', message.message_id);
  return json({ ok: true, action: 'timeline_on', lastId: subscriber.lastId });
}

export async function handleTimelineOff(fetchFn, env, message) {
  const userId = message.from.id;
  await env.CONFIG_KV.delete(timelineSubscriberKey(userId));
  const subscribers = (await getTimelineSubscribers(env)).filter((id) => id !== userId);
  await env.CONFIG_KV.put('timeline:subscribers', JSON.stringify(subscribers));
  await sendTelegramMessage(fetchFn, env, message.chat.id, '已关闭时间线推送。', message.message_id);
  return json({ ok: true, action: 'timeline_off' });
}

export async function handleTimelineStatus(fetchFn, env, message) {
  const subscriber = env.CONFIG_KV ? await env.CONFIG_KV.get(timelineSubscriberKey(message.from.id), 'json') : null;
  await sendTelegramMessage(fetchFn, env, message.chat.id, subscriber?.enabled ? '时间线推送：已开启' : '时间线推送：未开启', message.message_id);
  return json({ ok: true, action: 'timeline_status', enabled: Boolean(subscriber?.enabled) });
}

async function getTimelineSubscribers(env) {
  const value = env.CONFIG_KV ? await env.CONFIG_KV.get('timeline:subscribers', 'json') : [];
  return Array.isArray(value) ? value : [];
}

export async function handleTimelineCron(fetchFn, env) {
  const subscribers = await getTimelineSubscribers(env);
  for (const userId of subscribers) {
    const subscriber = await env.CONFIG_KV.get(timelineSubscriberKey(userId), 'json');
    if (!subscriber?.enabled) continue;
    const fakeMessage = { chat: { id: subscriber.chatId, type: 'private' }, from: { id: userId } };
    const mastodonConfig = await resolveMastodonConfig(env, fakeMessage);
    const statuses = await fetchHomeTimeline(fetchFn, mastodonConfig, 5);
    const newStatuses = [];
    for (const status of statuses) {
      if (subscriber.lastId && status.id === subscriber.lastId) break;
      newStatuses.push(status);
    }
    const ordered = newStatuses.reverse().slice(0, 3);
    for (const status of ordered) {
      await pushTimelineStatus(fetchFn, env, subscriber, status);
    }
    if (statuses[0]?.id && statuses[0].id !== subscriber.lastId) {
      await env.CONFIG_KV.put(timelineSubscriberKey(userId), JSON.stringify({ ...subscriber, lastId: statuses[0].id }));
    }
  }
}

async function pushTimelineStatus(fetchFn, env, subscriber, status) {
  const acct = status.account?.acct || 'unknown';
  const text = stripHtml(status.content || '').trim();
  const item = { statusId: status.id, acct, visibility: status.visibility || 'public', url: status.url || '' };
  await env.CONFIG_KV.put(timelineItemKey(subscriber.userId, status.id), JSON.stringify(item), { expirationTtl: TIMELINE_ITEM_TTL_SECONDS });
  await sendTelegramMessage(fetchFn, env, subscriber.chatId, `@${acct}\n\n${text || '(空内容)'}`.trim(), null, {
    inline_keyboard: [[
      { text: '回复', callback_data: `tl_reply:${status.id}` },
      { text: '转发', callback_data: `tl_boost:${status.id}` },
      { text: '喜欢', callback_data: `tl_fav:${status.id}` },
      { text: '打开', url: status.url || '#' },
    ]],
  });
}

export async function handleTimelineAction(fetchFn, env, callback, action, statusId) {
  const message = callback.message;
  const item = await getKV(env).get(timelineItemKey(callback.from.id, statusId), 'json');
  if (!item) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, '这条时间线嘟文已过期。', message.message_id);
    return json({ ok: true, ignored: true, reason: 'timeline_item_expired' });
  }
  const fakeMessage = { chat: message.chat, from: callback.from };
  const mastodonConfig = await resolveMastodonConfig(env, fakeMessage);
  if (action === 'boost') {
    await reblogMastodonStatus(fetchFn, mastodonConfig, statusId);
    await sendTelegramMessage(fetchFn, env, message.chat.id, '已转发。', message.message_id);
    return json({ ok: true, action: 'timeline_boosted' });
  }
  if (action === 'fav') {
    await favouriteMastodonStatus(fetchFn, mastodonConfig, statusId);
    await sendTelegramMessage(fetchFn, env, message.chat.id, '已喜欢。', message.message_id);
    return json({ ok: true, action: 'timeline_favourited' });
  }
  if (action === 'reply') {
    const session = { notificationId: `timeline:${statusId}`, statusId, acct: item.acct, visibility: item.visibility, url: item.url };
    await putSession(env, replySessionKey(message.chat.id, callback.from.id), session);
    await sendTelegramMessage(fetchFn, env, message.chat.id, `请输入要回复 @${item.acct} 的内容：`, message.message_id, {
      inline_keyboard: [[{ text: '退出回复', callback_data: 'reply:cancel' }]],
    });
    return json({ ok: true, action: 'timeline_reply_started' });
  }
  return json({ ok: true, ignored: true, reason: 'unknown_timeline_action' });
}

export async function handleBindCommand(fetchFn, env, message, command) {
  if (!command.args) {
    await sendBindMenu(fetchFn, env, message.chat.id, message.message_id);
    return json({ ok: true, action: 'bind_menu' });
  }

  try {
    const config = parseBindArgs(command.args, env);
    const scope = command.name === '/bind_chat' ? 'chat' : 'user';
    const key = mastodonConfigKey(scope, message);
    await getKV(env).put(key, JSON.stringify(config));
    await sendTelegramMessage(
      fetchFn,
      env,
      message.chat.id,
      `已绑定 Mastodon（${scope === 'chat' ? '当前聊天' : '当前用户'}）：\n实例：${config.instance}\n可见性：${config.visibility}`,
      message.message_id
    );
    return json({ ok: true, action: 'bound', scope, instance: config.instance, visibility: config.visibility });
  } catch (error) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, `绑定失败：${safeErrorMessage(error)}`, message.message_id);
    return json({ ok: false, error: 'bind_failed', message: safeErrorMessage(error) }, 400);
  }
}

export async function handleUnbindCommand(fetchFn, env, message, command) {
  try {
    const scope = command.name === '/unbind_chat' ? 'chat' : 'user';
    const key = mastodonConfigKey(scope, message);
    await getKV(env).delete(key);
    await sendTelegramMessage(fetchFn, env, message.chat.id, `已解除 Mastodon 绑定（${scope === 'chat' ? '当前聊天' : '当前用户'}）。`, message.message_id);
    return json({ ok: true, action: 'unbound', scope });
  } catch (error) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, `解除绑定失败：${safeErrorMessage(error)}`, message.message_id);
    return json({ ok: false, error: 'unbind_failed', message: safeErrorMessage(error) }, 400);
  }
}

export async function handleConfigCommand(fetchFn, env, message, command) {
  const scope = command.name === '/config_chat' ? 'chat' : 'user';
  const key = mastodonConfigKey(scope, message);
  const config = env.CONFIG_KV ? await env.CONFIG_KV.get(key, 'json') : null;
  const text = config
    ? `当前 Mastodon 绑定（${scope === 'chat' ? '当前聊天' : '当前用户'}）：\n实例：${config.instance}\n可见性：${config.visibility || env.MASTODON_VISIBILITY || 'public'}\nToken：已保存，不回显`
    : `当前没有 Mastodon 绑定（${scope === 'chat' ? '当前聊天' : '当前用户'}）。`;
  await sendTelegramMessage(fetchFn, env, message.chat.id, text, message.message_id);
  return json({ ok: true, action: 'config', scope, configured: Boolean(config) });
}

export async function handleCallbackQuery(fetchFn, env, callback) {
  const data = callback.data || '';
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;

  await answerCallbackQuery(fetchFn, env, callback.id);

  if (data === 'bind:cancel') {
    await cancelInteractiveBind(fetchFn, env, callback);
    return json({ ok: true, action: 'interactive_bind_cancelled' });
  }

  if (data === 'reply:cancel') {
    await cancelReplySession(fetchFn, env, callback);
    return json({ ok: true, action: 'reply_cancelled' });
  }

  if (data.startsWith('tl_')) {
    const [rawAction, statusId] = data.split(':');
    const action = rawAction.slice('tl_'.length);
    return handleTimelineAction(fetchFn, env, callback, action, statusId);
  }

  if (data.startsWith('reply:')) {
    const notificationId = data.slice('reply:'.length);
    return startReplySession(fetchFn, env, callback, notificationId);
  }

  if (data === 'bind:user') {
    await startInteractiveBind(fetchFn, env, callback, 'user');
    return json({ ok: true, action: 'interactive_bind_started', scope: 'user' });
  }

  if (data.startsWith('visibility:')) {
    const visibility = data.slice('visibility:'.length);
    await finishInteractiveBind(fetchFn, env, callback, visibility);
    return json({ ok: true, action: 'interactive_bind_saved', visibility });
  }

  if (data.startsWith('post_visibility:')) {
    const [, visibility, originalMessageId] = data.split(':');
    return finishPendingPost(fetchFn, env, callback, visibility, originalMessageId);
  }

  if (chatId) await sendTelegramMessage(fetchFn, env, chatId, '未知操作或按钮已过期。', messageId);
  return json({ ok: true, ignored: true, reason: 'unknown_callback' });
}

export async function startInteractiveBind(fetchFn, env, callback, scope) {
  const message = callback.message;
  const sessionKey = bindSessionKey(message.chat.id, callback.from.id);
  await putSession(env, sessionKey, { scope, step: 'token' });
  await sendTelegramMessage(
    fetchFn,
    env,
    message.chat.id,
    `请输入 Mastodon access token。\n默认实例：${defaultMastodonInstance(env)}\n范围：${scope === 'chat' ? '当前聊天/频道' : '当前用户'}\n\n提示：下一条消息会被当作 token 保存，请不要在公共群组里输入 token。`,
    message.message_id,
    { inline_keyboard: [[{ text: '退出修改', callback_data: 'bind:cancel' }]] }
  );
}

export async function cancelInteractiveBind(fetchFn, env, callback) {
  const message = callback.message;
  const sessionKey = bindSessionKey(message.chat.id, callback.from.id);
  if (env.CONFIG_KV) {
    await env.CONFIG_KV.delete(sessionKey);
  }
  await sendTelegramMessage(fetchFn, env, message.chat.id, '已退出绑定修改。', message.message_id);
}

export async function maybeHandleBindSessionMessage(fetchFn, env, message, command) {
  if (!env.CONFIG_KV || !message.from?.id || command.name) return null;

  const sessionKey = bindSessionKey(message.chat.id, message.from.id);
  const session = await env.CONFIG_KV.get(sessionKey, 'json');
  if (!session || session.step !== 'token') return null;

  const token = String(message.text || message.caption || '').trim();
  if (!token || token.length < 8) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, 'token 看起来不正确，请重新输入 Mastodon access token。', message.message_id);
    return json({ ok: true, action: 'interactive_bind_waiting_token' });
  }

  await putSession(env, sessionKey, { scope: session.scope, step: 'visibility', accessToken: token });
  await sendVisibilityMenu(fetchFn, env, message.chat.id, message.message_id);
  return json({ ok: true, action: 'interactive_bind_token_received' });
}

export async function finishInteractiveBind(fetchFn, env, callback, visibility) {
  if (!VALID_VISIBILITIES.has(visibility)) throw new Error('可见性只能是 public、unlisted、private 或 direct');

  const message = callback.message;
  const sessionKey = bindSessionKey(message.chat.id, callback.from.id);
  const session = await getKV(env).get(sessionKey, 'json');
  if (!session || session.step !== 'visibility' || !session.accessToken) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, '绑定会话已过期，请重新点击 /bind 开始。', message.message_id);
    return;
  }

  const scope = session.scope === 'chat' ? 'chat' : 'user';
  const config = {
    instance: defaultMastodonInstance(env).replace(/\/+$/, ''),
    accessToken: session.accessToken,
    visibility,
  };
  await env.CONFIG_KV.put(mastodonConfigKeyFromIds(scope, message.chat.id, callback.from.id), JSON.stringify(config));
  await env.CONFIG_KV.delete(sessionKey);
  await sendTelegramMessage(
    fetchFn,
    env,
    message.chat.id,
    `已保存 Mastodon 绑定（${scope === 'chat' ? '当前聊天' : '当前用户'}）：\n实例：${config.instance}\n可见性：${visibility}\nToken：已保存，不回显`,
    message.message_id
  );
}

export async function startPendingPost(fetchFn, env, message, rawStatus) {
  if (!env.CONFIG_KV) throw new Error('未绑定 CONFIG_KV，无法保存待发布嘟文');

  const status = buildStatus(rawStatus, env);
  const key = pendingPostKey(message.chat.id, message.from?.id, message.message_id);
  await env.CONFIG_KV.put(
    key,
    JSON.stringify({ status, messageId: message.message_id, chatId: message.chat.id, userId: message.from?.id || null }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  await sendVisibilityMenu(fetchFn, env, message.chat.id, message.message_id, 'post_visibility', String(message.message_id));
  return json({ ok: true, action: 'pending_post_visibility', key });
}

export async function finishPendingPost(fetchFn, env, callback, visibility, originalMessageId = null) {
  if (!VALID_VISIBILITIES.has(visibility)) throw new Error('可见性只能是 public、unlisted、private 或 direct');

  const message = callback.message;
  const pendingMessageId = originalMessageId || message.message_id;
  const key = pendingPostKey(message.chat.id, callback.from?.id, pendingMessageId);
  const pending = await getKV(env).get(key, 'json');
  if (!pending?.status) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, '待发布嘟文已过期，请重新发送内容。', message.message_id);
    return json({ ok: true, ignored: true, reason: 'pending_post_expired' });
  }

  const syntheticMessage = { chat: message.chat, from: callback.from };
  try {
    const mastodonConfig = await resolveMastodonConfig(env, syntheticMessage);
    const mastodonStatus = await publishMastodonStatus(fetchFn, mastodonConfig, pending.status, visibility);
    await env.CONFIG_KV.delete(key);
    const link = mastodonStatus.url || mastodonStatus.uri || mastodonStatus.id || '发布成功，但实例未返回链接';
    await sendTelegramMessage(fetchFn, env, message.chat.id, `已发布到 Mastodon：\n${link}`, message.message_id);
    return json({ ok: true, action: 'posted', url: mastodonStatus.url || null, id: mastodonStatus.id || null });
  } catch (error) {
    await sendTelegramMessage(fetchFn, env, message.chat.id, `发布失败：${safeErrorMessage(error)}`, message.message_id);
    return json({ ok: false, error: 'mastodon_publish_failed', message: safeErrorMessage(error) }, 502);
  }
}
