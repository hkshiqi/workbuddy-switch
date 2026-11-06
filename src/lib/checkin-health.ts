import type { CheckinHealth } from "./types";

/**
 * 自动签到循环心跳的展示逻辑。
 *
 * 心跳由后端每轮结束写入（含 `disabled` / `no_accounts` / `before_checkin_time`
 * 各早退路径与 panic 守护），前端只负责把它翻译成「上一轮：…」+ 需要用户
 * 介入的提示。
 */

/** 心跳超过这个时长没有更新，就提示后台循环可能已经停了（P2-6 的可观测性补丁）。 */
export const CHECKIN_HEARTBEAT_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * 连续多少轮 panic 就认为「不是偶发」并提示用户重启。
 *
 * 本仓所有锁都是 `.lock().unwrap()`：一旦某轮 panic 发生在持锁期间，Mutex 会
 * 中毒，之后**每一轮**都会在同一个位置 panic。单轮 panic 已被守护吞掉（可以
 * 当成偶发），连续 2 轮就几乎必然是中毒，只能重启进程。
 */
export const CHECKIN_PANIC_RESTART_THRESHOLD = 2;

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

/**
 * 心跳状态 → 中文文案（取值见 core `record_checkin_heartbeat` 的调用点）。
 *
 * panic 只说「已跳过本轮」：守护能保证循环继续，但**不保证**问题消失
 * （锁中毒时下一轮会再次 panic），所以不能写成「已自动恢复」这种承诺。
 */
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
      return "执行异常，已跳过本轮";
    case "aborted":
      return "任务被中断";
    default:
      return "暂无记录";
  }
}

/**
 * 连续异常提示：`consecutive_panics` 达到阈值时返回文案，否则 `null`。
 *
 * 这是 `consecutive_panics` 的唯一消费点——后端会累加/清零它，但只有在这里
 * 变成用户能看到的「请重启应用」，否则它只是一份没人读的计数。
 */
export function checkinPanicWarning(health: CheckinHealth): string | null {
  const rounds = Math.max(0, Math.trunc(health.consecutive_panics ?? 0));
  if (rounds < CHECKIN_PANIC_RESTART_THRESHOLD) return null;
  return `已连续 ${rounds} 轮异常，请重启应用`;
}

/**
 * 上一轮的失败原因（后端 panic 守护写入并截断到 300 字符）；空/缺失返回 `null`。
 *
 * 只做 trim：内容是 Rust 侧 `JoinError::to_string()` 的原文，前端不翻译、
 * 不裁剪语义，避免把用户反馈时需要的信息丢掉。
 */
export function checkinHeartbeatError(health: CheckinHealth): string | null {
  const reason = (health.last_error ?? "").trim();
  return reason.length > 0 ? reason : null;
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
