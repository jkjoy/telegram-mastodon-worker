import { DEFAULT_MASTODON_INSTANCE, VALID_VISIBILITIES } from './constants.js';
import { mastodonConfigKey } from './storage.js';
import { normalizeInstance } from './utils.js';

export function defaultMastodonInstance(env) {
  return env.DEFAULT_MASTODON_INSTANCE || env.MASTODON_INSTANCE || DEFAULT_MASTODON_INSTANCE;
}

export function parseBindArgs(args, env) {
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    throw new Error('格式错误。用法：/bind access_token [public|unlisted|private|direct]');
  }

  const instance = normalizeInstance(defaultMastodonInstance(env));
  const accessToken = parts[0];
  const visibility = parts[1] || env.MASTODON_VISIBILITY || 'public';

  if (!/^https:\/\//i.test(instance)) throw new Error('默认 Mastodon 实例地址必须以 https:// 开头');
  if (!accessToken || accessToken.length < 8) throw new Error('access_token 看起来不正确');
  if (!VALID_VISIBILITIES.has(visibility)) throw new Error('可见性只能是 public、unlisted、private 或 direct');

  return { instance, accessToken, visibility };
}

export async function resolveMastodonConfig(env, message) {
  const chatKey = mastodonConfigKey('chat', message);
  const userKey = mastodonConfigKey('user', message);

  if (env.CONFIG_KV) {
    const userConfig = await env.CONFIG_KV.get(userKey, 'json');
    if (userConfig) return normalizeMastodonConfig(userConfig, env);

    const chatConfig = await env.CONFIG_KV.get(chatKey, 'json');
    if (chatConfig) return normalizeMastodonConfig(chatConfig, env);
  }

  return normalizeMastodonConfig({
    instance: defaultMastodonInstance(env),
    accessToken: env.DEFAULT_MASTODON_ACCESS_TOKEN || env.MASTODON_ACCESS_TOKEN,
    visibility: env.MASTODON_VISIBILITY || 'public',
  }, env);
}

export function normalizeMastodonConfig(config, env) {
  const normalized = {
    instance: normalizeInstance(config.instance || ''),
    accessToken: config.accessToken || config.access_token || '',
    visibility: config.visibility || env.MASTODON_VISIBILITY || 'public',
  };

  if (!normalized.instance) throw new Error('缺少 Mastodon 实例配置，请先使用 /bind 绑定');
  if (!normalized.accessToken) throw new Error('缺少 Mastodon access token，请先使用 /bind 绑定');
  if (!VALID_VISIBILITIES.has(normalized.visibility)) normalized.visibility = 'public';

  return normalized;
}

export async function fetchMastodonNotifications(fetchFn, mastodonConfig, limit = 5) {
  const instance = normalizeInstance(mastodonConfig.instance);
  const response = await fetchFn(`${instance}/api/v1/notifications?types[]=mention&limit=${limit}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${mastodonConfig.accessToken}` },
  });

  const bodyText = await response.text();
  let body = [];
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (_) {
      body = [];
    }
  }

  if (!response.ok) {
    throw new Error(`Mastodon notifications HTTP ${response.status}: ${body.error || bodyText || 'unknown error'}`);
  }

  return Array.isArray(body) ? body : [];
}

export async function fetchHomeTimeline(fetchFn, mastodonConfig, limit = 5) {
  const instance = normalizeInstance(mastodonConfig.instance);
  const response = await fetchFn(`${instance}/api/v1/timelines/home?limit=${limit}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${mastodonConfig.accessToken}` },
  });
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : [];
  if (!response.ok) throw new Error(`Mastodon home timeline HTTP ${response.status}: ${body.error || bodyText || 'unknown error'}`);
  return Array.isArray(body) ? body : [];
}

export async function reblogMastodonStatus(fetchFn, mastodonConfig, statusId) {
  return postStatusAction(fetchFn, mastodonConfig, statusId, 'reblog');
}

export async function favouriteMastodonStatus(fetchFn, mastodonConfig, statusId) {
  return postStatusAction(fetchFn, mastodonConfig, statusId, 'favourite');
}

async function postStatusAction(fetchFn, mastodonConfig, statusId, action) {
  const instance = normalizeInstance(mastodonConfig.instance);
  const response = await fetchFn(`${instance}/api/v1/statuses/${statusId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mastodonConfig.accessToken}` },
  });
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok) throw new Error(`Mastodon ${action} HTTP ${response.status}: ${body.error || bodyText || 'unknown error'}`);
  return body;
}

export async function publishMastodonStatus(fetchFn, mastodonConfig, status, visibilityOverride = null, inReplyToId = null) {
  const instance = normalizeInstance(mastodonConfig.instance);
  const payload = {
    status,
    visibility: visibilityOverride || mastodonConfig.visibility || 'public',
  };
  if (inReplyToId) payload.in_reply_to_id = inReplyToId;

  const response = await fetchFn(`${instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mastodonConfig.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  let body = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (_) {
      body = { raw: bodyText };
    }
  }

  if (!response.ok) {
    throw new Error(`Mastodon API HTTP ${response.status}: ${body.error || body.raw || 'unknown error'}`);
  }

  return body;
}
