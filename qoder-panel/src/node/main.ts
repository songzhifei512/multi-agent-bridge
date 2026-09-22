import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

// 模块加载时立即输出日志
console.log('[qoder-panel] === MODULE LOADED ===');
console.log('[qoder-panel] __dirname:', __dirname);
console.log('[qoder-panel] process.env.QODER_APP_PLUGIN_ALLOW_UNVERIFIED:', process.env.QODER_APP_PLUGIN_ALLOW_UNVERIFIED);

let child: ChildProcess | null = null;
let bridgePort = 0;
let disposed = false;
let rapidExits = 0;
let spawnedAt = 0;

/** 获取状态文件路径（跨平台兼容） */
function getStateFilePath(): string {
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, 'bridge-state.json');
}

/** 将状态写入共享文件 */
async function writeStateToFile(state: any): Promise<void> {
  try {
    const filePath = getStateFilePath();
    await fs.promises.writeFile(filePath, JSON.stringify(state), 'utf-8');
  } catch (err) {
    console.error('[bridge] write state failed:', err);
  }
}

/** 创建本地 HTTP 服务器供 Browser 侧访问状态 */
let stateServer: http.Server | null = null;
let stateServerPort = 0;

async function startStateServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/state' && req.method === 'GET') {
        // 从共享文件读取最新状态
        const filePath = getStateFilePath();
        fs.readFile(filePath, 'utf-8', (err, data) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read state file' }));
          } else {
            res.writeHead(200, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*' 
            });
            res.end(data);
          }
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        stateServerPort = addr.port;
        stateServer = srv;
        console.log(`[qoder-panel] state server started on port ${stateServerPort}`);
        resolve(stateServerPort);
      } else {
        srv.close();
        reject(new Error('Failed to get server port'));
      }
    });
    
    srv.on('error', reject);
  });
}

/** 寻找一个可用的 TCP 端口 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address();
      if (port && typeof port !== 'string') {
        const p = port.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('Failed to get port')));
      }
    });
    srv.on('error', reject);
  });
}

/** 解析 bridge-web-panel.mjs 的路径 */
function resolvePanelPath(): string {
  if (process.env.BRIDGE_PANEL_PATH) {
    return process.env.BRIDGE_PANEL_PATH;
  }
  return path.resolve(__dirname, '../../../bridge/mcp/bridge-web-panel.mjs');
}

/** 通过 HTTP 请求 bridge-web-panel 获取状态 */
function fetchBridgeState(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/api/state`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/** Node 侧代理 webview 的写操作（POST /api/run、/api/action 等） */
function postToPanel(port: number, path: string, body: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request({
      host: 'localhost',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed: any = {};
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode ?? 0, data: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, data: { error: err.message } }));
    req.end(payload);
  });
}

/** Spawn bridge-web-panel 子进程，带指数退避重启 */
function spawnPanel(bridgePath: string, port: number): void {
  if (disposed) return;
  spawnedAt = Date.now();

  child = spawn('node', [bridgePath, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
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
    setTimeout(() => spawnPanel(bridgePath, port), delay);
  });

  console.log(`[qoder-panel] spawned panel on port ${port} (PID: ${child.pid})`);
}

/** Qoder CN 扩展激活入口 */
export function activate(context: any): void {
  console.log('[qoder-panel] === activate START ===');
  console.log('[qoder-panel] context type:', typeof context);
  console.log('[qoder-panel] context keys:', context ? Object.keys(context) : 'null/undefined');
  
  if (!context) {
    console.error('[qoder-panel] ERROR: context is null/undefined');
    return;
  }
  
  const bridgePath = resolvePanelPath();
  console.log('[qoder-panel] bridge path:', bridgePath);

  (async () => {
    try {
      console.log('[qoder-panel] finding free port...');
      bridgePort = await findFreePort();
      console.log('[qoder-panel] got port:', bridgePort);
      
      console.log('[qoder-panel] spawning panel...');
      spawnPanel(bridgePath, bridgePort);

      console.log('[qoder-panel] starting state server...');
      const httpPort = await startStateServer();
      console.log('[qoder-panel] state server port:', httpPort);
      
      // 注册服务供 Browser 侧调用：官方形态为 context.api.node.registerService({ name, methods })
      const nodeApi = context?.api?.node;
      console.log('[qoder-panel] api.node.registerService:', typeof (nodeApi as any)?.registerService, '| legacy context.registerService:', typeof context?.registerService);
      if ((nodeApi as any)?.registerService) {
        (nodeApi as any).registerService({
          name: 'multi-agent-bridge',
          methods: {
            getPort: async () => ({ port: bridgePort }),
            getHttpPort: async () => ({ port: httpPort }),
            getState: async () => {
              const state = await fetchBridgeState(bridgePort);
              await writeStateToFile(state);
              return { state };
            },
            post: async (input: any) => {
              const p = typeof input?.path === 'string' ? input.path : '';
              if (!p.startsWith('/api/')) return { status: 400, data: { error: 'invalid path' } };
              return postToPanel(bridgePort, p, input?.body);
            },
          },
        });
        console.log('[qoder-panel] registered service multi-agent-bridge (official api)');
      } else if (typeof context?.registerService === 'function') {
        // 旧形态兜底
        context.registerService('bridge.getPort', () => bridgePort);
        context.registerService('bridge.getHttpPort', () => httpPort);
        context.registerService('bridge.getState', async () => {
          const state = await fetchBridgeState(bridgePort);
          await writeStateToFile(state);
          return state;
        });
        console.log('[qoder-panel] registered bridge services (legacy api)');
      } else {
        console.error('[qoder-panel] ERROR: no registerService API found');
      }

      // 启动定期状态同步（每 2 秒）
      console.log('[qoder-panel] starting periodic sync');
      setInterval(async () => {
        if (disposed || bridgePort === 0) return;
        try {
          const state = await fetchBridgeState(bridgePort);
          await writeStateToFile(state);
        } catch (err: any) {
          // 静默失败，避免日志刷屏
        }
      }, 2000);
      
      console.log('[qoder-panel] === activate COMPLETE ===');
    } catch (err: any) {
      console.error('[qoder-panel] activation failed:', err);
      console.error('[qoder-panel] error stack:', err.stack);
    }
  })();

  if (context?.subscriptions) {
    console.log('[qoder-panel] subscriptions array available');
    context.subscriptions.push({
      dispose() {
        console.log('[qoder-panel] dispose called');
        disposed = true;
        if (child && !child.killed) {
          console.log('[qoder-panel] shutting down panel process');
          child.kill();
        }
      },
    });
  } else {
    console.warn('[qoder-panel] WARNING: no subscriptions array');
  }
}

/** Qoder CN 扩展停用时调用 */
export function deactivate(): void {
  disposed = true;
  if (child && !child.killed) {
    child.kill();
  }
}
