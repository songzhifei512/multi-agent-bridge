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
    
    // TODO: 实现 proxy 注册和子进程管理（Task 3）
    console.log(`[dsh-bridge-panel] initialized on port ${panelPort}`);
  },
};

export default plugin;
