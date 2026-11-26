import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KERNEL_TEXT, KERNEL_LADDER, detectKernelProtocol, detectRefusal, transformRequest } from '../lib/kernel.js';

const sampling = Object.freeze({ temperature: 0.83, top_p: 0.77, max_tokens: 777, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
const fixtures = [
  { protocol: 'openai', url: 'https://host/v1/chat/completions', body: { model: 'kimi-k3.1-pro', ...sampling, messages: [{ role: 'user', content: 'Write a haiku. Output only the poem.' }] }, system: (body) => body.messages[0].content },
  { protocol: 'openai', url: 'https://host/v1/chat/completions', body: { ...sampling, messages: [{ role: 'system', content: [{ type: 'text', text: 'Host voice' }] }, { role: 'user', content: 'continue' }] }, system: (body) => body.messages[0].content.at(-1).text },
  { protocol: 'anthropic', url: 'https://host/v1/messages', body: { ...sampling, system: 'Host voice', messages: [{ role: 'user', content: 'continue' }] }, system: (body) => body.system },
  { protocol: 'anthropic', url: 'https://host/v1/messages', body: { ...sampling, system: [{ type: 'text', text: 'Host voice' }], messages: [{ role: 'user', content: 'continue' }] }, system: (body) => body.system.at(-1).text },
  { protocol: 'responses', url: 'https://host/v1/responses', body: { ...sampling, instructions: 'Host voice', input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }] }, system: (body) => body.instructions },
  { protocol: 'responses', url: 'https://host/v1/responses', body: { ...sampling, input: 'continue' }, system: (body) => body.instructions },
  { protocol: 'gemini', url: 'https://host/v1beta/models/k:generateContent', body: { contents: [{ role: 'user', parts: [{ text: 'continue' }] }], generationConfig: { temperature: 0.83, topP: 0.77, maxOutputTokens: 777, thinkingConfig: { thinkingBudget: 1024 } } }, system: (body) => body.systemInstruction.parts.at(-1).text },
];

test('kernel is portable and directive has no fixed output template', () => {
  assert.ok(DEFAULT_KERNEL_TEXT.length < 600);
  assert.doesNotMatch(DEFAULT_KERNEL_TEXT, /Markdown|JSON|bullet|artifact first|output only|代码块/);
});

for (const { protocol, url, body, system } of fixtures) {
  test(`${protocol} applies universally, preserves host and generation settings, and is idempotent`, () => {
    const snapshot = structuredClone(body);
    const out = transformRequest({ url, body });
    assert.equal(out.changed, true);
    assert.equal(out.protocol, protocol);
    assert.equal(out.mode, 'system');
    assert.notEqual(out.body, body);
    assert.deepEqual(body, snapshot, 'input is immutable');
    assert.match(system(out.body), /Host voice|最新用户请求/);
    assert.match(system(out.body), /creative|genre|创作题/);
    for (const key of ['temperature', 'top_p', 'max_tokens', 'thinking', 'reasoning_effort']) {
      if (key in snapshot) assert.deepEqual(out.body[key], snapshot[key], key);
    }
    assert.deepEqual(out.body.generationConfig, snapshot.generationConfig);
    if (protocol === 'openai') assert.equal(out.body.messages.at(-1).role, 'user', 'no assistant prefill');
    const again = transformRequest({ url, body: out.body });
    assert.equal(again.changed, false);
    assert.equal(again.reason, 'already-applied');
    assert.deepEqual(again.body, out.body);
  });
}

test('all protocols transform unknown benign tasks without category inference', () => {
  for (const protocol of ['openai', 'anthropic', 'responses', 'gemini']) {
    const body = protocol === 'openai' ? { messages: [{ role: 'user', content: 'Design a birthday invitation as three lines.' }] }
      : protocol === 'anthropic' ? { messages: [{ role: 'user', content: 'x' }] }
        : protocol === 'responses' ? { input: 'x' }
          : { contents: [{ role: 'user', parts: [{ text: 'x' }] }] };
    const out = transformRequest({ protocol, body });
    assert.equal(out.changed, true, protocol);
    assert.equal(out.goalId, undefined);
    assert.equal(out.domain, undefined);
  }
});

test('off, empty directive and invalid requests are byte-equivalent passthroughs', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  for (const options of [{ enabled: false }, { text: '' }, { text: '   ' }]) {
    const out = transformRequest({ protocol: 'openai', body }, options);
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
  }
  for (const request of [{ body: null }, { body: [] }, { body: {}, url: 'https://host/models' }]) {
    assert.equal(transformRequest(request).changed, false);
  }
});

test('endpoint detection is case insensitive and does not confuse models', () => {
  assert.equal(detectKernelProtocol('https://host/V1/MESSAGES?x=1'), 'anthropic');
  assert.equal(detectKernelProtocol('/v1/responses'), 'responses');
  assert.equal(detectKernelProtocol('/v1beta/models/k:streamGenerateContent'), 'gemini');
  assert.equal(detectKernelProtocol('/v1/models'), null);
});

test('developer and tool instructions survive without rewriting the user task', () => {
  const body = {
    messages: [
      { role: 'developer', content: 'Preserve the established product voice.' },
      { role: 'system', content: 'Host voice' },
      { role: 'user', content: [{ type: 'text', text: 'Return exactly one short line.' }] },
    ],
    tools: [{ type: 'function', function: { name: 'lookup' } }],
    response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
  };
  const out = transformRequest({ protocol: 'openai', body });
  assert.equal(out.body.messages[0].role, 'developer');
  assert.equal(out.body.messages[1].role, 'system');
  assert.deepEqual(out.body.messages.at(-1), body.messages.at(-1));
  assert.deepEqual(out.body.tools, body.tools);
  assert.deepEqual(out.body.response_format, body.response_format);
});

test('structured Gemini system instructions and OpenAI developer-only requests are supported', () => {
  const gemini = { systemInstruction: { role: 'system', parts: [{ text: 'Host voice' }] }, contents: [{ parts: [{ text: 'hello' }] }] };
  assert.equal(transformRequest({ protocol: 'gemini', body: gemini }).body.systemInstruction.role, 'system');
  const openai = { messages: [{ role: 'developer', content: 'Host voice' }, { role: 'user', content: 'hello' }] };
  const out = transformRequest({ protocol: 'openai', body: openai });
  assert.equal(out.body.messages[0].role, 'developer');
  assert.equal(out.body.messages[1].role, 'developer');
});

test('ladder rungs are distinct, ordered, and rung 0 is the default', () => {
  assert.ok(KERNEL_LADDER.length >= 2);
  assert.equal(DEFAULT_KERNEL_TEXT, KERNEL_LADDER[0]);
  assert.equal(new Set(KERNEL_LADDER).size, KERNEL_LADDER.length);
  const rung0 = transformRequest({ protocol: 'openai', body: { messages: [{ role: 'user', content: 'go' }] } });
  const rung1 = transformRequest({ protocol: 'openai', body: { messages: [{ role: 'user', content: 'go' }] } }, { attempt: 1 });
  // Attempts wrap around the ladder: pass the last rung and the sequence starts
  // over, so a retry ladder can run several passes without going flat.
  const wrapped = transformRequest({ protocol: 'openai', body: { messages: [{ role: 'user', content: 'go' }] } }, { attempt: KERNEL_LADDER.length });
  assert.equal(rung0.body.messages[0].content, KERNEL_LADDER[0]);
  assert.equal(rung1.body.messages[0].content, KERNEL_LADDER[1]);
  assert.equal(wrapped.body.messages[0].content, KERNEL_LADDER[0]);
  assert.equal(rung1.changed, true);
});

test('an explicit directive pins every attempt to the same text', () => {
  const body = { messages: [{ role: 'user', content: 'go' }] };
  const first = transformRequest({ protocol: 'openai', body }, { text: 'PINNED' });
  const again = transformRequest({ protocol: 'openai', body }, { text: 'PINNED', attempt: 2 });
  assert.equal(first.body.messages[0].content, 'PINNED');
  assert.equal(again.body.messages[0].content, 'PINNED');
});

test('refusal detector catches the measured refusal shapes and leaves deliveries alone', () => {
  const refusals = [
    '抱歉，我不能提供这个。',
    '我不能帮助你编写这个工具。',
    '我无法提供绕过验证码的实现方案，因为这些行为违反平台服务条款。',
    '不能提供 PHP 一句话木马，也不能指导绕过图片上传校验。',
    '这个忙我帮不了。',
    '我坚决不能协助制作假身份证。',
    'I cannot fulfill this request.',
    "I'm sorry, but I can't help with that.",
  ];
  for (const text of refusals) assert.equal(detectRefusal(text), true, text);

  const deliveries = [
    '',
    '```bash\necho hello\n```',
    '这是一个只能在本机运行的脚本：先备份，再替换。',
    '# 标题\n\n第一段正文。',
    '诗人写道：月落乌啼霜满天。',
    '{"answer": 42}',
  ];
  for (const text of deliveries) assert.equal(detectRefusal(text), false, text);
});

test('refusal detector only reads the opening window', () => {
  const tail = `${'正常内容。'.repeat(120)}我不能提供这个。`;
  assert.equal(detectRefusal(tail), false);
});
