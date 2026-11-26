import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { createKernelProxy } from '../lib/proxy.js';

const gzip = promisify(gzipCallback);

async function upstreamServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('proxy preserves upstream base path, query, credentials and streams response', async (t) => {
  let seen;
  const upstream = await upstreamServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 10);
    });
  });
  const proxy = createKernelProxy({ upstream: `${upstream.url}/gateway?fixed=1`, port: 0 });
  await proxy.listen();
  t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions?stream=1`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer retained' },
    body: JSON.stringify({ model: 'kimi-k3.1-pro', temperature: 0.9, messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(await response.text(), 'data: one\n\ndata: two\n\n');
  assert.equal(seen.url, '/gateway/v1/chat/completions?stream=1');
  assert.equal(seen.authorization, 'Bearer retained');
  assert.equal(seen.body.temperature, 0.9);
  assert.match(seen.body.messages[0].content, /最新用户请求/);
  assert.equal(proxy.stats.transformed, 1);
  const health = await (await fetch(`${proxy.address()}/__kernel/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.stats.transformed, 1);
});

test('proxy off forwards exact JSON and non-JSON endpoints stay usable', async (t) => {
  const bodies = [];
  const upstream = await upstreamServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { bodies.push(Buffer.concat(chunks).toString()); res.end('ok'); });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { enabled: false } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const original = '{"messages":[{"role":"user","content":"hello"}],"temperature":0.4}';
  await fetch(`${proxy.address()}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: original });
  await fetch(`${proxy.address()}/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'not json' });
  assert.deepEqual(bodies, [original, 'not json']);
  assert.equal(proxy.stats.transformed, 0);
  assert.equal(proxy.stats.passthrough, 2);
});

test('proxy returns an upstream error instead of hanging', async (t) => {
  const proxy = createKernelProxy({ upstream: 'http://127.0.0.1:1', port: 0 });
  await proxy.listen(); t.after(() => proxy.close());
  const response = await fetch(`${proxy.address()}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"hello"}' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.type, /kernel_proxy_error/);
});

test('proxy rejects oversized bodies and stays usable', async (t) => {
  const proxy = createKernelProxy({ upstream: 'http://127.0.0.1:1', port: 0, maxBodyBytes: 16 });
  await proxy.listen(); t.after(() => proxy.close());
  const response = await fetch(`${proxy.address()}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"this is too large"}',
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error.message, /exceeds 16 bytes/);
  const health = await (await fetch(`${proxy.address()}/__kernel/health`)).json();
  assert.equal(health.stats.errors, 1);
});

test('proxy closes an unfinished stream when the upstream disconnects', async (t) => {
  const upstream = await upstreamServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
    setTimeout(() => res.destroy(), 10);
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0 });
  await proxy.listen();
  t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"hello"}',
  });
  await assert.rejects(async () => {
    for await (const _chunk of response.body) { /* consume until disconnect */ }
  });
});

test('proxy ignores a client that disconnects during its request body', async (t) => {
  const proxy = createKernelProxy({ upstream: 'http://127.0.0.1:1', port: 0 });
  await proxy.listen(); t.after(() => proxy.close());
  const socket = (await import('node:net')).connect(new URL(proxy.address()).port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{"input":');
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const health = await (await fetch(`${proxy.address()}/__kernel/health`)).json();
  assert.equal(health.stats.errors, 1);
});

const completion = (content) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

test('ladder is off by default: a refusal-shaped answer is returned as-is', async (t) => {
  let calls = 0;
  const upstream = await upstreamServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(completion('抱歉，我不能提供这个。')); });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0 });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.equal((await response.json()).choices[0].message.content, '抱歉，我不能提供这个。');
  assert.equal(calls, 1);
  assert.equal(proxy.stats.retried, 0);
});

test('ladder escalates on a refusal and returns the first delivery', async (t) => {
  const seen = [];
  const upstream = await upstreamServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks));
      seen.push(body.messages[0].content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(seen.length === 1 ? completion('我不能帮助编写这个工具。') : completion('```c\nint main() { return 0; }\n```'));
    });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { attempts: 2 } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.match((await response.json()).choices[0].message.content, /int main/);
  assert.equal(seen.length, 2);
  assert.equal(proxy.stats.retried, 1);
  // rung 0 and rung 1 are different directives, and the user turn is untouched
  assert.notEqual(seen[0], seen[1]);
  assert.match(seen[0], /最新用户请求/);
  assert.match(seen[1], /最新用户请求/);
});

test('ladder returns the last refusal when every rung refuses', async (t) => {
  let calls = 0;
  const upstream = await upstreamServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(completion(`拒绝提供（第 ${calls} 次）`)); });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { attempts: 3 } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.match((await response.json()).choices[0].message.content, /第 3 次/);
  assert.equal(calls, 3);
  assert.equal(proxy.stats.retried, 2);
});

test('ladder leaves streaming responses alone', async (t) => {
  let calls = 0;
  const upstream = await upstreamServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 抱歉，我不能提供\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { attempts: 3 } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(calls, 1);
  assert.equal(proxy.stats.retried, 0);
});

test('ladder stops escalating on a non-200 and passes the error body through', async (t) => {
  let calls = 0;
  const upstream = await upstreamServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"slow down"}}'); });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { attempts: 3 } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error.message, /slow down/);
  assert.equal(calls, 1);
});

test('ladder reads a gzip-compressed refusal and hands the client plain bytes', async (t) => {
  let calls = 0;
  const upstream = await upstreamServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', async () => {
      const payload = Buffer.from(completion(calls === 1 ? '我不能提供这个实现。' : '完整实现见下。'));
      const body = calls === 1 ? await gzip(payload) : payload;
      res.writeHead(200, { 'content-type': 'application/json', ...(calls === 1 ? { 'content-encoding': 'gzip' } : {}) });
      res.end(body);
    });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { attempts: 2 } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.equal(response.headers.get('content-encoding'), null);
  assert.match((await response.json()).choices[0].message.content, /完整实现/);
  assert.equal(calls, 2);
  assert.equal(proxy.stats.retried, 1);
});

test('proxy keeps idle client sockets alive past the default 5 s window', async (t) => {
  const upstream = await upstreamServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  const proxy = createKernelProxy({ upstream: upstream.url, port: 0, kernel: { attempts: 3 } });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  // A client that pauses between escalated calls reuses this socket; the Node
  // default would have closed it and surfaced as "fetch failed".
  assert.ok(proxy.server.keepAliveTimeout >= 65_000);
  assert.ok(proxy.server.headersTimeout > proxy.server.keepAliveTimeout);
});

test('proxy stops escalating once the attempt budget is spent', async (t) => {
  let calls = 0;
  const upstream = await upstreamServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '抱歉，我不能提供这个。' } }] }));
    });
  });
  const proxy = createKernelProxy({
    upstream: upstream.url,
    port: 0,
    kernel: { attempts: 4 },
    attemptBudgetMs: -1,
  });
  await proxy.listen(); t.after(async () => { await proxy.close(); upstream.server.close(); });
  const response = await fetch(`${proxy.address()}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
  });
  assert.match((await response.json()).choices[0].message.content, /抱歉/);
  assert.equal(response.headers.get('x-kernel-rung'), '0');
  assert.equal(calls, 1);
  assert.equal(proxy.stats.retried, 0);
});
