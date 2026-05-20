// GPU Idle Guard — content script
// Responsibilities:
//   1. Detect whether the page has an ACTIVE GPU session (DOM heuristics).
//   2. Track last user interaction (keydown / mousemove / scroll).
//   3. Report status to the background service worker on a regular cadence.
//   4. Expose window.__gpuIdleGuardShowAlert() so the worker can inject the modal.

(() => {
  if (window.__gpuIdleGuardInjected) return;
  window.__gpuIdleGuardInjected = true;

  const HEARTBEAT_MS = 30 * 1000;            // report status every 30s
  const HOST = location.hostname;
  const IS_COLAB = HOST.endsWith("colab.research.google.com");
  const IS_KAGGLE = HOST.endsWith("kaggle.com");

  let lastInteraction = Date.now();
  let lastReportedActive = null;

  // --- Idle tracking -------------------------------------------------------
  // Any of these events counts as "user is still here".
  const INTERACTION_EVENTS = ["keydown", "mousemove", "scroll", "click", "touchstart"];
  const onInteraction = () => { lastInteraction = Date.now(); };
  INTERACTION_EVENTS.forEach(ev =>
    window.addEventListener(ev, onInteraction, { passive: true, capture: true })
  );

  // --- GPU activity detection ---------------------------------------------
  // These selectors are the FRAGILE bit — Google/Kaggle change their UI often.
  // Update here if detection stops working.
  function isColabGpuActive() {
    // Colab shows a "RAM" + "Disk" resource meter at the top-right ONLY when a
    // runtime is connected. When disconnected you see a "Connect" button instead.
    // Selector targets the resource-display widget inside the connect button area.
    const meters = document.querySelector('colab-connect-button');
    if (!meters) return false;

    // The shadow DOM of <colab-connect-button> exposes a "connected" attribute
    // on its inner button when a runtime is active.
    const shadow = meters.shadowRoot;
    if (!shadow) return false;

    // Look for the resource usage element that only renders when connected.
    const resourceDisplay = shadow.querySelector(
      "#connect-icon, .resource-display, [aria-label*='RAM'], [aria-label*='connected']"
    );
    if (resourceDisplay) {
      const txt = (resourceDisplay.textContent || "").toLowerCase();
      // "ram" / "disk" labels appear only when connected.
      if (txt.includes("ram") || txt.includes("disk")) return true;
    }

    // Fallback: the top-bar text node sometimes reads "Connected to ...".
    const fallback = shadow.querySelector("#connect");
    if (fallback && /connected/i.test(fallback.textContent || "")) return true;

    return false;
  }

  function isKaggleGpuActive() {
    // Kaggle notebook editor = JupyterLab inside iframe-style postmate frame.
    // Stable class names are not available (styled-components hashes change).
    // Reliable markers found in the rendered page text:
    //   - "Session started." appears in console output when kernel is active.
    //   - "ACCELERATOR" label in the sidebar followed by "GPU T4 x2" / "GPU P100"
    //     / "TPU" indicates an accelerator is configured (not "None"/"CPU").
    // We require BOTH: session running AND accelerator is GPU/TPU.

    const text = document.body?.innerText || "";

    // Accelerator selection. The sidebar block reads like:
    //   "ACCELERATOR\nGPU T4 x2"  or  "ACCELERATOR\nTPU VM v3-8"
    // If the value is "None" or "CPU", we don't care about idleness.
    const acceleratorMatch = /ACCELERATOR\s*\n?\s*([^\n]+)/i.exec(text);
    if (!acceleratorMatch) return false;
    const accelerator = acceleratorMatch[1].toLowerCase();
    if (!/(gpu|tpu)/.test(accelerator)) return false;

    // Session must be running. "Session started." appears once the kernel boots.
    // Also accept "Running" indicator if Kaggle changes wording.
    if (/session started\.?/i.test(text)) return true;
    if (/\b(running|active)\b.*\b(gpu|tpu)\b/i.test(text)) return true;
    if (/\b(gpu|tpu)\b.*\b(running|active)\b/i.test(text)) return true;

    return false;
  }

  function isGpuActive() {
    try {
      if (IS_COLAB) return isColabGpuActive();
      if (IS_KAGGLE) return isKaggleGpuActive();
    } catch (e) {
      // DOM read failed — assume inactive so we don't false-alarm.
      return false;
    }
    return false;
  }

  // --- Quota scraping ------------------------------------------------------
  // Kaggle renders "Quota: HH:MM / NN hrs" in the Session options sidebar
  // when a GPU/TPU session is configured. We extract usage + cap.
  function getKaggleQuota() {
    const text = document.body?.innerText || "";
    const m = /Quota:\s*(\d+):(\d+)\s*\/\s*(\d+)\s*hrs?/i.exec(text);
    if (!m) return null;
    const usedMinutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const capMinutes = parseInt(m[3], 10) * 60;
    return { usedMinutes, capMinutes };
  }

  function getQuota() {
    try {
      if (IS_KAGGLE) return getKaggleQuota();
    } catch (_) { /* no-op */ }
    return null;        // Colab free tier: no public quota
  }

  // --- Session stop (called via background -> content script message) -----
  // Tries to click the platform's native "stop/disconnect" control.
  // Selector heuristics — update if UI shifts.
  function stopSession() {
    try {
      if (IS_KAGGLE) {
        // Kaggle: toolbar has a "Stop session" / "Stop running" button.
        // aria-label hooks are the most stable thing available.
        const candidates = document.querySelectorAll(
          '[aria-label*="Stop" i], [title*="Stop" i]'
        );
        for (const el of candidates) {
          const label = ((el.getAttribute("aria-label") || "") + " " +
                         (el.getAttribute("title") || "")).toLowerCase();
          if (/(stop session|stop running|stop kernel|shut down)/.test(label)) {
            el.click();
            return true;
          }
        }
        // Fallback: the kebab menu next to "Run All" contains a "Stop Session" item.
        // Best-effort text-based click.
        const items = document.querySelectorAll('[role="menuitem"], button, li');
        for (const el of items) {
          if (/stop session/i.test(el.textContent || "")) {
            el.click();
            return true;
          }
        }
      }
      if (IS_COLAB) {
        // Colab: open the connect-button menu, click "Disconnect and delete runtime".
        const connect = document.querySelector('colab-connect-button');
        const shadow = connect?.shadowRoot;
        if (shadow) {
          // Open dropdown if there is one.
          const moreBtn = shadow.querySelector(
            '#connect-dropdown, [aria-label*="more" i], [aria-label*="options" i]'
          );
          if (moreBtn) moreBtn.click();
        }
        // Search whole doc for the "Disconnect and delete runtime" item.
        const items = document.querySelectorAll(
          '[role="menuitem"], .goog-menuitem, paper-item, button'
        );
        for (const el of items) {
          const txt = (el.textContent || "").toLowerCase();
          if (/disconnect.*(delete|runtime)/.test(txt) || /manage sessions/i.test(txt) === false && /disconnect/.test(txt)) {
            el.click();
            return true;
          }
        }
      }
    } catch (_) { /* no-op */ }
    return false;
  }

  // --- Reporting to background --------------------------------------------
  let invalidated = false;
  let heartbeatId = null;
  let observer = null;

  function teardown() {
    invalidated = true;
    if (heartbeatId) clearInterval(heartbeatId);
    if (observer) observer.disconnect();
    INTERACTION_EVENTS.forEach(ev =>
      window.removeEventListener(ev, onInteraction, { capture: true })
    );
  }

  function contextValid() {
    // chrome.runtime.id is undefined once the extension context is invalidated
    // (e.g. after the extension was reloaded but the page wasn't).
    try {
      return !!(chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function report() {
    if (invalidated) return;
    if (!contextValid()) { teardown(); return; }

    const gpuActive = isGpuActive();
    const quota = gpuActive ? getQuota() : null;
    if (gpuActive || lastReportedActive !== gpuActive) {
      try {
        chrome.runtime.sendMessage({
          type: "gpu-status",
          gpuActive,
          lastInteraction,
          quota
        }).catch(() => { /* worker may be respawning */ });
      } catch (e) {
        // "Extension context invalidated" — stop trying.
        teardown();
        return;
      }
      lastReportedActive = gpuActive;
    }
  }

  // Listen for explicit commands from background (popup -> background -> here).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "stop-session") {
      const ok = stopSession();
      sendResponse({ ok });
      return true;
    }
  });

  // Initial report + interval. Also re-report whenever DOM mutates noticeably
  // (cheap MutationObserver throttled by the heartbeat).
  report();
  heartbeatId = setInterval(report, HEARTBEAT_MS);

  let mutationTimer = null;
  observer = new MutationObserver(() => {
    if (invalidated || mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      report();
    }, 5000);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });

  // --- Modal injection (called by background via executeScript) -----------
  window.__gpuIdleGuardShowAlert = () => {
    if (document.getElementById("gpu-idle-guard-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "gpu-idle-guard-modal";
    overlay.innerHTML = `
      <div class="gig-card" role="alertdialog" aria-modal="true" aria-labelledby="gig-title">
        <div class="gig-icon">⚠️</div>
        <h1 id="gig-title">Turn off your GPU!</h1>
        <p>Your GPU session has been idle. You may be burning free quota.</p>
        <div class="gig-actions">
          <button id="gig-dismiss" class="gig-btn gig-btn-primary">I'm still working</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(overlay);

    document.getElementById("gig-dismiss").addEventListener("click", () => {
      overlay.remove();
      // Treat dismiss as fresh interaction so alarm restarts cleanly.
      lastInteraction = Date.now();
      report();
    });

    // Optional alert sound. Bundled file `alert.mp3` must exist in the
    // extension root and be listed in web_accessible_resources.
    try {
      const audio = new Audio(chrome.runtime.getURL("alert.mp3"));
      audio.volume = 0.6;
      audio.play().catch(() => { /* autoplay may be blocked — silently ignore */ });
    } catch (_) { /* no-op */ }
  };
})();
