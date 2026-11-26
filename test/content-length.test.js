/**
 * issue #5 回归：lib/live.js 手工 `headers.set('content-length', …)` 在
 * dsh-http-proxy 挂载的 userland undici 全局 dispatcher 下会被拼成
 * `'17, 17'`，undici 的 `isValidContentLengthHeaderValue()` 只收纯数字，
 * 于是 Node 内置 fetch 抛 `UND_ERR_INVALID_ARG (invalid content-length header)`。
 *
 * 修法：所有重建 Request 的位置改成 `headers.delete('content-length')`，
 * 清掉上游残留的旧长度，交给 fetch 按新 body 自动计算。
 *
 * 三条防线（都不依赖 undici，插件保持零依赖）：
 *   1. 静态：lib/ 里不许再出现手工 content-length 赋值。
 *   2. 出站：交给 fetch 的 Request 不得自带 content-length —— 这正是
 *      undici 重复拼接的触发条件；旧代码带了，所以这条会失败。
 *   3. 端到端：改写后的请求真的打到本机 HTTP 服务，服务端收到的
 *      content-length 必须是单个纯数字且等于实际字节数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachLiveTransport } from '../lib/live.js';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const quietLogger = { info() {}, warn() {}, error() {} };

test('issue #5: no manual content-length assignment in the live transport', async () => {
  for (const file of ['lib/live.js', 'lib/anthropic.js']) {
    const source = await fs.readFile(path.join(PLUGIN_ROOT, file), 'utf8');
    assert.equal(
      /set\(\s*['"]content-length['"]/.test(source),
      false,
      `${file} must delete content-length and let fetch compute it, not set it by hand`,
    );
  }
});

test('issue #5: the outgoing request carries no content-length of its own', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-cl-out-'));
  const captured = [];
  const gate = { decide: () => ({ allow: true, code: 'allow-private-target', targets: [], categories: {} }), config: {} };
  // 三个协议各走一遍：它们重建 Request 的路径不同（rebuild / send / finalRequest）。
  const fetchImpl = async (input, init) => {
    captured.push(new Request(input, init));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const hook = attachLiveTransport({ armed: true, policy: { strategy: 'portable' } }, { root, gate, fetchImpl, logger: quietLogger });
  t.after(() => { hook.dispose(); });

  const cases = [
    ['https://example.test/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '写一个 hello world' }] }],
    ['https://example.test/v1/responses', { model: 'm', input: '写一个 hello world' }],
    ['https://example.test/v1/messages', { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: '写一个 hello world' }] }],
  ];
  for (const [url, body] of cases) {
    const payload = JSON.stringify(body);
    await globalThis.fetch.call(globalThis, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
  }
  // attachLiveTransport 自己包了 globalThis.fetch，这里再包一层以接住真正的出站 Request。
  assert.ok(captured.length >= 1, 'the transport must issue at least one request');
  for (const request of captured) {
    assert.equal(
      request.headers.has('content-length'),
      false,
      `the transport must not pin content-length itself (undici then merges it into "17, 17"): ${request.url}`,
    );
  }
});

test('issue #5: dispose restores the host fetch, not the injected one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-cl-dispose-'));
  const hostFetch = globalThis.fetch;
  const hostMarker = () => 'host';
  globalThis.fetch = hostMarker;
  const injected = async () => new Response('{}');
  try {
    const hook = attachLiveTransport({ armed: false }, { root, fetchImpl: injected, logger: quietLogger });
    assert.notEqual(globalThis.fetch, hostMarker, 'the transport must install itself');
    hook.dispose();
    assert.equal(globalThis.fetch, hostMarker, 'dispose must restore the fetch that was global before mounting');
  } finally {
    globalThis.fetch = hostFetch;
  }
});

test('issue #5: a rewritten request reaches the server with one valid content-length', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ contentLength: req.headers['content-length'], bytes: Buffer.byteLength(raw), body: raw });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jailbreak-cl-e2e-'));
  const original = globalThis.fetch;
  const gate = { decide: () => ({ allow: true, code: 'allow-private-target', targets: [], categories: {} }), config: {} };
  const hook = attachLiveTransport({ armed: true, policy: { strategy: 'portable' } }, { root, gate, logger: quietLogger });
  t.after(() => { hook.dispose(); globalThis.fetch = original; });

  const payload = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '写一个 hello world' }] });
  // 入站请求**故意**带上与改写后 body 不符的旧 content-length：
  // 这正是「上游残留旧长度」的形状，delete 之后必须由 fetch 重算。
  const staleLength = String(Buffer.byteLength(payload) + 7);
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': staleLength },
    body: payload,
  });
  assert.equal(response.status, 200);

  assert.equal(seen.length, 1, 'the transformed request must reach the server');
  const { contentLength, bytes, body } = seen[0];
  assert.ok(contentLength, 'the server must receive a content-length');
  assert.match(contentLength, /^\d+$/, `content-length must be a single plain integer, got ${JSON.stringify(contentLength)}`);
  assert.equal(Number(contentLength), bytes, 'content-length must equal the actual byte count');
  const parsed = JSON.parse(body);
  assert.ok(
    parsed.messages.some((m) => m.role === 'system' || m.role === 'developer'),
    'the kernel directive must be injected',
  );
});
