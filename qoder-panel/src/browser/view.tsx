import React from 'react';
import { createRoot } from 'react-dom/client';
import BridgeConsole from './BridgeConsole';

// Qoder CN 扩展视图入口
// globalThis.qoderPluginView 由 Qoder CN Electron 主进程注入
declare const globalThis: {
  qoderPluginView?: {
    register(descriptor: {
      mount(container: HTMLElement, context: { api: any }): { dispose(): void };
    }): void;
  };
} & typeof global;

if (globalThis.qoderPluginView) {
  globalThis.qoderPluginView.register({
    mount(container, context) {
      const root = createRoot(container);
      root.render(React.createElement(BridgeConsole, { api: context.api }));
      return {
        dispose() {
          root.unmount();
        },
      };
    },
  });
}
