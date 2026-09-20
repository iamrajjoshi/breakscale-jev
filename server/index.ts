import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import { createApp } from './app.ts';
import { loadKey } from './jev.ts';

const port = Number(process.env.PORT ?? 4176);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be an integer between 1024 and 65535.');
const production = process.argv.includes('--production');
const key = await loadKey();
const vite = production
  ? undefined
  : await createVite({
      server: {
        middlewareMode: true,
        host: '127.0.0.1',
        ws: { host: '127.0.0.1', port: port <= 44935 ? port + 20600 : port - 20600 },
      },
      appType: 'spa',
    });
const server = createApp({
  key,
  middleware: vite?.middlewares,
  dist: production ? resolve('dist') : undefined,
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `breakscale-jev: http://127.0.0.1:${port} · Jev ${key ? 'configured' : 'not configured'}`,
  ),
);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  void vite?.close();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
