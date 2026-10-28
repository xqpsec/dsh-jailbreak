import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEndpoints, hostMatches, loadEndpointConfig, matchEndpoint, normalizeEndpoints } from '../lib/endpoint.js';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'jalibreak-endpoint-'));
}

test('normalize turns strings into lowercase lists and keeps defaults', () => {
  assert.deepEqual(normalizeEndpoints({}).hosts, ['*']);
  assert.deepEqual(normalizeEndpoints({ hosts: 'Api.Foo.com, *.corp.lan' }).hosts, ['api.foo.com', '*.corp.lan']);
  assert.deepEqual(normalizeEndpoints({ hosts: [] }).hosts, ['*']);
  assert.deepEqual(normalizeEndpoints({ suffixes: 'completions' }).suffixes, ['completions']);
  assert.equal(normalizeEndpoints({ enabled: false }).enabled, false);
});

test('host patterns: exact, wildcard and catch-all', () => {
  assert.equal(hostMatches('api.deepseek.com', ['api.deepseek.com']), true);
  assert.equal(hostMatches('api.deepseek.com', ['deepseek.com']), false);
  assert.equal(hostMatches('a.b.foo.com', ['*.foo.com']), true);
  assert.equal(hostMatches('foo.com', ['*.foo.com']), true);
  assert.equal(hostMatches('notfoo.com', ['*.foo.com']), false);
  assert.equal(hostMatches('x.y', ['*']), true);
});

test('matchEndpoint gates on host, path and skip list', () => {
  const cfg = { hosts: ['*.corp.lan'], suffixes: ['/chat/completions'] };
  assert.ok(matchEndpoint('https://gw.corp.lan/v1/chat/completions', cfg));
  assert.equal(matchEndpoint('https://gw.corp.lan/v1/models', cfg), null);
  assert.equal(matchEndpoint('https://gw.example.com/v1/chat/completions', cfg), null);
  assert.equal(matchEndpoint('not a url', cfg), null);
  assert.equal(matchEndpoint('https://gw.corp.lan/chat/completions', { ...cfg, skipHosts: ['gw.corp.lan'] }), null);
  assert.equal(matchEndpoint('https://gw.corp.lan/chat/completions', { ...cfg, enabled: false }), null);
});

test('loadEndpointConfig prefers root live.json, then env, then default', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'live.json'), JSON.stringify({ hosts: ['api.deepseek.com'] }), 'utf8');
  const fromRoot = loadEndpointConfig({ root, pluginRoot: root, env: { DSH_JALIBREAK_ENDPOINTS: '{"hosts":["env.example"]}' } });
  assert.deepEqual(fromRoot.hosts, ['api.deepseek.com']);

  const empty = await tempRoot();
  const fromEnv = loadEndpointConfig({ root: empty, pluginRoot: empty, env: { DSH_JALIBREAK_ENDPOINTS: '{"hosts":["env.example"]}' } });
  assert.deepEqual(fromEnv.hosts, ['env.example']);

  const fallback = loadEndpointConfig({ root: empty, pluginRoot: empty, env: { DSH_JALIBREAK_ENDPOINTS: '{broken' } });
  assert.deepEqual(fallback.hosts, ['*']);
  assert.equal(fallback.suffixes[0], '/chat/completions');
});

test('describeEndpoints is human readable', () => {
  assert.match(describeEndpoints({}), /任意域名/);
  assert.match(describeEndpoints({ hosts: ['api.deepseek.com'] }), /api\.deepseek\.com/);
  assert.match(describeEndpoints({ enabled: false }), /关闭/);
  assert.ok(PLUGIN_ROOT.length > 2);
});
