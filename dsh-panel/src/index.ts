import { Plugin } from '@cordis/types';
import path from 'path';
import { spawn } from 'child_process';

export interface PanelConfig {
  port?: number;
  autoStart?: boolean;
}

const plugin: Plugin = {
  name: 'dsh-bridge-panel',
  
  inject: {
    'sidebar.right.pane.tab': {
      component: './client/index.tsx',
      label: 'Multi-Agent',
      icon: 'layers',
    }
  },
  
  config: {
    port: { type: 'number', default: 3000 },
    autoStart: { type: 'boolean', default: true },
  },
  
  async apply(ctx, config: PanelConfig) {
    const panelPort = config.port || 3000;
    const panelUrl = `http://localhost:${panelPort}`;
    
    // 1. 注册 same-origin proxy
    ctx.webServer.registerProxy('/api', {
      target: panelUrl,
      changeOrigin: true,
    });
    
    ctx.webServer.registerProxy('/events', {
      target: panelUrl,
      changeOrigin: true,
    });
    
    console.log(`[dsh-bridge-panel] proxy registered: /api, /events → ${panelUrl}`);
    
    // 2. 可选：自动启动 bridge-web-panel 子进程
    if (config.autoStart) {
      const bridgePanelPath = path.join(__dirname, '../../bridge/mcp/bridge-web-panel.mjs');
      const panelProcess = spawn('node', [bridgePanelPath, '--port', String(panelPort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      panelProcess.stdout.on('data', (data) => {
        console.log(`[bridge-panel] ${data.toString().trim()}`);
      });
      
      panelProcess.stderr.on('data', (data) => {
        console.error(`[bridge-panel ERROR] ${data.toString().trim()}`);
      });
      
      panelProcess.on('exit', (code) => {
        console.log(`[bridge-panel] exited with code ${code}`);
      });
      
      // 清理钩子
      ctx.onShutdown(() => {
        console.log('[dsh-bridge-panel] shutting down panel process');
        panelProcess.kill();
      });
      
      console.log(`[dsh-bridge-panel] spawned panel process (PID: ${panelProcess.pid})`);
    }
  },
};

export default plugin;
