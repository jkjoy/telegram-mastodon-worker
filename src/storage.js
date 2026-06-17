import { SESSION_TTL_SECONDS } from './constants.js';

export function getKV(env) {
  if (!env.CONFIG_KV) throw new Error('未绑定 CONFIG_KV，无法保存配置');
  return env.CONFIG_KV;
}

export function mastodonConfigKey(scope, message) {
  if (scope === 'chat') return `mastodon:chat:${message.chat.id}`;
  const userId = message.from?.id || message.chat?.id;
  return `mastodon:user:${userId}`;
}

export function mastodonConfigKeyFromIds(scope, chatId, userId) {
  if (scope === 'chat') return `mastodon:chat:${chatId}`;
  return `mastodon:user:${userId || chatId}`;
}

export function bindSessionKey(chatId, userId) {
  return `session:bind:${chatId}:${userId}`;
}

export function pendingPostKey(chatId, userId, messageId) {
  return `session:post:${chatId}:${userId || chatId}:${messageId}`;
}

export function replyItemKey(chatId, userId, notificationId) {
  return `reply:item:${chatId}:${userId}:${notificationId}`;
}

export function replySessionKey(chatId, userId) {
  return `session:reply:${chatId}:${userId}`;
}

export function timelineSubscriberKey(userId) {
  return `timeline:subscriber:${userId}`;
}

export function timelineItemKey(userId, statusId) {
  return `timeline:item:${userId}:${statusId}`;
}

export async function putSession(env, key, value) {
  await getKV(env).put(key, JSON.stringify(value), { expirationTtl: SESSION_TTL_SECONDS });
}
