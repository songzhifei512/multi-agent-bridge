/**
 * 离线缓存模块 — bridge 状态的 localStorage 持久化
 *
 * 策略：
 * - 每次成功拉取状态后写入缓存（带时间戳）
 * - 启动时先读缓存渲染（秒开），再后台刷新
 * - 缓存超过 MAX_AGE_MS 视为过期，不再展示（避免误读陈旧数据）
 * - 写入失败（配额满）静默降级，不影响在线功能
 */

const CACHE_KEY = 'bridge-state-cache-v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小时

export interface CachedState {
  state: any;
  timestamp: number;
}

/** 保存状态到缓存；返回是否成功 */
export function saveState(state: any): boolean {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ state, timestamp: Date.now() } as CachedState),
    );
    return true;
  } catch (err) {
    console.warn('[stateCache] save failed:', err);
    return false;
  }
}

/** 读取缓存；不存在 / 解析失败 / 超龄则返回 null（并清理脏数据） */
export function loadState(): CachedState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedState;
    if (
      !parsed ||
      typeof parsed.timestamp !== 'number' ||
      parsed.state == null ||
      Date.now() - parsed.timestamp > MAX_AGE_MS
    ) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[stateCache] load failed, clearing:', err);
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    return null;
  }
}

/** 清除缓存（如用户主动要求断开并重置时） */
export function clearState(): void {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
