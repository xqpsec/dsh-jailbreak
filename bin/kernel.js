#!/usr/bin/env node
import fs from 'node:fs/promises';
import { transformRequest, DEFAULT_KERNEL_TEXT, KERNEL_VERSION } from '../lib/kernel.js';
import { createKernelProxy } from '../lib/proxy.js';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
const flags = {};
for (let i = command === 'help' ? 0 : 1; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) flags[key] = true;
  else { flags[key] = value; i += 1; }
}
const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

try {
  if (command === 'transform') {
    const raw = flags.file ? await fs.readFile(String(flags.file), 'utf8') : await new Promise((resolve) => {
      let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => resolve(data));
    });
    const input = JSON.parse(raw);
    const request = input.body ? input : { body: input, url: flags.url, protocol: flags.protocol };
    print(transformRequest(request, { enabled: flags.off !== true, text: flags.text }));
  } else if (command === 'proxy') {
    const proxy = createKernelProxy({
      upstream: flags.upstream ?? process.env.JAILBREAK_UPSTREAM,
      host: flags.host ?? '127.0.0.1',
      port: Number(flags.port ?? 8788),
      kernel: { enabled: flags.off !== true, text: flags.text, attempts: Number(flags.attempts ?? 1) },
      logger: console,
    });
    const address = await proxy.listen();
    print({ ok: true, address, version: KERNEL_VERSION, upstream: flags.upstream ?? process.env.JAILBREAK_UPSTREAM, health: `${address}/__kernel/health` });
    const stop = async () => { await proxy.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else {
    print([
      `pojia-kernel ${KERNEL_VERSION} — portable request-boundary kernel`,
      '',
      '  pojia-kernel proxy --upstream https://provider.example [--port 8788] [--attempts 1]',
      '  pojia-kernel transform --url https://host/v1/chat/completions < request.json',
      '',
      `Default directive (${DEFAULT_KERNEL_TEXT.length} chars): ${DEFAULT_KERNEL_TEXT}`,
    ].join('\n'));
  }
} catch (error) {
  console.error(`[pojia-kernel] ${error.message}`);
  process.exitCode = 1;
}
