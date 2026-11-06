import { describe, expect, it } from "vitest";

import {
  CHECKIN_HEARTBEAT_STALE_MS,
  checkinHealthLabel,
  formatCheckinHeartbeat,
  formatHeartbeatAgo,
  isCheckinHeartbeatStale,
} from "./checkin-health";
import type { CheckinHealth } from "./types";

const NOW = 1_700_000_000_000;

function health(patch: Partial<CheckinHealth> = {}): CheckinHealth {
  return {
    ts: NOW,
    last_status: "ok",
    had_errors: false,
    panicked: false,
    consecutive_panics: 0,
    file_exists: true,
    ...patch,
  };
}

describe("签到心跳展示", () => {
  it("相对时间覆盖刚刚 / 分钟 / 小时 / 天", () => {
    expect(formatHeartbeatAgo(NOW, NOW)).toBe("刚刚");
    expect(formatHeartbeatAgo(NOW - 30_000, NOW)).toBe("刚刚");
    expect(formatHeartbeatAgo(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(formatHeartbeatAgo(NOW - 59 * 60_000, NOW)).toBe("59 分钟前");
    expect(formatHeartbeatAgo(NOW - 3 * 60 * 60_000, NOW)).toBe("3 小时前");
    expect(formatHeartbeatAgo(NOW - 26 * 60 * 60_000, NOW)).toBe("1 天前");
    // 从未执行 / 时钟回拨都不抛错。
    expect(formatHeartbeatAgo(0, NOW)).toBe("从未执行");
    expect(formatHeartbeatAgo(NOW + 60_000, NOW)).toBe("刚刚");
  });

  it("状态文案覆盖各早退路径与 panic", () => {
    expect(checkinHealthLabel(health())).toBe("执行完成");
    expect(checkinHealthLabel(health({ had_errors: true }))).toBe("执行完成，有账号失败");
    expect(checkinHealthLabel(health({ last_status: "disabled" }))).toBe("未开启，已跳过");
    expect(checkinHealthLabel(health({ last_status: "no_accounts" }))).toBe(
      "无参与签到的账号，已跳过",
    );
    expect(checkinHealthLabel(health({ last_status: "before_checkin_time" }))).toBe(
      "未到签到时间段，已跳过",
    );
    expect(checkinHealthLabel(health({ last_status: "panic", panicked: true }))).toBe(
      "执行异常，已自动恢复",
    );
    expect(checkinHealthLabel(health({ last_status: "aborted" }))).toBe("任务被中断");
    expect(checkinHealthLabel(health({ last_status: "unknown" }))).toBe("暂无记录");
  });

  it("超过 2 小时未更新才算超时，从未执行不算", () => {
    expect(isCheckinHeartbeatStale(health(), NOW)).toBe(false);
    expect(
      isCheckinHeartbeatStale(health({ ts: NOW - CHECKIN_HEARTBEAT_STALE_MS }), NOW),
    ).toBe(false);
    expect(
      isCheckinHeartbeatStale(health({ ts: NOW - CHECKIN_HEARTBEAT_STALE_MS - 1 }), NOW),
    ).toBe(true);
    // ts === 0：刚装好还没跑过一轮，不报黄。
    expect(isCheckinHeartbeatStale(health({ ts: 0, last_status: "unknown" }), NOW)).toBe(false);
  });

  it("整行文案：未执行时只说尚未执行", () => {
    expect(formatCheckinHeartbeat(health({ ts: 0, last_status: "unknown" }), NOW)).toBe(
      "上一轮：尚未执行",
    );
    expect(formatCheckinHeartbeat(health({ ts: NOW - 5 * 60_000 }), NOW)).toBe(
      "上一轮：5 分钟前 · 执行完成",
    );
  });
});
