// React hooks for the Ink TUI layer.
//
// - useAppStore: 细粒度订阅 vanilla zustand store 的某个切片（避免整树重渲染）。
// - useClock: 周期性 tickClock（驱动时长/动画帧刷新），只影响订阅 clock 的组件。
//
// 设计依据：docs/tui-ink-design.md §4.2.9 / §7.2。

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { AppStore, AppStoreApi } from './store';

/** 细粒度订阅 store 切片。等价于 zustand 的 useStore(api, selector)。 */
export function useAppStore<T>(api: AppStoreApi, selector: (s: AppStore) => T): T {
  return useStore(api, selector);
}

/**
 * 周期性节拍：每 intervalMs 调一次 store.tickClock()。
 * 用于状态栏时长刷新与 footer 动画帧推进。
 */
export function useClock(api: AppStoreApi, intervalMs = 1000): void {
  useEffect(() => {
    const tick = api.getState().tickClock;
    const timer = setInterval(() => tick(), intervalMs);
    return () => clearInterval(timer);
  }, [api, intervalMs]);
}
