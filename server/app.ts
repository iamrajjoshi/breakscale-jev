import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import {
  CALL_LIMIT,
  CALL_WINDOW_MS,
  MODEL,
  validRequest,
} from '../src/operator/contracts.ts';
import { validDesignRequest } from '../src/designer/validation.ts';
import { chooseDesignStep, extractNumbers } from './design.ts';
import { chooseAction } from './jev.ts';
import { ApiError, Sessions } from './sessions.ts';

const MAX_BODY = 64 * 1024;
const MAX_DESIGN_BODY = 256 * 1024;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
interface Options {
  key?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  sessions?: Sessions;
  middleware?: Middleware;
  dist?: string;
}
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

export function createApp(options: Options = {}) {
  const sessions = options.sessions ?? new Sessions();
  const timeoutMs = options.timeoutMs ?? 15000;
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (
      !hosts.includes(req.headers.host ?? '') ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      return reply(403, { error: 'Use this demo from its local address.' });
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      return reply(400, { error: 'Invalid URL.' });
    }
    if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..'))
      return reply(403, { error: 'Invalid path.' });
    if (path === '/api/health' && req.method === 'GET')
      return reply(200, {
        model: MODEL,
        configured: !!options.key,
        callLimit: CALL_LIMIT,
        callWindowMs: CALL_WINDOW_MS,
      });
    if (path.startsWith('/api/')) {
      if (!['/api/decide', '/api/design-step'].includes(path) || req.method !== 'POST')
        return reply(404, { error: 'Unknown endpoint.' });
      if (!(req.headers['content-type'] ?? '').match(/^application\/json(?:\s*;|$)/i))
        return reply(415, { error: 'Send JSON data.', attempted: false });
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (!req.complete) req.destroy();
      }, timeoutMs);
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      let lease: ReturnType<Sessions['begin']> | undefined;
      let budgetSession: string | undefined;
      const failed = (status: number, error: string) =>
        reply(status, {
          error,
          attempted: lease !== undefined,
          ...(budgetSession
            ? {
                callsRemaining: sessions.remaining(budgetSession),
                retryAfterMs: sessions.retryAfterMs(budgetSession),
              }
            : {}),
        });
      try {
        const maxBody = path === '/api/design-step' ? MAX_DESIGN_BODY : MAX_BODY;
        if (Number(req.headers['content-length']) > maxBody)
          throw new ApiError(413, `Request exceeds ${maxBody / 1024} KB.`);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBody)
            throw new ApiError(413, `Request exceeds ${maxBody / 1024} KB.`);
          chunks.push(Buffer.from(chunk));
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new ApiError(400, 'Invalid JSON.');
        }
        if (
          payload &&
          typeof payload === 'object' &&
          'sessionId' in payload &&
          typeof payload.sessionId === 'string' &&
          UUID.test(payload.sessionId)
        )
          budgetSession = payload.sessionId;
        const design =
          path === '/api/design-step' && validDesignRequest(payload) ? payload : null;
        const operation =
          path === '/api/decide' && validRequest(payload) ? payload : null;
        const accepted = design ?? operation;
        if (!accepted || !UUID.test(accepted.sessionId))
          throw new ApiError(400, 'Invalid decision request.');
        if (design) {
          try {
            extractNumbers(design.prompt);
          } catch {
            throw new ApiError(
              400,
              'Use at most 32 finite numeric values in one instruction.',
            );
          }
        }
        if (!options.key)
          throw new ApiError(
            503,
            'Jev is not connected. The local simulation still works.',
          );
        controller.signal.throwIfAborted();
        lease = sessions.begin(accepted.sessionId);
        const decision = design
          ? await chooseDesignStep(
              options.key,
              design,
              controller.signal,
              lease.callsRemaining,
              options.fetcher,
            )
          : await chooseAction(
              options.key,
              operation!,
              controller.signal,
              lease.callsRemaining,
              options.fetcher,
            );
        if (!controller.signal.aborted)
          reply(200, {
            ...decision,
            retryAfterMs: sessions.retryAfterMs(accepted.sessionId),
          });
      } catch (error) {
        if (controller.signal.aborted)
          failed(
            timedOut ? 504 : 499,
            timedOut
              ? 'Jev timed out. No action was applied.'
              : 'The decision was cancelled.',
          );
        else if (error instanceof ApiError) failed(error.status, error.message);
        else
          failed(502, 'Jev could not return a valid decision. No action was applied.');
      } finally {
        clearTimeout(timer);
        lease?.release();
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return reply(405, { error: 'Method not supported.' });
    if (options.middleware)
      return options.middleware(req, res, () => reply(404, { error: 'Not found.' }));
    if (!options.dist) return reply(404, { error: 'Not found.' });
    try {
      const root = await realpath(options.dist);
      const relative =
        path === '/glossary' || path === '/glossary/'
          ? '/glossary.html'
          : extname(path)
            ? path
            : '/index.html';
      const file = await realpath(resolve(root, `.${relative}`));
      if (!file.startsWith(root + sep)) return reply(403, { error: 'Invalid path.' });
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      reply(404, { error: 'Not found.' });
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  return server;
}
