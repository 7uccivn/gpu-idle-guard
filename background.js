// GPU Idle Guard — service worker
// Manages per-tab idle alarms. Content script reports "active GPU + last interaction"
// heartbeats; worker schedules a single alarm per tab and fires the alert when due.

const IDLE_MINUTES = 15;                    // idle threshold before alert
const HEARTBEAT_GRACE_MINUTES = 1;          // re-check cadence after first arm
const ALARM_PREFIX = "gpu-idle-guard:";

// In-memory map of tabId -> { lastInteraction: epochMs, gpuActive: bool }
// Kept in chrome.storage.session so it survives short worker suspensions.
async function getState() {
  const { tabState = {} } = await chrome.storage.session.get("tabState");
  return tabState;
}

async function setState(tabState) {
  await chrome.storage.session.set({ tabState });
}

function alarmNameFor(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

// Schedule (or reschedule) the alarm for a tab. We fire IDLE_MINUTES after the
// last reported interaction. If interaction is reported again, we overwrite.
async function scheduleAlarm(tabId, lastInteractionMs) {
  const fireAtMs = lastInteractionMs + IDLE_MINUTES * 60 * 1000;
  // Chrome MV3 alarms minimum is ~30s (0.5 min). Clamp to that floor, not 1 min,
  // so a freshly-armed alarm whose target is already in the past still fires soon.
  const MIN_DELAY_MIN = 0.5;
  const delayMin = Math.max((fireAtMs - Date.now()) / 60000, MIN_DELAY_MIN);
  await chrome.alarms.create(alarmNameFor(tabId), { delayInMinutes: delayMin });
}

async function clearAlarm(tabId) {
  await chrome.alarms.clear(alarmNameFor(tabId));
}

// Messages from content script:
//   { type: "gpu-status", gpuActive: bool, lastInteraction: epochMs }
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Stop-session from popup: forward to the tab's content script.
    if (msg?.type === "stop-session" && typeof msg.tabId === "number") {
      try {
        const res = await chrome.tabs.sendMessage(msg.tabId, { type: "stop-session" });
        sendResponse(res || { ok: false });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

    // Snooze from popup: push lastInteraction forward, reschedule alarm.
    if (msg?.type === "snooze" && typeof msg.tabId === "number") {
      const state = await getState();
      const entry = state[msg.tabId];
      if (entry && entry.gpuActive) {
        entry.lastInteraction = msg.lastInteraction;
        state[msg.tabId] = entry;
        await setState(state);
        await scheduleAlarm(msg.tabId, msg.lastInteraction);
      }
      sendResponse({ ok: true });
      return;
    }

    if (!sender.tab || msg?.type !== "gpu-status") return;
    const tabId = sender.tab.id;
    const state = await getState();

    if (msg.gpuActive) {
      const prev = state[tabId];
      const interactionChanged = !prev || prev.lastInteraction !== msg.lastInteraction;
      state[tabId] = {
        lastInteraction: msg.lastInteraction,
        gpuActive: true,
        quota: msg.quota || null
      };
      await setState(state);
      // Only (re)schedule when interaction timestamp moved, OR when no alarm exists yet.
      // Without this guard, every 30s heartbeat would re-arm the alarm to grace-min
      // from "now", pushing it past the idle threshold forever.
      const existing = await chrome.alarms.get(alarmNameFor(tabId));
      if (interactionChanged || !existing) {
        await scheduleAlarm(tabId, msg.lastInteraction);
      }
    } else {
      // GPU no longer active — cancel any pending alert.
      delete state[tabId];
      await setState(state);
      await clearAlarm(tabId);
    }
    sendResponse({ ok: true });
  })();
  return true; // async response
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = parseInt(alarm.name.slice(ALARM_PREFIX.length), 10);
  if (Number.isNaN(tabId)) return;

  const state = await getState();
  const entry = state[tabId];
  if (!entry || !entry.gpuActive) return;

  const idleMs = Date.now() - entry.lastInteraction;
  if (idleMs < IDLE_MINUTES * 60 * 1000) {
    // Interaction was reported between scheduling and firing — reschedule.
    await scheduleAlarm(tabId, entry.lastInteraction);
    return;
  }

  // Inject the alert into the tab.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__gpuIdleGuardShowAlert?.()
    });
  } catch (e) {
    // Tab may have been closed or navigated away — clean up.
    const s = await getState();
    delete s[tabId];
    await setState(s);
    await clearAlarm(tabId);
  }
});

// Clean up state when tabs close.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state[tabId]) {
    delete state[tabId];
    await setState(state);
  }
  await clearAlarm(tabId);
});
