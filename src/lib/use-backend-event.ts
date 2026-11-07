import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import * as api from "@/lib/api";

/**
 * 订阅一个后端事件，组件卸载时自动退订。
 *
 * webui（浏览器打开）没有 Tauri 事件通道，直接不订阅——那种形态下结果由各接口的
 * 返回值承载。`handler` 存进 ref：调用方不必为它套 `useCallback`，事件名不变就不会
 * 重复订阅。
 */
export function useBackendEvent<T>(name: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (api.isWebui()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<T>(name, (event) => {
      handlerRef.current(event.payload);
    }).then((fn) => {
      // StrictMode 开发态会「挂载 → 卸载 → 再挂载」：`listen` 的 Promise 在清理之后才
      // resolve，不补这一步就会残留一个监听，同一事件弹两条 toast。
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [name]);
}
