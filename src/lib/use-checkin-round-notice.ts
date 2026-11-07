import { toast } from "sonner";

import { useBackendEvent } from "@/lib/use-backend-event";

/** 后端 `checkin-round-finished` 事件负载（见 `tray::announce_checkin_round`）。 */
type CheckinRoundFinished = {
  message?: string;
  /** `null` = 稳态轮次（当天已签过 / 未到点 / 未启用），刻意不打扰用户。 */
  level?: "success" | "error" | null;
  signed?: number;
  already?: number;
  failed?: number;
  status?: string | null;
};

/**
 * 后台自动签到一轮结束时的应用内提示。
 *
 * 后台轮次在用户没看窗口时也会跑，此前它的结果只有一个出口：设置页里的心跳。
 * 也就是说「今天到底签上了没有」必须主动去翻才知道。这里把两种值得打扰的情况推到
 * 窗口里——刚签上、刚开始出错；稳态轮次（全是「已签」）不弹，否则每天几十条。
 *
 * 窗口没开时由后端另发一份系统通知，与此互不替代：系统通知在开发态会被登记到
 * 「终端」名下，投递失败也无法从插件观测，所以两者都发、以应用内为准。
 */
export function useCheckinRoundNotice() {
  useBackendEvent<CheckinRoundFinished>("checkin-round-finished", (payload) => {
    const message = payload?.message?.trim();
    if (!message || !payload?.level) return;
    if (payload.level === "error") {
      toast.error("自动签到失败", { description: message, duration: 10_000 });
    } else {
      toast.success("自动签到完成", { description: message });
    }
  });
}
