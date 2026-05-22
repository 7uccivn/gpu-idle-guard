// GPU Idle Guard — toolbar popup
// Queries the active tab's state from chrome.storage.session and the pending alarm.
// Updates once per second while open. "Snooze" pushes lastInteraction forward by
// 15 minutes so the alert won't fire for that window.

const SNOOZE_MINUTES = 15;
const ALARM_PREFIX = "gpu-idle-guard:";

const $gpu = document.getElementById("gpu-status");
const $idle = document.getElementById("idle-time");
const $fires = document.getElementById("fires-in");
const $quota = document.getElementById("quota");
const $btn = document.getElementById("snooze");
const $stop = document.getElementById("stop");
const $hint = document.getElementById("hint");

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await getActiveTab();
  if (!tab) return;

  const url = tab.url || "";
  const onTarget = /^https:\/\/(colab\.research\.google\.com|www\.kaggle\.com\/code)/.test(url);
  if (!onTarget) {
    $gpu.textContent = "—";
    $gpu.className = "value off";
    $idle.textContent = "—";
    $fires.textContent = "—";
    $quota.textContent = "—";
    $btn.disabled = true;
    $stop.disabled = true;
    $hint.classList.remove("ok");
    return;
  }
  $hint.classList.add("ok");

  const { tabState = {} } = await chrome.storage.session.get("tabState");
  const entry = tabState[tab.id];
  const alarm = await chrome.alarms.get(ALARM_PREFIX + tab.id);

  if (!entry || !entry.gpuActive) {
    $gpu.textContent = "no";
    $gpu.className = "value off";
    $idle.textContent = "—";
    $fires.textContent = "—";
    $quota.textContent = "—";
    $btn.disabled = true;
    $stop.disabled = true;
    return;
  }

  $gpu.textContent = "yes";
  $gpu.className = "value on";
  $idle.textContent = fmtDuration(Date.now() - entry.lastInteraction);
  $fires.textContent = alarm
    ? fmtDuration(alarm.scheduledTime - Date.now())
    : "—";

  if (entry.quota) {
    const { usedMinutes, capMinutes } = entry.quota;
    const leftMin = Math.max(capMinutes - usedMinutes, 0);
    const leftH = Math.floor(leftMin / 60);
    const leftM = leftMin % 60;
    $quota.textContent = `${leftH}h ${leftM}m left`;
  } else {
    $quota.textContent = "n/a";
  }

  $btn.disabled = false;
  $stop.disabled = false;
}

$btn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  // Push the "lastInteraction" forward so the alarm fires AFTER the snooze window.
  // Equivalent to pretending the user is active SNOOZE_MINUTES into the future.
  const pseudoInteraction = Date.now() + SNOOZE_MINUTES * 60 * 1000;
  await chrome.runtime.sendMessage({
    type: "snooze",
    tabId: tab.id,
    lastInteraction: pseudoInteraction
  });
  refresh();
});

$stop.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  if (!confirm("Stop the GPU session on this tab? Unsaved kernel state will be lost.")) return;
  $stop.disabled = true;
  $stop.textContent = "Stopping…";
  const res = await chrome.runtime.sendMessage({
    type: "stop-session",
    tabId: tab.id
  });
  if (!res?.ok) {
    $stop.textContent = "Couldn't stop — click manually";
    setTimeout(() => { $stop.textContent = "Stop session"; refresh(); }, 2500);
  } else {
    $stop.textContent = "Stop sent";
    setTimeout(() => { $stop.textContent = "Stop session"; refresh(); }, 1500);
  }
});

refresh();
setInterval(refresh, 1000);
