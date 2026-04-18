(function initSopPresence() {
  if (window.__sopPresenceInitialized) return;
  window.__sopPresenceInitialized = true;

  const HEARTBEAT_MS = 25000;
  const ACTIVITY_THROTTLE_MS = 15000;
  const UNAUTHORIZED_PAUSE_MS = 60000;

  let heartbeatTimer = null;
  let lastActivityAt = 0;
  let pauseUntil = 0;

  function now() {
    return Date.now();
  }

  async function postPresence(path) {
    if (now() < pauseUntil) return;

    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      });

      if (response.status === 401 || response.status === 403) {
        pauseUntil = now() + UNAUTHORIZED_PAUSE_MS;
        return;
      }

      if (response.ok) {
        pauseUntil = 0;
      }
    } catch (_) {
      // Ignore transient network errors.
    }
  }

  function sendHeartbeat() {
    postPresence('/api/session/heartbeat');
  }

  function markActivity() {
    const current = now();
    if (current - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityAt = current;
    postPresence('/api/session/activity');
  }

  function bindActivityEvents() {
    const events = ['pointerdown', 'keydown', 'input'];
    events.forEach((eventName) => {
      document.addEventListener(eventName, markActivity, { passive: true, capture: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat();
      }
    });

    window.addEventListener('focus', sendHeartbeat);
    window.addEventListener('beforeunload', () => {
      try {
        navigator.sendBeacon('/api/session/heartbeat', new Blob(['{}'], { type: 'application/json' }));
      } catch (_) {
      }
    });
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  }

  bindActivityEvents();
  startHeartbeat();
})();
