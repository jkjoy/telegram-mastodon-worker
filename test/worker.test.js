import { describe, it, expect, vi } from 'vitest';
import worker, { handleRequest } from '../src/index.js';

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123:test-token',
  TELEGRAM_WEBHOOK_SECRET: 'secret-header',
  ALLOWED_TELEGRAM_IDS: '42,-100123',
  DEFAULT_MASTODON_INSTANCE: 'https://mastodon.example',
  DEFAULT_MASTODON_ACCESS_TOKEN: 'mastodon-token',
  MASTODON_VISIBILITY: 'public',
  STATUS_PREFIX: '',
  STATUS_SUFFIX: '',
};

function createKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key, type) => {
      const value = store.get(key) ?? null;
      if (type === 'json' && value) return JSON.parse(value);
      return value;
    }),
    put: vi.fn(async (key, value) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      store.delete(key);
    }),
  };
}

function envWithKV(initial = {}, overrides = {}) {
  return { ...baseEnv, CONFIG_KV: createKV(initial), ...overrides };
}

function jsonRequest(body, headers = {}) {
  return new Request('https://worker.example/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret-header',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

describe('telegram to mastodon worker', () => {
  it('rejects webhook requests with an invalid Telegram secret token', async () => {
    const fetchMock = vi.fn();
    const response = await handleRequest(
      jsonRequest({ message: { text: 'hello', from: { id: 42 }, chat: { id: 42, type: 'private' } } }, {
        'x-telegram-bot-api-secret-token': 'wrong',
      }),
      baseEnv,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns pong for an allowed /ping message and replies on Telegram', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const response = await handleRequest(
      jsonRequest({ message: { message_id: 7, text: '/ping', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      baseEnv,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const payload = await readJson(response);
    expect(payload.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/bot123:test-token/sendMessage');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ chat_id: 42, text: 'pong' });
  });

  it('rejects non-private Telegram messages', async () => {
    const fetchMock = vi.fn();
    const response = await handleRequest(
      jsonRequest({ message: { text: 'hello', from: { id: 99 }, chat: { id: -10099, type: 'group' } } }),
      baseEnv,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('binds Mastodon settings for a Telegram user into KV', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV();

    const response = await handleRequest(
      jsonRequest({
        message: {
          message_id: 11,
          text: '/bind token-user unlisted',
          from: { id: 42 },
          chat: { id: 42, type: 'private' },
        },
      }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'mastodon:user:42',
      JSON.stringify({ instance: 'https://mastodon.example', accessToken: 'token-user', visibility: 'unlisted' })
    );
    const telegramCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(telegramCall[1].body).text).toContain('已绑定 Mastodon');
  });

  it('ignores /bind_chat because only private user binding is supported', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV();

    const response = await handleRequest(
      jsonRequest({
        message: {
          message_id: 12,
          text: '/bind_chat chat-token private',
          from: { id: 42 },
          chat: { id: 42, type: 'private' },
        },
      }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const payload = await readJson(response);
    expect(payload).toMatchObject({ ok: true, ignored: true, reason: 'unknown_command' });
    expect(env.CONFIG_KV.put).not.toHaveBeenCalledWith(
      'mastodon:chat:42',
      expect.any(String)
    );
  });

  it('stores /post text as pending and asks the user to choose visibility', async () => {
    const env = envWithKV({
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleRequest(
      jsonRequest({ message: { message_id: 8, text: '/post 你好 Mastodon', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'session:post:42:42:8',
      JSON.stringify({ status: '你好 Mastodon', messageId: 8, chatId: 42, userId: 42 }),
      { expirationTtl: 600 }
    );
    const telegramCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain('请选择这条嘟文的可见性');
    expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'public', callback_data: 'post_visibility:public:8' });
  });

  it('publishes a pending /post after the user chooses visibility', async () => {
    const env = envWithKV({
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
      'session:post:42:42:8': JSON.stringify({ status: '你好 Mastodon', messageId: 8, chatId: 42, userId: 42 }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/api/v1/statuses')) {
        return new Response(JSON.stringify({ id: 'abc', url: 'https://social.example/@me/abc' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ callback_query: { id: 'postcb1', data: 'post_visibility:private:8', from: { id: 42 }, message: { message_id: 100, chat: { id: 42, type: 'private' } } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const mastodonCall = fetchMock.mock.calls.find(([url]) => url === 'https://social.example/api/v1/statuses');
    expect(mastodonCall).toBeTruthy();
    expect(JSON.parse(mastodonCall[1].body)).toEqual({ status: '你好 Mastodon', visibility: 'private' });
    expect(mastodonCall[1].headers.Authorization).toBe('Bearer user-token');
    expect(env.CONFIG_KV.delete).toHaveBeenCalledWith('session:post:42:42:8');

    const telegramCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(telegramCall[1].body).text).toContain('https://social.example/@me/abc');
  });

  it('rejects channel_post updates because only private chats are allowed', async () => {
    const env = envWithKV({
      'mastodon:chat:-100123': JSON.stringify({ instance: 'https://channel.example', accessToken: 'channel-token', visibility: 'public' }),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleRequest(
      jsonRequest({ channel_post: { message_id: 9, text: '频道消息', chat: { id: -100123, type: 'channel' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(403);
    expect(env.CONFIG_KV.put).not.toHaveBeenCalledWith(
      'session:post:-100123:-100123:9',
      expect.any(String),
      expect.any(Object)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to default Mastodon env settings when publishing a pending post without KV binding', async () => {
    const env = envWithKV({
      'session:post:42:42:13': JSON.stringify({ status: 'fallback', messageId: 13, chatId: 42, userId: 42 }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/api/v1/statuses')) {
        return new Response(JSON.stringify({ id: 'fallback', url: 'https://mastodon.example/@me/fallback' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ callback_query: { id: 'postcb2', data: 'post_visibility:public', from: { id: 42 }, message: { message_id: 13, chat: { id: 42, type: 'private' } } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const mastodonCall = fetchMock.mock.calls.find(([url]) => url === 'https://mastodon.example/api/v1/statuses');
    expect(mastodonCall[1].headers.Authorization).toBe('Bearer mastodon-token');
  });

  it('starts an interactive bind flow when /bind has no token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV();

    const response = await handleRequest(
      jsonRequest({ message: { message_id: 15, text: '/bind', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const telegramCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain('绑定或修改当前用户');
    expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: '绑定/修改当前用户', callback_data: 'bind:user' });
    expect(body.reply_markup.inline_keyboard[1][0]).toMatchObject({ text: '退出修改', callback_data: 'bind:cancel' });
  });

  it('stores an interactive bind session when the user clicks bind user', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV();

    const response = await handleRequest(
      jsonRequest({
        callback_query: {
          id: 'cb1',
          data: 'bind:user',
          from: { id: 42 },
          message: { message_id: 16, chat: { id: 42, type: 'private' } },
        },
      }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'session:bind:42:42',
      JSON.stringify({ scope: 'user', step: 'token' }),
      { expirationTtl: 600 }
    );
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/answerCallbackQuery'))).toBe(true);
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('请输入 Mastodon access token');
  });

  it('asks for visibility after receiving token during interactive bind', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV({
      'session:bind:42:42': JSON.stringify({ scope: 'user', step: 'token' }),
    });

    const response = await handleRequest(
      jsonRequest({ message: { message_id: 17, text: 'interactive-token', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'session:bind:42:42',
      JSON.stringify({ scope: 'user', step: 'visibility', accessToken: 'interactive-token' }),
      { expirationTtl: 600 }
    );
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('请选择 Mastodon 可见性');
    expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'public', callback_data: 'visibility:public' });
    expect(body.reply_markup.inline_keyboard[2][0]).toMatchObject({ text: '退出修改', callback_data: 'bind:cancel' });
  });

  it('cancels an interactive bind session when the user clicks exit', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV({
      'session:bind:42:42': JSON.stringify({ scope: 'user', step: 'visibility', accessToken: 'interactive-token' }),
    });

    const response = await handleRequest(
      jsonRequest({
        callback_query: {
          id: 'cb-cancel',
          data: 'bind:cancel',
          from: { id: 42 },
          message: { message_id: 19, chat: { id: 42, type: 'private' } },
        },
      }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.delete).toHaveBeenCalledWith('session:bind:42:42');
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('已退出绑定修改');
  });

  it('saves interactive bind config after visibility is selected', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV({
      'session:bind:42:42': JSON.stringify({ scope: 'user', step: 'visibility', accessToken: 'interactive-token' }),
    });

    const response = await handleRequest(
      jsonRequest({
        callback_query: {
          id: 'cb2',
          data: 'visibility:private',
          from: { id: 42 },
          message: { message_id: 18, chat: { id: 42, type: 'private' } },
        },
      }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'mastodon:user:42',
      JSON.stringify({ instance: 'https://mastodon.example', accessToken: 'interactive-token', visibility: 'private' })
    );
    expect(env.CONFIG_KV.delete).toHaveBeenCalledWith('session:bind:42:42');
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('已保存 Mastodon 绑定');
  });

  it('uses https://jiong.us as the default instance when no instance env is configured', async () => {
    const env = envWithKV({
      'session:post:42:42:14': JSON.stringify({ status: 'default instance', messageId: 14, chatId: 42, userId: 42 }),
    }, { DEFAULT_MASTODON_INSTANCE: '', MASTODON_INSTANCE: undefined });
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/api/v1/statuses')) {
        return new Response(JSON.stringify({ id: 'jiong', url: 'https://jiong.us/@me/jiong' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ callback_query: { id: 'postcb3', data: 'post_visibility:public', from: { id: 42 }, message: { message_id: 14, chat: { id: 42, type: 'private' } } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const mastodonCall = fetchMock.mock.calls.find(([url]) => url === 'https://jiong.us/api/v1/statuses');
    expect(mastodonCall).toBeTruthy();
  });

  it('truncates long statuses before storing the pending post', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = envWithKV({}, { MAX_STATUS_LENGTH: '10' });

    await handleRequest(
      jsonRequest({ message: { message_id: 10, text: '/post 123456789012345', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'session:post:42:42:10',
      JSON.stringify({ status: '1234567...', messageId: 10, chatId: 42, userId: 42 }),
      { expirationTtl: 600 }
    );
  });

  it('lists recent Mastodon reply notifications with reply buttons', async () => {
    const env = envWithKV({
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://social.example/api/v1/notifications?types[]=mention&limit=5') {
        return new Response(JSON.stringify([
          {
            id: 'n1',
            type: 'mention',
            account: { acct: 'alice@example.com', display_name: 'Alice' },
            status: { id: 's1', content: '<p>你好，写得不错</p>', url: 'https://social.example/@alice/s1', visibility: 'public' },
          },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ message: { message_id: 20, text: '/replies', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'reply:item:42:42:n1',
      JSON.stringify({ notificationId: 'n1', statusId: 's1', acct: 'alice@example.com', visibility: 'public', url: 'https://social.example/@alice/s1' }),
      { expirationTtl: 600 }
    );
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('@alice@example.com');
    expect(body.text).toContain('你好，写得不错');
    expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: '回复 1', callback_data: 'reply:n1' });
  });

  it('starts a Mastodon reply session when a reply button is clicked', async () => {
    const env = envWithKV({
      'reply:item:42:42:n1': JSON.stringify({ notificationId: 'n1', statusId: 's1', acct: 'alice@example.com', visibility: 'public', url: 'https://social.example/@alice/s1' }),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleRequest(
      jsonRequest({ callback_query: { id: 'replycb1', data: 'reply:n1', from: { id: 42 }, message: { message_id: 21, chat: { id: 42, type: 'private' } } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'session:reply:42:42',
      JSON.stringify({ notificationId: 'n1', statusId: 's1', acct: 'alice@example.com', visibility: 'public', url: 'https://social.example/@alice/s1' }),
      { expirationTtl: 600 }
    );
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('请输入要回复 @alice@example.com 的内容');
  });

  it('posts a Mastodon reply when text is sent during a reply session', async () => {
    const env = envWithKV({
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
      'session:reply:42:42': JSON.stringify({ notificationId: 'n1', statusId: 's1', acct: 'alice@example.com', visibility: 'public', url: 'https://social.example/@alice/s1' }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/api/v1/statuses')) {
        return new Response(JSON.stringify({ id: 'reply-status', url: 'https://social.example/@me/reply-status' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ message: { message_id: 22, text: '谢谢你的回复', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    const mastodonCall = fetchMock.mock.calls.find(([url]) => url === 'https://social.example/api/v1/statuses');
    expect(JSON.parse(mastodonCall[1].body)).toEqual({ status: '@alice@example.com 谢谢你的回复', visibility: 'public', in_reply_to_id: 's1' });
    expect(env.CONFIG_KV.delete).toHaveBeenCalledWith('session:reply:42:42');
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('已回复到 Mastodon');
  });


  it('enables timeline push without sending old statuses immediately', async () => {
    const env = envWithKV({
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://social.example/api/v1/timelines/home?limit=1') {
        return new Response(JSON.stringify([{ id: 'old1', content: '<p>旧嘟文</p>', account: { acct: 'alice' }, url: 'https://social.example/@alice/old1' }]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ message: { message_id: 30, text: '/timeline_on', from: { id: 42 }, chat: { id: 42, type: 'private' } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'timeline:subscriber:42',
      JSON.stringify({ userId: 42, chatId: 42, lastId: 'old1', enabled: true })
    );
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith('timeline:subscribers', JSON.stringify([42]));
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('已开启时间线推送');
  });

  it('cron pushes new home timeline statuses with action buttons', async () => {
    const env = envWithKV({
      'timeline:subscribers': JSON.stringify([42]),
      'timeline:subscriber:42': JSON.stringify({ userId: 42, chatId: 42, lastId: 'old1', enabled: true }),
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://social.example/api/v1/timelines/home?limit=5') {
        return new Response(JSON.stringify([
          { id: 'new1', content: '<p>新嘟文</p>', account: { acct: 'alice@example.com' }, url: 'https://social.example/@alice/new1', visibility: 'public' },
          { id: 'old1', content: '<p>旧嘟文</p>', account: { acct: 'bob' }, url: 'https://social.example/@bob/old1', visibility: 'public' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await worker.scheduled({}, env, { waitUntil: (promise) => promise }, { fetch: fetchMock });

    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.chat_id).toBe(42);
    expect(body.text).toContain('@alice@example.com');
    expect(body.text).toContain('新嘟文');
    expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: '回复', callback_data: 'tl_reply:new1' });
    expect(body.reply_markup.inline_keyboard[0][1]).toMatchObject({ text: '转发', callback_data: 'tl_boost:new1' });
    expect(body.reply_markup.inline_keyboard[0][2]).toMatchObject({ text: '喜欢', callback_data: 'tl_fav:new1' });
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith(
      'timeline:item:42:new1',
      JSON.stringify({ statusId: 'new1', acct: 'alice@example.com', visibility: 'public', url: 'https://social.example/@alice/new1' }),
      { expirationTtl: 604800 }
    );
    expect(env.CONFIG_KV.put).toHaveBeenCalledWith('timeline:subscriber:42', JSON.stringify({ userId: 42, chatId: 42, lastId: 'new1', enabled: true }));
  });

  it('boosts a timeline status when the boost button is clicked', async () => {
    const env = envWithKV({
      'timeline:item:42:new1': JSON.stringify({ statusId: 'new1', acct: 'alice@example.com', visibility: 'public', url: 'https://social.example/@alice/new1' }),
      'mastodon:user:42': JSON.stringify({ instance: 'https://social.example', accessToken: 'user-token', visibility: 'unlisted' }),
    });
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://social.example/api/v1/statuses/new1/reblog') {
        return new Response(JSON.stringify({ id: 'boosted' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleRequest(
      jsonRequest({ callback_query: { id: 'tlcb1', data: 'tl_boost:new1', from: { id: 42 }, message: { message_id: 31, chat: { id: 42, type: 'private' } } } }),
      env,
      { fetch: fetchMock }
    );

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://social.example/api/v1/statuses/new1/reblog')).toBe(true);
    const sendCall = fetchMock.mock.calls.find(([url]) => url.includes('/sendMessage'));
    expect(JSON.parse(sendCall[1].body).text).toContain('已转发');
  });

});
