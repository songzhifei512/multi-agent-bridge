import React from 'react';
import BridgeConsoleTab from './index';

export const name = 'dsh-bridge-panel';

// Hard inject is only `slots`. sidebarRightTabs is optional-by-contract (dsh
// 0.1.5+) and picked up via a deferred ctx.inject below, mirroring dsh-context.
export const inject = ['slots'];

const TAB_ID = 'dsh-bridge-panel';
const TAB_KIND = 'dsh-bridge-panel';
const GUIDE_ORDER = 30;

function MultiAgentIcon() {
  return React.createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
    React.createElement('path', { d: 'M12 2L2 7l10 5 10-5-10-5z' }),
    React.createElement('path', { d: 'M2 17l10 5 10-5' }),
    React.createElement('path', { d: 'M2 12l10 5 10-5' }),
  );
}

export function apply(ctx: any) {
  ctx.effect(() => {
    const handle = ctx.inject(['sidebarRightTabs'], (i: any) => {
      const disposers: Array<() => void> = [];
      const own = (r: any) => {
        if (typeof r === 'function') disposers.push(r);
      };

      try {
        const tabs = i.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== 'function') return;

        // Phase 1: register the tab type. The `guide` entry is what surfaces
        // the tab in the sidebar's add/guide menu — no openTab call needed.
        own(
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => 'Multi-Agent',
            guide: [
              {
                order: GUIDE_ORDER,
                title: () => 'Multi-Agent',
                description: () => '多智能体协作控制台：任务、Worker 状态与派发',
                icon: MultiAgentIcon,
              },
            ],
          }),
        );

        // Phase 2: register the tab body under the sidebar.right.pane.tab slot.
        own(
          i.slots.inject('sidebar.right.pane.tab', () =>
            i.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              (props: any) => React.createElement(BridgeConsoleTab, props),
            ),
          ),
        );
      } catch (err) {
        console.error('[dsh-bridge-panel] tab registration failed:', err);
        for (const d of disposers) d();
        return;
      }

      return () => {
        for (const d of disposers) d();
      };
    });

    return () => {
      handle?.dispose?.();
    };
  }, 'dsh-bridge-panel: sidebar tab');
}
