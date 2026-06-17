import { DEFAULT_MAX_STATUS_LENGTH } from './constants.js';

export function parseAllowedIds(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function isAllowed(message, env) {
  return message.chat?.type === 'private';
}

export function isCallbackAllowed(callback, env) {
  return callback.message?.chat?.type === 'private';
}

export function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return { name: null, args: trimmed };
  const [commandToken, ...rest] = trimmed.split(/\s+/);
  const name = commandToken.split('@')[0].toLowerCase();
  return { name, args: rest.join(' ').trim() };
}

export function normalizeInstance(instance) {
  return String(instance || '').replace(/\/+$/, '');
}

export function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildStatus(rawText, env) {
  const prefix = env.STATUS_PREFIX || '';
  const suffix = env.STATUS_SUFFIX || '';
  const maxLength = positiveInt(env.MAX_STATUS_LENGTH, DEFAULT_MAX_STATUS_LENGTH);
  const combined = `${prefix}${rawText}${suffix}`.trim();
  return truncateStatus(combined, maxLength);
}

export function truncateStatus(status, maxLength) {
  if (status.length <= maxLength) return status;
  if (maxLength <= 3) return '.'.repeat(maxLength);
  return `${status.slice(0, maxLength - 3)}...`;
}

export function requireEnv(env, name) {
  if (!env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

export function safeErrorMessage(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
