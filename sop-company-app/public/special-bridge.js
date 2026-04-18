(function () {
  const REMOTE_ENDPOINT = '/api/special-board';
  const REMOTE_CHANGES_ENDPOINT = '/api/special-board/changes';
  const REMOTE_META_ENDPOINT = '/api/special-board/meta';
  const REMOTE_DEPT_ENDPOINT = '/api/special-board/dept';
  const REMOTE_STREAM_ENDPOINT = '/api/special-board/stream';
  const SESSION_ENDPOINT = '/api/session';
  const SPECIAL_BOARD_VERSION = '20260418-52';
  const SPECIAL_BOARD_CACHE_CLEANUP_KEY = 'special_board_cache_cleanup_v1';
  const POLL_INTERVAL_MS = 600;
  const AUTO_SAVE_DEBOUNCE_MS = 600;
  const REMOTE_FULL_FETCH_TIMEOUT_MS = 120000;
  const INITIAL_SYNC_FETCH_TIMEOUT_MS = 120000;
  const UNSYNCED_BACKUP_KEY = 'special_board_unsynced_backup_v1';
  const STREAM_RETRY_MIN_MS = 1200;
  const STREAM_RETRY_MAX_MS = 15000;

  let bridgeReady = false;
  let initialSyncDone = false;
  let lastSyncAt = '';
  let lastKnownRevision = 0;
  let syncStatusOverride = '';
  let localDirty = false;
  let saveInFlight = false;
  let pollInFlight = false;
  let pollTimer = null;
  let stream = null;
  let streamConnected = false;
  let streamRetryTimer = null;
  let streamRetryDelay = STREAM_RETRY_MIN_MS;
  let autoSaveTimer = null;
  let saveBtnEl = null;
  let baselineHash = '';
  let suppressDirtyWatch = false;
  let lastSaveErrorMessage = '';
  let supportsSpecialBoardChangesApi = true;
  let authRedirecting = false;
  let currentSessionUser = null;
  let deptRevisions = {};

  function isCurrentUserAdmin() {
    return currentSessionUser ? currentSessionUser.role === 'admin' : (window.__currentUser?.role === 'admin');
  }

  function getCurrentUserDept() {
    return currentSessionUser ? (currentSessionUser.department || '') : (window.__currentUser?.department || '');
  }

  function isImporting() {
    return window.__specialImporting === true;
  }

  function setLastSaveError(message) {
    lastSaveErrorMessage = String(message || '').trim();
    window.__specialSyncLastError = lastSaveErrorMessage;
  }

  function toast(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else {
      console.log('[special-bridge]', message);
    }
  }

  async function clearLegacyClientCachesForBoard() {
    try {
      if (localStorage.getItem(SPECIAL_BOARD_CACHE_CLEANUP_KEY) === '1') return;
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      localStorage.setItem(SPECIAL_BOARD_CACHE_CLEANUP_KEY, '1');
    } catch (_) {
      // ignore cache cleanup failure
    }
  }

  function buildSpecialBoardUrlWithCurrentVersion() {
    const url = new URL(window.location.href);
    url.searchParams.set('v', SPECIAL_BOARD_VERSION);
    return url.toString();
  }

  function enforceCurrentPageVersion() {
    const current = new URL(window.location.href).searchParams.get('v') || '';
    if (current === SPECIAL_BOARD_VERSION) return false;
    window.location.replace(buildSpecialBoardUrlWithCurrentVersion());
    return true;
  }

  function redirectToLogin() {
    if (authRedirecting) return;
    authRedirecting = true;
    const next = encodeURIComponent(buildSpecialBoardUrlWithCurrentVersion());
    window.location.replace(`/?next=${next}`);
  }

  async function ensureSessionReady() {
    const result = await fetchJson(SESSION_ENDPOINT, { method: 'GET' }, 8000);
    if (result.ok && result.data && result.data.user) {
      currentSessionUser = result.data.user;
      window.__currentUser = currentSessionUser;
      window.__specialSessionUser = currentSessionUser;
      if (currentSessionUser.role !== 'admin') {
        document.body.classList.add('non-admin');
      }
      return true;
    }
    setSyncStatus('未登录，正在跳转登录页');
    setLastSaveError('登录状态已失效，请重新登录');
    renderSyncMeta();
    redirectToLogin();
    return false;
  }

  function ensureAppleStyle() {
    if (document.getElementById('special-apple-style')) return;
    const style = document.createElement('style');
    style.id = 'special-apple-style';
    style.textContent = `
      :root {
        --apple-bg: #f5f6f9;
        --apple-card: rgba(255, 255, 255, 0.92);
        --apple-line: rgba(15, 23, 42, 0.12);
        --apple-text: #1d1d1f;
        --apple-muted: #6e6e73;
        --apple-accent: #0a84ff;
      }
      html, body {
        background: radial-gradient(circle at top left, rgba(10,132,255,.10), transparent 24%), #f5f6f9 !important;
        color: var(--apple-text) !important;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif !important;
      }
      button, input, select, textarea {
        border-radius: 12px !important;
      }
      button {
        border: 1px solid var(--apple-line) !important;
        background: rgba(255,255,255,.95) !important;
        color: var(--apple-text) !important;
        box-shadow: 0 6px 20px rgba(15, 23, 42, .06) !important;
        transition: all .16s ease !important;
      }
      button:hover {
        background: #fff !important;
        transform: translateY(-1px);
      }
      input, select, textarea {
        border: 1px solid var(--apple-line) !important;
        background: rgba(255,255,255,.95) !important;
        color: var(--apple-text) !important;
      }
      [class*="card"], [class*="panel"], [class*="modal"], [class*="sidebar"], [class*="toolbar"] {
        border: 1px solid var(--apple-line) !important;
        background: var(--apple-card) !important;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        box-shadow: 0 12px 32px rgba(15, 23, 42, .08) !important;
      }
      .sidebar {
        background: #ffffff !important;
        color: #0f172a !important;
        border-right: 1px solid rgba(15, 23, 42, .10) !important;
      }
      .sidebar-header {
        background: #ffffff !important;
        border-bottom: 1px solid rgba(15, 23, 42, .10) !important;
        color: #0f172a !important;
      }
      .sidebar-header * {
        color: #0f172a !important;
      }
      .nav-scroll {
        background: transparent !important;
      }
      .overview-btn {
        background: #ffffff !important;
        border: 1px solid rgba(15, 23, 42, .14) !important;
        color: #1e293b !important;
        box-shadow: 0 6px 14px rgba(15, 23, 42, .06) !important;
      }
      .overview-btn:hover {
        background: #f8fbff !important;
        color: #0f172a !important;
      }
      .overview-btn.active {
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
        border-color: rgba(37, 99, 235, .85) !important;
        color: #ffffff !important;
      }
      .nav-label {
        color: #475569 !important;
      }
      #deptNav .nav-item {
        background: #ffffff !important;
        border: 1px solid rgba(15, 23, 42, .14) !important;
        color: #1e293b !important;
      }
      #deptNav .nav-item:hover {
        background: #f8fbff !important;
        color: #0f172a !important;
      }
      #deptNav .nav-item.active {
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
        border-color: rgba(37, 99, 235, .85) !important;
        color: #ffffff !important;
      }
      #deptNav .nav-item > span:first-child,
      #deptNav .nav-item > span:first-child * {
        color: inherit !important;
      }
      .add-dept-btn {
        color: #334155 !important;
        border-color: rgba(15, 23, 42, .22) !important;
        background: #ffffff !important;
      }
      .add-dept-btn:hover {
        color: #0f172a !important;
        background: #f8fbff !important;
        border-color: rgba(59, 130, 246, .55) !important;
      }
      .org-chart li::before,
      .org-chart li::after,
      .org-chart ul::before,
      .org-chart li:last-child::before,
      .org-chart ul.vertical-stack li + li::after {
        border-color: #60a5fa !important;
      }
      .oc-node {
        color: #1e3a8a !important;
      }
      .special-sync-dock {
        position: fixed;
        right: 18px;
        top: 8px;
        z-index: 9999;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: 14px;
        border: 1px solid var(--apple-line);
        background: rgba(255,255,255,.92);
        box-shadow: 0 14px 32px rgba(15, 23, 42, .12);
        backdrop-filter: blur(14px);
      }
      .special-sync-btn {
        min-height: 36px;
        padding: 0 14px;
        border-radius: 10px !important;
        border: 1px solid rgba(10,132,255,.32) !important;
        color: #fff !important;
        background: linear-gradient(135deg, #0a84ff 0%, #0066cc 100%) !important;
        font-weight: 600;
        box-shadow: 0 12px 24px rgba(0, 102, 204, .22) !important;
      }
      .special-sync-meta {
        font-size: 12px;
        color: var(--apple-muted);
        white-space: nowrap;
      }
      @media (max-width: 900px) {
        .special-sync-dock {
          right: 10px;
          left: 10px;
          top: 6px;
          justify-content: space-between;
        }
        .special-sync-meta {
          font-size: 11px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function normalizeData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
      depts: Array.isArray(data.depts) ? data.depts : [],
      arch: Array.isArray(data.arch) ? data.arch : [],
      notes: data.notes && typeof data.notes === 'object' ? data.notes : { depts: '', modules: '', flows: '', sipoc: '', drafting: '', final: '', published: '' },
      plans: Array.isArray(data.plans) ? data.plans : [],
      deptOrg: data.deptOrg && typeof data.deptOrg === 'object' ? data.deptOrg : {},
    };
  }

  function hasAnyData(raw) {
    const data = normalizeData(raw);
    return Boolean(
      data.depts.length ||
      data.arch.length ||
      data.plans.length ||
      Object.keys(data.deptOrg || {}).length ||
      Object.values(data.notes || {}).some((v) => String(v || '').trim())
    );
  }

  function unwrapRemoteBoardData(remote) {
    if (!remote || typeof remote !== 'object') return null;

    if (
      Array.isArray(remote.depts) ||
      Array.isArray(remote.arch) ||
      (remote.notes && typeof remote.notes === 'object') ||
      (remote.deptOrg && typeof remote.deptOrg === 'object')
    ) {
      return remote;
    }

    const level1 = remote.data;
    if (!level1 || typeof level1 !== 'object') return null;
    if (
      Array.isArray(level1.depts) ||
      Array.isArray(level1.arch) ||
      (level1.notes && typeof level1.notes === 'object') ||
      (level1.deptOrg && typeof level1.deptOrg === 'object')
    ) {
      return level1;
    }

    const level2 = level1.data;
    if (!level2 || typeof level2 !== 'object') return null;
    if (
      Array.isArray(level2.depts) ||
      Array.isArray(level2.arch) ||
      (level2.notes && typeof level2.notes === 'object') ||
      (level2.deptOrg && typeof level2.deptOrg === 'object')
    ) {
      return level2;
    }

    return null;
  }

  function snapshot(app) {
    return {
      depts: Array.isArray(app.data?.depts) ? app.data.depts : [],
      arch: Array.isArray(app.data?.arch) ? app.data.arch : [],
      notes: app.data?.overviewNotes && typeof app.data.overviewNotes === 'object'
        ? app.data.overviewNotes
        : { depts: '', modules: '', flows: '', sipoc: '', drafting: '', final: '', published: '' },
      plans: Array.isArray(app.data?.plans) ? app.data.plans : [],
      deptOrg: app.data?.deptOrg && typeof app.data.deptOrg === 'object' ? app.data.deptOrg : {},
    };
  }

  function stableSerialize(data) {
    try {
      return JSON.stringify(data);
    } catch (_) {
      return '';
    }
  }

  function updateBaseline(app) {
    baselineHash = stableSerialize(snapshot(app));
    localDirty = false;
  }

  function evaluateDirty(app) {
    if (suppressDirtyWatch) return;
    const currentHash = stableSerialize(snapshot(app));
    if (!baselineHash) {
      baselineHash = currentHash;
      localDirty = false;
      return;
    }
    localDirty = currentHash !== baselineHash;
  }

  function refreshView(app) {
    if (app.currentDept && Array.isArray(app.data.depts) && !app.data.depts.includes(app.currentDept)) {
      app.currentDept = app.data.depts[0] || null;
    }
    if (!app.currentDept) app.currentDept = app.data.depts[0] || null;

    if (typeof app.renderNav === 'function') app.renderNav();
    if (typeof app._setupNavDelegation === 'function') app._setupNavDelegation();

    if (app.currentViewType === 'plan' && typeof app.renderPlanView === 'function') {
      app.renderPlanView();
      return;
    }
    if (app.currentViewType === 'overview' && isCurrentUserAdmin() && typeof app.showOverview === 'function') {
      app.showOverview();
      return;
    }
    if (app.currentDept && typeof app.selectDept === 'function') {
      app.selectDept(app.currentDept);
      return;
    }
    if (isCurrentUserAdmin() && typeof app.showOverview === 'function') app.showOverview();
  }

  function renderSyncMeta() {
    const meta = document.getElementById('specialSyncMeta');
    if (!meta) return;
    if (!initialSyncDone) {
      meta.textContent = '初始化同步中...';
      return;
    }
    if (syncStatusOverride) {
      meta.textContent = syncStatusOverride;
      return;
    }
    if (!lastSyncAt) {
      meta.textContent = lastKnownRevision > 0 ? `已同步 v${lastKnownRevision}` : '未同步';
      return;
    }
    const date = new Date(lastSyncAt);
    const when = Number.isNaN(date.getTime())
      ? '已同步'
      : `已同步 ${date.toLocaleString('zh-CN', { hour12: false })}`;
    meta.textContent = lastKnownRevision > 0 ? `${when} · v${lastKnownRevision}` : when;
  }

  function setSyncStatus(text) {
    syncStatusOverride = text || '';
    renderSyncMeta();
  }

  function markInitialSyncDone() {
    initialSyncDone = true;
    if (saveBtnEl) {
      saveBtnEl.disabled = false;
      if (saveBtnEl.dataset.loading !== '1') {
        saveBtnEl.textContent = '保存到服务器';
      }
    }
    renderSyncMeta();
  }

  function withTimeout(promise, timeoutMs, timeoutMessage) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(timeoutMessage || '操作超时')), timeoutMs);
      }),
    ]);
  }

  async function fetchJson(url, options, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
      });
      let data = {};
      try {
        data = await res.json();
      } catch (err) {
        return {
          ok: false,
          status: res.status,
          parseError: true,
          data: {
            error: 'Invalid JSON response',
            detail: (err && err.message) || 'JSON parse failed',
          },
        };
      }
      return { ok: res.ok, status: res.status, data, parseError: false };
    } finally {
      clearTimeout(timer);
    }
  }

  function backupUnsynced(app) {
    try {
      const data = snapshot(app);
      localStorage.setItem(
        UNSYNCED_BACKUP_KEY,
        JSON.stringify({
          at: new Date().toISOString(),
          revision: lastKnownRevision,
          data,
        })
      );
    } catch (_) {
      // ignore backup failure
    }
  }

  async function persistLocal(app, originalSave) {
    suppressDirtyWatch = true;
    try {
      await withTimeout(originalSave(), 8000, '本地缓存写入超时');
    } catch (_) {
      // local cache write failure should not block sync flow
    } finally {
      suppressDirtyWatch = false;
    }
    updateBaseline(app);
  }

  function applyRemoteSnapshot(app, remote, noticeText) {
    const boardData = unwrapRemoteBoardData(remote);
    if (!boardData) return false;

    const normalized = normalizeData(boardData);
    suppressDirtyWatch = true;
    try {
      app.data.depts = normalized.depts;
      app.data.arch = normalized.arch;
      app.data.overviewNotes = normalized.notes;
      app.data.plans = normalized.plans;
      app.data.deptOrg = normalized.deptOrg;
      refreshView(app);
    } finally {
      suppressDirtyWatch = false;
    }

    const revisionCandidate = Number(
      remote.revision || remote?.data?.revision || remote?.data?.data?.revision || 0
    );
    lastKnownRevision = Number.isFinite(revisionCandidate) ? revisionCandidate : 0;
    lastSyncAt = String(remote.updatedAt || remote?.data?.updatedAt || remote?.data?.data?.updatedAt || '');
    setSyncStatus('');
    updateBaseline(app);
    renderSyncMeta();

    if (noticeText) toast(noticeText);
    return true;
  }

  function setupDirtyWatch(app) {
    let timer = null;
    const scheduleCheck = () => {
      if (!initialSyncDone || suppressDirtyWatch || saveInFlight || isImporting()) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!initialSyncDone || isImporting()) return;
        evaluateDirty(app);
        scheduleAutoSave(app);
      }, 160);
    };

    ['input', 'change', 'keyup', 'paste'].forEach((evt) => {
      document.addEventListener(evt, scheduleCheck, true);
    });
    document.addEventListener('click', () => {
      setTimeout(() => {
        if (!initialSyncDone || isImporting()) return;
        evaluateDirty(app);
        scheduleAutoSave(app);
      }, 120);
    }, true);

    setInterval(() => {
      if (!initialSyncDone || isImporting()) return;
      evaluateDirty(app);
      scheduleAutoSave(app);
    }, 1500);
  }

  function ensureSaveDock() {
    // Dock removed: auto-save (600ms) + SSE push handle sync silently.
    // Errors surface via toast notifications.
  }

  async function syncFromServerLatest(
    app,
    originalSave,
    reason = '检测到他人更新，已自动刷新',
    fetchTimeoutMs = REMOTE_FULL_FETCH_TIMEOUT_MS,
    changedDept = null
  ) {
    if (isImporting()) return false;
    const hadDirty = localDirty;
    if (hadDirty) backupUnsynced(app);
    const noticeText = hadDirty ? `${reason}（本地草稿已自动备份）` : reason;

    if (changedDept) {
      const userDept = getCurrentUserDept();
      const isAdmin = isCurrentUserAdmin();
      if (!isAdmin && userDept && userDept !== changedDept) {
        return false;
      }

      const deptResult = await fetchDeptData(changedDept, fetchTimeoutMs);
      if (!deptResult.ok || !deptResult.data) {
        return await syncFromServerLatest(app, originalSave, reason, fetchTimeoutMs, null);
      }
      const d = deptResult.data;
      suppressDirtyWatch = true;
      try {
        if (Array.isArray(d.arch)) {
          app.data.arch = (app.data.arch || []).filter((m) => m.dept !== changedDept).concat(d.arch);
        }
        if (Array.isArray(d.plans)) {
          app.data.plans = (app.data.plans || []).filter((p) => p.dept !== changedDept).concat(d.plans);
        }
        if (d.deptOrg && typeof d.deptOrg === 'object') {
          Object.assign(app.data.deptOrg || (app.data.deptOrg = {}), d.deptOrg);
        }
        refreshView(app);
      } finally {
        suppressDirtyWatch = false;
      }
      deptRevisions[changedDept] = Number(d.deptRevision || 0);
      lastKnownRevision = Number(d.revision || d.deptRevision || lastKnownRevision + 1);
      lastSyncAt = String(d.updatedAt || new Date().toISOString());
      setSyncStatus('');
      updateBaseline(app);
      renderSyncMeta();
      if (noticeText) toast(noticeText);
      await persistLocal(app, originalSave);
      return true;
    }

    const fullResult = await fetchJson(REMOTE_ENDPOINT, { method: 'GET' }, fetchTimeoutMs);
    if (!fullResult.ok || !fullResult.data) return false;

    const applied = applyRemoteSnapshot(app, fullResult.data, noticeText);
    if (!applied) {
      setSyncStatus('服务器数据格式异常');
      setLastSaveError('服务器返回的数据格式异常，未应用到页面');
      renderSyncMeta();
      return false;
    }
    await persistLocal(app, originalSave);
    return true;
  }

  async function pollRemote(app, originalSave) {
    if (pollInFlight || saveInFlight || isImporting()) return;
    pollInFlight = true;
    try {
      if (supportsSpecialBoardChangesApi) {
        const changesUrl = `${REMOTE_CHANGES_ENDPOINT}?revision=${encodeURIComponent(
          Number.isFinite(lastKnownRevision) ? lastKnownRevision : 0
        )}&full=0`;
        const changesResult = await fetchJson(changesUrl, { method: 'GET' }, 10000);
        if (!changesResult.ok) {
          if (changesResult.status === 401 || changesResult.status === 403) {
            setSyncStatus('未登录，无法同步');
            setLastSaveError('登录状态已失效，请重新登录');
            redirectToLogin();
          }
          if (changesResult.status === 404) {
            supportsSpecialBoardChangesApi = false;
          }
          return;
        }

        const remoteRevision = Number(changesResult.data?.revision || 0);
        const hasChanged = changesResult.data?.changed === true;
        if (!Number.isFinite(remoteRevision) || remoteRevision <= lastKnownRevision || !hasChanged) return;

        const pollChangedDept = changesResult.data?.changedDept || null;
        await syncFromServerLatest(
          app,
          originalSave,
          localDirty
            ? '检测到他人更新，已自动刷新到最新版本（本地草稿已自动备份）'
            : '检测到他人更新，已自动刷新到最新版本',
          REMOTE_FULL_FETCH_TIMEOUT_MS,
          pollChangedDept
        );
        return;
      }

      const metaResult = await fetchJson(REMOTE_META_ENDPOINT, { method: 'GET' }, 8000);
      if (!metaResult.ok) {
        if (metaResult.status === 401 || metaResult.status === 403) {
          setSyncStatus('未登录，无法同步');
          setLastSaveError('登录状态已失效，请重新登录');
          redirectToLogin();
          return;
        }
        if (metaResult.status === 404) {
          setSyncStatus('服务器接口未就绪');
          setLastSaveError('服务器接口未识别，请确认 server.js 已更新');
        }
        return;
      }

      const remoteRevision = Number(metaResult.data?.revision || 0);
      if (!Number.isFinite(remoteRevision) || remoteRevision <= lastKnownRevision) return;
      await syncFromServerLatest(app, originalSave, '检测到他人更新，已自动刷新到最新版本');
    } catch (_) {
      // polling errors should stay silent to avoid noisy UI
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling(app, originalSave) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      pollRemote(app, originalSave);
    }, POLL_INTERVAL_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        pollRemote(app, originalSave);
      }
    });
  }

  function scheduleAutoSave(app) {
    if (!initialSyncDone || suppressDirtyWatch || saveInFlight || !localDirty || isImporting()) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      if (!initialSyncDone || suppressDirtyWatch || saveInFlight || !localDirty || isImporting()) return;
      await app.save({ auto: true, silentErrorToast: true });
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  function startRealtimeStream(app, originalSave) {
    if (typeof EventSource !== 'function') return;
    if (stream) {
      try {
        stream.close();
      } catch (_) {
        // ignore
      }
      stream = null;
    }

    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }

    stream = new EventSource(REMOTE_STREAM_ENDPOINT, { withCredentials: true });
    stream.addEventListener('open', () => {
      streamConnected = true;
      streamRetryDelay = STREAM_RETRY_MIN_MS;
    });

    const onRemoteSignal = async (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const revision = Number(payload.revision || 0);
        if (!Number.isFinite(revision) || revision <= lastKnownRevision || saveInFlight || isImporting()) return;
        const sseChangedDept = payload.changedDept || null;
        await syncFromServerLatest(app, originalSave, '检测到他人更新，已自动实时刷新', REMOTE_FULL_FETCH_TIMEOUT_MS, sseChangedDept);
      } catch (_) {
        // ignore malformed event
      }
    };

    stream.addEventListener('ready', onRemoteSignal);
    stream.addEventListener('update', onRemoteSignal);
    stream.onerror = () => {
      streamConnected = false;
      try {
        stream.close();
      } catch (_) {
        // ignore
      }
      stream = null;
      pollRemote(app, originalSave);
      if (!streamRetryTimer) {
        const delay = streamRetryDelay;
        streamRetryDelay = Math.min(STREAM_RETRY_MAX_MS, Math.floor(streamRetryDelay * 1.8));
        streamRetryTimer = setTimeout(() => {
          streamRetryTimer = null;
          startRealtimeStream(app, originalSave);
        }, delay);
      }
    };
  }

  function snapshotDept(app, deptName) {
    const orgVal = app.data?.deptOrg ? app.data.deptOrg[deptName] : undefined;
    return {
      arch: (app.data?.arch || []).filter((m) => m.dept === deptName),
      plans: (app.data?.plans || []).filter((p) => p.dept === deptName),
      deptOrg: orgVal != null ? { [deptName]: orgVal } : {},
    };
  }

  function getDeptHash(app, deptName) {
    try { return JSON.stringify(snapshotDept(app, deptName)); } catch (_) { return ''; }
  }

  function assembleBoardData(metaData, deptsDataMap) {
    const depts = Array.isArray(metaData.depts) ? metaData.depts : [];
    let arch = [], plans = [], deptOrg = {};
    for (const deptName of depts) {
      const d = deptsDataMap[deptName];
      if (!d) continue;
      arch = arch.concat(Array.isArray(d.arch) ? d.arch : []);
      plans = plans.concat(Array.isArray(d.plans) ? d.plans : []);
      if (d.deptOrg && typeof d.deptOrg === 'object') {
        Object.assign(deptOrg, d.deptOrg);
      }
    }
    return {
      revision: Number(metaData.revision || 0),
      updatedAt: String(metaData.updatedAt || ''),
      updatedBy: String(metaData.updatedBy || ''),
      data: { depts, arch, plans, deptOrg, notes: metaData.notes || {} },
    };
  }

  async function fetchDeptData(deptName, timeoutMs) {
    const result = await fetchJson(
      `${REMOTE_DEPT_ENDPOINT}/${encodeURIComponent(deptName)}`,
      { method: 'GET' },
      timeoutMs || 30000
    );
    if (result.ok && result.data) {
      deptRevisions[deptName] = Number(result.data.deptRevision || 0);
    }
    return result;
  }

  async function bootstrapBridge(app) {
    if (bridgeReady || !app) return;
    bridgeReady = true;

    ensureAppleStyle();
    ensureSaveDock(app);
    setupDirtyWatch(app);

    const originalSave = app.save.bind(app);

    async function gzipBytes(text) {
      const bytes = new TextEncoder().encode(text);
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const chunks = [];
      const reader = cs.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }

    async function buildSnapshotRequest(data, baseRevision) {
      const rawText = JSON.stringify({ data, baseRevision });
      if (rawText.length > 32768 && typeof CompressionStream === 'function') {
        try {
          const compressed = await gzipBytes(rawText);
          return {
            body: compressed,
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
          };
        } catch (_) {
          // fall through to uncompressed
        }
      }
      return {
        body: rawText,
        headers: { 'Content-Type': 'application/json' },
      };
    }

    async function postSnapshotToServer(data, baseRevision, timeoutMs = 20000) {
      const reqPayload = await buildSnapshotRequest(data, baseRevision);
      return fetchJson(
        REMOTE_ENDPOINT,
        {
          method: 'POST',
          headers: reqPayload.headers,
          body: reqPayload.body,
        },
        timeoutMs
      );
    }

    async function postDeptToServer(deptName, deptData, baseDeptRevision, timeoutMs = 20000) {
      const body = {
        arch: deptData.arch || [],
        plans: deptData.plans || [],
        deptOrg: deptData.deptOrg || {},
        baseDeptRevision: baseDeptRevision != null ? baseDeptRevision : undefined,
      };
      const rawText = JSON.stringify(body);
      let reqBody = rawText;
      let reqHeaders = { 'Content-Type': 'application/json' };
      if (rawText.length > 32768 && typeof CompressionStream === 'function') {
        try {
          const compressed = await gzipBytes(rawText);
          reqBody = compressed;
          reqHeaders = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' };
        } catch (_) {}
      }
      return fetchJson(
        `${REMOTE_DEPT_ENDPOINT}/${encodeURIComponent(deptName)}`,
        { method: 'POST', headers: reqHeaders, body: reqBody },
        timeoutMs
      );
    }

    app.save = async function patchedSave(options = {}) {
      if (!initialSyncDone && !options.manual && !options.force && !options.fromImport) return false;
      if (saveInFlight) {
        if (!options.manual && !options.force) return false;
        const waitStart = Date.now();
        const maxWaitMs = options.fromImport ? 45000 : 18000;
        while (saveInFlight && Date.now() - waitStart < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        if (saveInFlight) return false;
      }
      saveInFlight = true;
      setLastSaveError('');
      try {
        await originalSave();
        setSyncStatus('同步中...');
        const saveTimeoutMs = Number(options.timeoutMs || 20000);
        const allowConflictRetry = options.force || options.fromImport;
        const maxConflictRetries = allowConflictRetry ? 4 : 1;
        let saveResult = null;

        const userDept = getCurrentUserDept();
        const usePerDept = !isCurrentUserAdmin() && userDept;

        if (usePerDept) {
          // Non-admin: POST only their own dept file
          const deptData = snapshotDept(app, userDept);
          const baseDeptRev = deptRevisions[userDept] != null ? deptRevisions[userDept] : undefined;
          let conflictCount = 0;
          let currentBaseDeptRev = baseDeptRev;
          while (conflictCount <= maxConflictRetries) {
            saveResult = await postDeptToServer(userDept, deptData, currentBaseDeptRev, saveTimeoutMs);
            if (saveResult.status !== 409) break;
            conflictCount += 1;
            const newDeptRev = Number(saveResult.data?.currentDeptRevision);
            if (!Number.isFinite(newDeptRev)) break;
            currentBaseDeptRev = newDeptRev;
            const newGlobalRev = Number(saveResult.data?.currentRevision);
            if (Number.isFinite(newGlobalRev) && newGlobalRev > lastKnownRevision) lastKnownRevision = newGlobalRev;
            if (conflictCount > maxConflictRetries) break;
          }

          if (saveResult && saveResult.status === 409) {
            if (localDirty) backupUnsynced(app);
            try {
              const deptResult = await fetchDeptData(userDept, 15000);
              if (deptResult.ok && deptResult.data) {
                const d = deptResult.data;
                suppressDirtyWatch = true;
                try {
                  if (Array.isArray(d.arch)) {
                    app.data.arch = (app.data.arch || []).filter((m) => m.dept !== userDept).concat(d.arch);
                  }
                  if (Array.isArray(d.plans)) {
                    app.data.plans = (app.data.plans || []).filter((p) => p.dept !== userDept).concat(d.plans);
                  }
                  if (d.deptOrg) Object.assign(app.data.deptOrg || (app.data.deptOrg = {}), d.deptOrg);
                } finally { suppressDirtyWatch = false; }
                deptRevisions[userDept] = Number(d.deptRevision || 0);
              }
            } catch (_) {}
            setSyncStatus('');
            const msg = allowConflictRetry
              ? '多人正在同时编辑，自动重试后仍冲突，请稍后再保存'
              : '发现新版本，页面已刷新，请再次点击保存到服务器';
            setLastSaveError(msg);
            if (!options.silentErrorToast) toast(msg, 'error');
            return false;
          }

          if (!saveResult || !saveResult.ok) {
            let message = saveResult?.data?.error || '专项看板同步到服务器失败';
            if (saveResult?.status === 401 || saveResult?.status === 403) message = '登录状态已失效，请重新登录后再保存';
            setSyncStatus('同步失败');
            setLastSaveError(message);
            if (!options.silentErrorToast) toast(message, 'error');
            return false;
          }

          deptRevisions[userDept] = Number(saveResult.data?.deptRevision || (deptRevisions[userDept] || 0) + 1);
          lastKnownRevision = Number(saveResult.data?.revision || lastKnownRevision + 1);
          lastSyncAt = String(saveResult.data?.updatedAt || new Date().toISOString());
        } else {
          // Admin (or fallback): POST full snapshot
          const dataToSave = snapshot(app);
          let conflictCount = 0;
          while (conflictCount <= maxConflictRetries) {
            saveResult = await postSnapshotToServer(dataToSave, lastKnownRevision, saveTimeoutMs);
            if (saveResult.status !== 409) break;
            conflictCount += 1;
            const currentRevision = Number(saveResult.data?.currentRevision);
            if (!Number.isFinite(currentRevision) || currentRevision < 0) break;
            lastKnownRevision = currentRevision;
            if (conflictCount > maxConflictRetries) break;
          }

          if (saveResult && saveResult.status === 409) {
            if (localDirty) backupUnsynced(app);
            try {
              const metaOnConflict = await fetchJson(REMOTE_META_ENDPOINT, { method: 'GET' }, 8000);
              if (metaOnConflict.ok) {
                const rev = Number(metaOnConflict.data?.revision);
                if (Number.isFinite(rev) && rev > lastKnownRevision) {
                  lastKnownRevision = rev;
                  lastSyncAt = String(metaOnConflict.data?.updatedAt || '');
                }
              }
            } catch (_) {}
            const latestResult = await fetchJson(REMOTE_ENDPOINT, { method: 'GET' }, REMOTE_FULL_FETCH_TIMEOUT_MS);
            if (latestResult.ok && latestResult.data) {
              applyRemoteSnapshot(app, latestResult.data, '检测到他人更新，已自动刷新为最新版本');
              await persistLocal(app, originalSave);
            }
            setSyncStatus('');
            const msg = saveResult.data?.blockedEmptyOverwrite
              ? '已阻止空白数据覆盖服务器版本，页面已回滚到最新数据'
              : allowConflictRetry
                ? '多人正在同时编辑，自动重试后仍冲突，请稍后再保存'
                : '发现新版本，页面已刷新，请再次点击保存到服务器';
            setLastSaveError(msg);
            if (!options.silentErrorToast) toast(msg, 'error');
            return false;
          }

          if (!saveResult.ok) {
            let message = saveResult.data?.error || '专项看板同步到服务器失败';
            if (saveResult.status === 401 || saveResult.status === 403) message = '登录状态已失效，请重新登录后再保存';
            else if (saveResult.status === 404) message = '服务器未识别该接口，请确认已部署最新版 server.js 并重启服务';
            else if (saveResult.status === 413) message = '导入数据体积过大，服务器拒绝保存，请联系管理员调大限制';
            setSyncStatus('同步失败');
            setLastSaveError(message);
            if (!options.silentErrorToast) toast(message, 'error');
            return false;
          }

          lastKnownRevision = Number(saveResult.data?.revision || (lastKnownRevision + 1));
          lastSyncAt = String(saveResult.data?.updatedAt || new Date().toISOString());
        }

        setSyncStatus('');
        setLastSaveError('');
        updateBaseline(app);
        renderSyncMeta();

        if (options.manual) {
          toast('已保存到服务器');
        }
        return true;
      } catch (err) {
        // 保存请求超时或网络错误时，服务端可能已处理并推进了 revision；
        // 用轻量 meta 接口刷新 lastKnownRevision，避免下次保存因版本不匹配持续 409
        try {
          const metaOnError = await fetchJson(REMOTE_META_ENDPOINT, { method: 'GET' }, 5000);
          if (metaOnError.ok) {
            const rev = Number(metaOnError.data?.revision);
            if (Number.isFinite(rev) && rev > lastKnownRevision) {
              lastKnownRevision = rev;
              lastSyncAt = String(metaOnError.data?.updatedAt || '');
            }
          }
        } catch (_) {}
        setSyncStatus('同步失败');
        setLastSaveError((err && err.message) || '专项看板同步失败，请检查网络或登录状态');
        if (!options.silentErrorToast) {
          toast((err && err.message) || '专项看板同步失败，请检查网络或登录状态', 'error');
        }
        return false;
      } finally {
        saveInFlight = false;
      }
    };

    try {
      const metaResult = await fetchJson(REMOTE_META_ENDPOINT, { method: 'GET' }, 12000);
      if (!metaResult.ok) {
        if (metaResult.status === 401 || metaResult.status === 403) {
          setSyncStatus('未登录，无法同步');
          setLastSaveError('登录状态已失效，请重新登录');
          redirectToLogin();
        } else {
          setSyncStatus('服务器同步失败');
          setLastSaveError(metaResult.data?.error || '无法读取服务器数据');
        }
        updateBaseline(app);
      } else {
        const remoteRevision = Number(metaResult.data?.revision || 0);
        if (!Number.isFinite(remoteRevision) || remoteRevision <= 0) {
          lastKnownRevision = 0;
          lastSyncAt = String(metaResult.data?.updatedAt || '');
          setSyncStatus('服务器暂无数据');
          updateBaseline(app);
          await persistLocal(app, originalSave);
        } else if (metaResult.data?.perDept && Array.isArray(metaResult.data.depts)) {
          // Per-dept loading path: fetch each dept in parallel
          const allDepts = metaResult.data.depts;
          const userDept = getCurrentUserDept();
          const isAdmin = isCurrentUserAdmin();
          const deptsToFetch = isAdmin ? allDepts : allDepts.filter((d) => d === userDept);

          setSyncStatus('加载部门数据...');
          const deptResults = await Promise.all(
            deptsToFetch.map((deptName) =>
              fetchDeptData(deptName, INITIAL_SYNC_FETCH_TIMEOUT_MS)
                .then((r) => ({ deptName, result: r }))
            )
          );

          const deptsDataMap = {};
          for (const { deptName, result } of deptResults) {
            if (result.ok && result.data) {
              deptsDataMap[deptName] = result.data;
            }
          }

          const assembled = assembleBoardData(metaResult.data, deptsDataMap);
          const applied = applyRemoteSnapshot(app, assembled, '已加载服务器同步数据');
          if (applied) {
            await persistLocal(app, originalSave);
          } else {
            setSyncStatus('服务器数据格式异常');
            setLastSaveError('服务器返回的数据格式异常，未加载');
            updateBaseline(app);
          }
        } else {
          // Fallback: full fetch (postgres or old server)
          const fullResult = await fetchJson(REMOTE_ENDPOINT, { method: 'GET' }, INITIAL_SYNC_FETCH_TIMEOUT_MS);
          if (fullResult.ok && fullResult.data) {
            const applied = applyRemoteSnapshot(app, fullResult.data, '已加载服务器同步数据');
            if (applied) {
              await persistLocal(app, originalSave);
            } else {
              setSyncStatus('服务器数据格式异常');
              setLastSaveError('服务器返回的数据格式异常，未加载');
              updateBaseline(app);
            }
          } else {
            setSyncStatus('服务器同步失败');
            setLastSaveError(fullResult.data?.error || '无法读取服务器数据');
            updateBaseline(app);
          }
        }
      }
    } catch (err) {
      setSyncStatus('服务器同步失败');
      setLastSaveError((err && err.message) || '无法读取服务器数据');
      updateBaseline(app);
    } finally {
      markInitialSyncDone();
      // Silently migrate any legacy base64 PDFs to server file storage
      if (typeof app.migrateBase64Pdfs === 'function') {
        setTimeout(() => app.migrateBase64Pdfs().catch(() => {}), 2000);
      }
    }

    window.addEventListener('beforeunload', () => {
      if (!initialSyncDone || !localDirty || saveInFlight || isImporting()) return;
      try {
        const payload = JSON.stringify({ data: snapshot(app), baseRevision: lastKnownRevision });
        if (navigator.sendBeacon) {
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon(REMOTE_ENDPOINT, blob);
          return;
        }
        fetch(REMOTE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          credentials: 'include',
          keepalive: true,
        }).catch(() => {});
      } catch (_) {
        // ignore flush errors on close
      }
    });

    startRealtimeStream(app, originalSave);
    startPolling(app, originalSave);
  }

  function waitForApp() {
    if (window.app && typeof window.app.save === 'function') {
      const initPromise = window.__specialAppInitPromise;
      if (initPromise && typeof initPromise.then === 'function') {
        initPromise
          .catch(() => {})
          .then(() => {
            bootstrapBridge(window.app);
          });
        return;
      }
      bootstrapBridge(window.app);
      return;
    }
    setTimeout(waitForApp, 120);
  }

  async function startBridge() {
    await clearLegacyClientCachesForBoard();
    if (enforceCurrentPageVersion()) return;
    const sessionReady = await ensureSessionReady();
    if (!sessionReady) return;
    waitForApp();
  }

  startBridge();
})();
