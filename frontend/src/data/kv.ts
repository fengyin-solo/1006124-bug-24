/**
 * 最底层的 localStorage 原子读写：每个 key 独立写入，写失败时浏览器自身不会产生半截值。
 * 跨 key 的「整笔退回」由 local-store 的事务负责，领域层不要直接改这里的值。
 */

export const ENTRIES_KEY = 'shield-tunnel-construction:entries'
export const SHIELD_ARCHIVE_KEY = 'shield-tunnel-construction:shield-archive'
// 数据层结构版本：旧版（直接把盾构机记在通用台账里）读到 v1 时，需要整体迁入设备档案。
export const SHIELD_ARCHIVE_VERSION = 2

export function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }
  return JSON.parse(raw) as T
}

export function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先序列化再一次性落盘：序列化抛错时根本不会碰 storage，不会留下半包数据。
  window.localStorage.setItem(key, JSON.stringify(value))
}
