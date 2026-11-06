import type { CheckinHealth } from "./types";

/**
 * 自动签到循环心跳的展示逻辑。
 *
 * 心跳由后端每轮结束写入（含 `disabled` / `no_accounts` / `before_checkin_time`
 * 各早退路径与 panic 守护），前端只负责把它翻译成一行「上一轮：…」。
 */

/** 心跳超过这个时长没有更新，就提示后台循环可能已经停了（P2-6 的可观测性补丁）。 */
export const CHECKIN_HEARTBEAT_STALE_MS = 2 * 60 * 60 * 1000;

/** 心跳时间戳 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」；0 表示从未执行过。 */
export function formatHeartbeatAgo(ts: number, now: number): string {
  if (!ts) return "从未执行";
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 心跳状态 → 中文文案（取值见 core `record_checkin_heartbeat` 的调用点）。 */
export function checkinHealthLabel(health: CheckinHealth): string {
  switch (health.last_status) {
    case "ok":
      return health.had_errors ? "执行完成，有账号失败" : "执行完成";
    case "disabled":
      return "未开启，已跳过";
    case "no_accounts":
      return "无参与签到的账号，已跳过";
    case "before_checkin_time":
      return "未到签到时间段，已跳过";
    case "panic":
      return "执行异常，已自动恢复";
    case "aborted":
      return "任务被中断";
    default:
      return "暂无记录";
  }
}

/**
 * 心跳是否已经「超时未更新」。
 *
 * `ts === 0`（从未执行）不算超时：刚装好还没跑过一轮时不该报黄。
 */
export function isCheckinHeartbeatStale(health: CheckinHealth, now: number): boolean {
  return health.ts > 0 && now - health.ts > CHECKIN_HEARTBEAT_STALE_MS;
}

/** 设置页「上一轮」整行文案。 */
export function formatCheckinHeartbeat(health: CheckinHealth, now: number): string {
  if (health.ts <= 0) return "上一轮：尚未执行";
  return `上一轮：${formatHeartbeatAgo(health.ts, now)} · ${checkinHealthLabel(health)}`;
}
