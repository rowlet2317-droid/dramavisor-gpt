"use client";

import { useEffect } from "react";

export const HYDRATION_READY_EVENT = "dramavisor:hydrated";

export function HydrationActionReplay() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
    document.dispatchEvent(new Event(HYDRATION_READY_EVENT));
  }, []);
  return null;
}

export const hydrationActionReplayScript = `(() => {
  let pendingButton = null;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target || target.disabled || target.dataset.nativeSubmit === "true"
      || document.documentElement.dataset.hydrated === "true") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingButton?.removeAttribute("data-awaiting-hydration");
    pendingButton = target;
    target.setAttribute("data-awaiting-hydration", "true");
  }, true);
  document.addEventListener("${HYDRATION_READY_EVENT}", () => {
    const target = pendingButton;
    pendingButton = null;
    target?.removeAttribute("data-awaiting-hydration");
    if (target?.isConnected) queueMicrotask(() => target.click());
  }, { once: true });
})();`;
