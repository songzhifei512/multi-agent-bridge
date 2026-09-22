import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-bridge-panel';

// webServer is the host web server service (camelCase). Registering a duplicate
// prefix like /api throws at boot because dsh-client-connection owns it, so the
// panel proxies under the unique /bridge prefix.
export const inject = ['webServer'];

export const Config = z.object({
  port: z.number().default(3000),
  autoStart: z.boolean().default(true),
  bridgePanelPath: z.string().default(''),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Forward a raw node:http request to the bridge-web-panel subprocess. Piping the
// response (rather than buffering) keeps the SSE stream at /bridge/events live.
function makeForwarder(targetPort: number) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const targetPath = (req.url || '/').replace(/^\/bridge/, '') || '/';
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    });
    req.pipe(proxyReq);
  };
}

export function apply(ctx: any, config: any) {
  const panelPort: number = config?.port ?? 3000;
  const autoStart: boolean = config?.autoStart ?? true;

  // Resolve the bridge-web-panel script. Config override wins; otherwise walk up
  // from this bundle (dsh-panel/dist) to the repo's bridge/mcp directory. The
  // plugin may be loaded through a junction, so realpath the base first.
  const bridgePanelPath =
    config?.bridgePanelPath ||
    path.resolve(__dirname, '../../bridge/mcp/bridge-web-panel.mjs');

  // Register the same-origin proxy under /bridge. The forwarder strips the
  // /bridge prefix, so /bridge/api/state → localhost:port/api/state.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/bridge',
        handler: makeForwarder(panelPort),
      }),
    'dsh-bridge-panel: /bridge proxy',
  );

  if (!autoStart) return;

  let child: ReturnType<typeof spawn> | null = null;
  let disposed = false;
  let rapidExits = 0;
  let spawnedAt = 0;

  // The panel self-exits when its source changes (dev reload), so respawn on any
  // exit unless the fiber is being torn down. Back off exponentially when the
  // child dies within seconds of spawn (broken code / port busy) to avoid a
  // tight respawn loop.
  const spawnPanel = () => {
    if (disposed) return;
    spawnedAt = Date.now();
    child = spawn('node', [bridgePanelPath, '--port', String(panelPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (d: Buffer) => {
      console.log(`[bridge-panel] ${d.toString().trim()}`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      console.error(`[bridge-panel ERROR] ${d.toString().trim()}`);
    });
    child.on('exit', (code) => {
      console.log(`[bridge-panel] exited with code ${code}`);
      if (disposed) return;
      const lifetime = Date.now() - spawnedAt;
      rapidExits = lifetime < 5000 ? rapidExits + 1 : 0;
      const delay = Math.min(15000, 800 * 2 ** rapidExits);
      setTimeout(spawnPanel, delay);
    });

    console.log(`[dsh-bridge-panel] spawned panel process (PID: ${child.pid})`);
  };

  ctx.effect(() => {
    disposed = false;
    spawnPanel();

    // Disposer: kill the child when the fiber is torn down.
    return () => {
      disposed = true;
      if (child && !child.killed) {
        console.log('[dsh-bridge-panel] shutting down panel process');
        child.kill();
      }
    };
  }, 'dsh-bridge-panel: child process');
}
