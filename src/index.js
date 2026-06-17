import {
  handleBindCommand,
  handleCallbackQuery,
  handleConfigCommand,
  handleHelp,
  handlePing,
  handleReplies,
  handleTimelineCron,
  handleTimelineOff,
  handleTimelineOn,
  handleTimelineStatus,
  handleUnbindCommand,
  maybeHandleBindSessionMessage,
  maybeHandleReplySessionMessage,
  startPendingPost,
} from './handlers.js';
import { isAllowed, isCallbackAllowed, json, parseCommand, safeErrorMessage } from './utils.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, { fetch: fetch.bind(globalThis), ctx });
  },

  async scheduled(event, env, ctx, runtime = {}) {
    const fetchFn = runtime.fetch || fetch.bind(globalThis);
    const promise = handleTimelineCron(fetchFn, env);
    if (ctx?.waitUntil) ctx.waitUntil(promise);
    return promise;
  },
};

export async function handleRequest(request, env, runtime = {}) {
  const fetchFn = runtime.fetch || fetch.bind(globalThis);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'telegram-mastodon-worker' });
    }
    return json({ ok: false, error: 'not_found' }, 404);
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const secretError = validateTelegramSecret(request, env);
  if (secretError) return secretError;

  let update;
  try {
    update = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  try {
    if (update.callback_query) {
      if (!isCallbackAllowed(update.callback_query, env)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      return handleCallbackQuery(fetchFn, env, update.callback_query);
    }

    const tgMessage = getTelegramMessage(update);
    if (!tgMessage) {
      return json({ ok: true, ignored: true, reason: 'unsupported_update' });
    }

    if (!isAllowed(tgMessage, env)) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const command = parseCommand(tgMessage.text || tgMessage.caption || '');

    const bindSessionHandled = await maybeHandleBindSessionMessage(fetchFn, env, tgMessage, command);
    if (bindSessionHandled) return bindSessionHandled;

    const replySessionHandled = await maybeHandleReplySessionMessage(fetchFn, env, tgMessage, command);
    if (replySessionHandled) return replySessionHandled;

    if (command.name === '/ping') return handlePing(fetchFn, env, tgMessage);
    if (command.name === '/start' || command.name === '/help') return handleHelp(fetchFn, env, tgMessage);
    if (command.name === '/bind') return handleBindCommand(fetchFn, env, tgMessage, command);
    if (command.name === '/unbind') return handleUnbindCommand(fetchFn, env, tgMessage, command);
    if (command.name === '/config') return handleConfigCommand(fetchFn, env, tgMessage, command);
    if (command.name === '/replies') return handleReplies(fetchFn, env, tgMessage);
    if (command.name === '/timeline_on') return handleTimelineOn(fetchFn, env, tgMessage);
    if (command.name === '/timeline_off') return handleTimelineOff(fetchFn, env, tgMessage);
    if (command.name === '/timeline_status') return handleTimelineStatus(fetchFn, env, tgMessage);
    if (command.name && command.name !== '/post') {
      return json({ ok: true, ignored: true, reason: 'unknown_command' });
    }

    const rawStatus = command.name === '/post' ? command.args : (tgMessage.text || tgMessage.caption || '').trim();
    if (!rawStatus) {
      return json({ ok: true, ignored: true, reason: 'empty_status' });
    }

    return startPendingPost(fetchFn, env, tgMessage, rawStatus);
  } catch (error) {
    return json({ ok: false, error: 'internal_error', message: safeErrorMessage(error) }, 500);
  }
}

function validateTelegramSecret(request, env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return null;
  const actual = request.headers.get('x-telegram-bot-api-secret-token');
  if (actual !== expected) return json({ ok: false, error: 'invalid_telegram_secret' }, 401);
  return null;
}

function getTelegramMessage(update) {
  return update.message || update.channel_post || null;
}
