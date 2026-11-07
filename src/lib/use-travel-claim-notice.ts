import { toast } from "sonner";

import { useBackendEvent } from "@/lib/use-backend-event";

/** 后端 `travel-claim-finished` 事件负载（见 `tray::announce_travel_claim`）。 */
type TravelClaimFinished = { message?: string; claimed?: number; total?: number };

/**
 * 派猫猫旅行领到奖励时的应用内提示。
 *
 * 只有真领到东西后端才发这个事件：派发轮是当天的例行簿记，每天一份「已派出」的
 * 提示只会稀释真正有用的消息。
 */
export function useTravelClaimNotice() {
  useBackendEvent<TravelClaimFinished>("travel-claim-finished", (payload) => {
    const message = payload?.message?.trim();
    if (!message) return;
    toast.success("旅行奖励已领取", { description: message });
  });
}
