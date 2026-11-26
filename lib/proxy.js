import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { transformRequest, detectRefusal, KERNEL_VERSION, KERNEL_LADDER } from './kernel.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// Attempts wrap around the ladder, so the cap allows two full passes; a hard
// clamp at the ladder length would only repeat the last rung.
const MAX_ATTEMPTS = 2 * KERNEL_LADDER.length;

// Providers compress replies when the client advertises gzip; the ladder has to read
// the text to decide whether to escalate, so buffered calls ask for plain bytes and
// still decode in case a gateway ignores `identity`.
function decodeBody(buffer, encoding) {
  const kind = String(encoding ?? '').trim().toLowerCase();
  try {
    if (!kind || kind === 'identity') return buffer;
    if (kind === 'gzip' || kind === 'x-gzip') return zlib.gunzipSync(buffer);
    if (kind === 'deflate') return zlib.inflateSync(buffer);
    if (kind === 'br') return zlib.brotliDecompressSync(buffer);
  } catch { return null; }
  return buffer;
}

function headersWithoutHopByHop(headers) {
  const out = {};
  const connection = String(headers.connection ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || connection.includes(name.toLowerCase()) || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

async function readBody(req, limit) {
  if (req.destroyed) {
    const error = new Error('client disconnected before sending the request body');
    error.statusCode = 499;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`);
      error.statusCode = 413;
      req.resume();
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Pull the assistant text out of any of the four wire shapes the kernel supports. */
function extractText(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return raw; }
  const flatten = (value) => {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  };
  const choice = payload?.choices?.[0];
  if (choice) return flatten(choice.message?.content ?? choice.text);
  if (Array.isArray(payload?.content)) return payload.content.map((part) => part?.text ?? '').join('');
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output.map((item) => (Array.isArray(item?.content) ? item.content.map((part) => part?.text ?? '').join('') : '')).join('');
  }
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((part) => part?.text ?? '').join('');
  return '';
}

/** A response-stream-preserving reverse proxy using only Node built-ins. */
export function createKernelProxy({
  upstream,
  host = '127.0.0.1',
  port = 8788,
  kernel = {},
  maxBodyBytes = 16 * 1024 * 1024,
  maxRetryBytes = 8 * 1024 * 1024,
  requestTimeoutMs = 10 * 60 * 1000,
  attemptBudgetMs = 3 * 60 * 1000,
  logger = null,
} = {}) {
  if (!upstream) throw new Error('upstream is required');
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('upstream must be HTTP(S)');
  const transport = target.protocol === 'https:' ? https : http;
  const stats = { requests: 0, transformed: 0, passthrough: 0, errors: 0, retried: 0 };
  const log = (message) => { try { logger?.info?.(message); } catch { /* diagnostics are optional */ } };

  const sendUpstream = (url, headers, body, { buffer, timeoutMs }) => new Promise((resolve, reject) => {
    const request = transport.request(url, { method: 'POST', headers }, (upstreamResponse) => {
      if (!buffer) { resolve({ stream: upstreamResponse }); return; }
      const chunks = [];
      let size = 0;
      let overflow = false;
      upstreamResponse.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxRetryBytes) { overflow = true; chunks.length = 0; return; }
        if (!overflow) chunks.push(chunk);
      });
      upstreamResponse.once('aborted', () => reject(new Error('upstream aborted the response')));
      upstreamResponse.once('error', reject);
      upstreamResponse.once('end', () => {
        const raw = Buffer.concat(chunks);
        const decoded = overflow ? null : decodeBody(raw, upstreamResponse.headers['content-encoding']);
        resolve({
          statusCode: upstreamResponse.statusCode ?? 502,
          statusMessage: upstreamResponse.statusMessage,
          headers: upstreamResponse.headers,
          payload: decoded ?? raw,
          decoded: decoded !== null,
          overflow,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('upstream request timed out')));
    request.once('error', reject);
    request.end(body);
  });

  const writeBuffered = (res, { statusCode, statusMessage, headers, payload, decoded }) => {
    if (res.destroyed || res.writableEnded) return;
    const plain = headersWithoutHopByHop(headers);
    if (decoded) delete plain['content-encoding'];
    plain['content-length'] = String(payload.length);
    res.writeHead(statusCode, statusMessage, plain);
    res.end(payload);
  };

  const server = http.createServer(async (req, res) => {
    if (req.url === '/__kernel/health') {
      const payload = JSON.stringify({ ok: true, version: KERNEL_VERSION, upstream: target.origin, attempts: MAX_ATTEMPTS, stats });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    stats.requests += 1;
    try {
      if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) {
        req.resume();
        const error = new Error(`request body exceeds ${maxBodyBytes} bytes`);
        error.statusCode = 413;
        throw error;
      }
      const raw = await readBody(req, maxBodyBytes);
      const incoming = new URL(req.url ?? '/', 'http://kernel.local');
      const basePath = target.pathname.replace(/\/$/, '');
      const url = new URL(`${basePath}${incoming.pathname}${incoming.search}`, target);
      const headers = headersWithoutHopByHop(req.headers);
      headers.host = target.host;
      let parsed = null;
      if (req.method === 'POST' && raw.length && !req.headers['content-encoding']) {
        try {
          const candidate = JSON.parse(raw.toString('utf8'));
          parsed = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
        } catch { parsed = null; }
      }
      const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, Math.trunc(Number(kernel.attempts ?? 1)) || 1));
      // Retrying needs the whole reply in hand, so it only applies to non-streaming calls.
      const retry = attempts > 1 && parsed !== null && parsed.stream !== true && kernel.enabled !== false;
      // An explicit directive pins every attempt to the same text; the ladder only
      // takes over when the caller left `text` unset.
      const baseOptions = { ...kernel };
      delete baseOptions.text;
      let result = null;
      let rungUsed = 0;
      const startedAt = Date.now();
      for (let attempt = 0; attempt < (retry ? attempts : 1); attempt += 1) {
        let body = raw;
        rungUsed = attempt;
        if (parsed !== null) {
          const transformed = transformRequest({ body: parsed, url }, attempt === 0 ? kernel : { ...baseOptions, attempt });
          if (transformed.changed) {
            body = Buffer.from(JSON.stringify(transformed.body));
            stats.transformed += 1;
            log(`[kernel] ${transformed.protocol} system +${transformed.addedChars} chars${attempt ? ` (rung ${attempt})` : ''}`);
          } else stats.passthrough += 1;
        } else stats.passthrough += 1;
        headers['content-length'] = String(body.length);
        if (retry) headers['accept-encoding'] = 'identity';
        if (!retry) {
          const streamed = await sendUpstream(url, headers, body, { buffer: false, timeoutMs: requestTimeoutMs });
          const upstreamResponse = streamed.stream;
          const failStream = () => {
            if (res.destroyed || res.writableEnded) return;
            stats.errors += 1;
            res.destroy();
          };
          upstreamResponse.once('aborted', failStream);
          upstreamResponse.once('error', failStream);
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headersWithoutHopByHop(upstreamResponse.headers));
          upstreamResponse.pipe(res);
          res.on('close', () => {
            if (!res.writableEnded) upstreamResponse.destroy();
          });
          return;
        }
        result = await sendUpstream(url, headers, body, { buffer: true, timeoutMs: requestTimeoutMs });        if (result.statusCode !== 200 || result.overflow) break;
        if (!detectRefusal(extractText(result.payload.toString('utf8')))) break;
        if (attempt === attempts - 1) break;
        // Escalation chains multiply latency; stop adding attempts once the wall
        // clock would outlive a normal client timeout and return what we have.
        if (Date.now() - startedAt > attemptBudgetMs) {
          log(`[kernel] attempt budget ${attemptBudgetMs}ms spent after rung ${attempt}, returning that reply`);
          break;
        }
        stats.retried += 1;
        log(`[kernel] refusal-shaped reply on rung ${attempt}, escalating to rung ${attempt + 1}`);
      }
      if (result) {
        // Which rung finally produced the reply — a client-side progress signal,
        // since the counters are process-wide and useless under concurrency.
        res.setHeader('x-kernel-rung', String(rungUsed));
        writeBuffered(res, result);
      }
    } catch (error) {
      stats.errors += 1;
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(error.statusCode ?? (error.message?.includes('timed out') ? 504 : 502), { 'content-type': 'application/json', connection: 'close' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { type: 'kernel_proxy_error', message: error.message } }));
    }
  });

  // Node closes idle keep-alive sockets after 5 s. A client that pauses between
  // escalated calls reuses one and reports "fetch failed"; match the socket
  // lifetime to the upstream timeout instead.
  server.keepAliveTimeout = Math.max(65_000, requestTimeoutMs);
  server.headersTimeout = server.keepAliveTimeout + 1_000;

  return {
    server,
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      return this.address();
    },
    address() {
      const address = server.address();
      return address && typeof address === 'object' ? `http://${host}:${address.port}` : null;
    },
    async close() {
      if (!server.listening) return;
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
