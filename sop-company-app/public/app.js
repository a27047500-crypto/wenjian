let toastTimer = null;
let currentSession = null;
let documentsCache = [];
let usersCache = [];
let onlineSessionsCache = null;
let onlineSessionsTimer = null;
let aiAdminConfigCache = null;
let aiAuditCache = [];

const CACHE_CLEANUP_KEY = "sop_client_cache_cleanup_v3";
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message) {
  const toast = $("toast");
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function roleLabel(role) {
  if (role === "admin") return "管理员";
  if (role === "viewer") return "只读用户";
  return "编辑用户";
}

function specialBoardAccessLabel(access, role) {
  if (role === "admin") return "文件专项：全量可见（管理员）";
  return access === "all" ? "文件专项：全量可见" : "文件专项：仅本部门";
}

function scopeLabel(level) {
  if (level === "company") return "公司共享";
  if (level === "team") return "部门共享";
  return "私有";
}

function statusLabel(status) {
  if (status === "submitted") return "待审核";
  if (status === "returned") return "已退回";
  if (status === "approved") return "已批准";
  return "草稿";
}

function statusBadgeClass(status) {
  if (status === "submitted") return "orange";
  if (status === "returned") return "red";
  if (status === "approved") return "green";
  return "gray";
}

function historyActionLabel(action) {
  if (action === "submit") return "提交审核";
  if (action === "approve") return "审核通过";
  if (action === "return") return "退回修改";
  return "保存版本";
}

function openLogin() {
  $("loginOverlay").classList.add("open");
  $("usernameInput").focus();
}

function closeLogin() {
  $("loginOverlay").classList.remove("open");
}

function openHistoryModal() {
  $("historyOverlay").classList.add("open");
}

function closeHistoryModal() {
  $("historyOverlay").classList.remove("open");
}

function openTemplateModal() {
  const overlay = $("templateOverlay");
  if (!overlay) {
    window.open(`/editor.html?v=${Date.now()}`, "_blank", "noopener");
    return;
  }
  overlay.classList.add("open");
}

function closeTemplateModal() {
  const overlay = $("templateOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
}

function openEditorByTemplate(templateKey) {
  const raw = String(templateKey || "standard-sipoc").trim().toLowerCase();
  const mapping = {
    default: "standard-sipoc",
    procurement: "standard-sipoc",
    quality: "standard-sipoc",
    "standard-sipoc": "standard-sipoc",
    "core-fixed": "core-fixed",
    "fully-flexible": "fully-flexible",
  };
  const key = mapping[raw] || "standard-sipoc";
  closeTemplateModal();
  window.open(`/editor.html?template=${encodeURIComponent(key)}&v=${Date.now()}`, "_blank", "noopener");
}

function openHistoryVersionInEditor(id, file) {
  const docId = String(id || "").trim();
  const historyFile = String(file || "").trim();
  if (!docId || !historyFile) return;
  window.open(
    `/editor.html?doc=${encodeURIComponent(docId)}&historyFile=${encodeURIComponent(historyFile)}&v=${Date.now()}`,
    "_blank",
    "noopener"
  );
}

async function clearLegacyCaches() {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (_) {
  }
}

async function ensureLegacyCachesClearedOnce() {
  try {
    if (localStorage.getItem(CACHE_CLEANUP_KEY) === "1") return;
    await clearLegacyCaches();
    localStorage.setItem(CACHE_CLEANUP_KEY, "1");
  } catch (_) {
  }
}

async function resetClientCacheIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("reset_cache")) return false;

  await clearLegacyCaches();
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("reset_cache");
  cleanUrl.searchParams.set("v", String(Date.now()));
  window.location.replace(cleanUrl.toString());
  return true;
}

function setLoggedInState() {
  const loggedIn = !!currentSession;
  $("openLoginBtn").hidden = loggedIn;
  $("logoutBtn").hidden = !loggedIn;
  $("newDocBtn").hidden = !loggedIn;
}

function getDepartmentFilterValue() {
  const select = $("departmentFilter");
  return select ? select.value : "all";
}

function getAvailableDepartments() {
  const set = new Set();
  usersCache.forEach((user) => {
    if (user && user.department) set.add(String(user.department).trim());
  });
  documentsCache.forEach((item) => {
    if (item && item.department) set.add(String(item.department).trim());
  });
  if (currentSession && currentSession.department) set.add(String(currentSession.department).trim());
  return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function syncDepartmentFilterOptions() {
  const select = $("departmentFilter");
  if (!select) return;
  const previous = select.value || "all";
  const departments = getAvailableDepartments();
  const isAdmin = !!currentSession && currentSession.role === "admin";

  const options = ['<option value="all">全部部门</option>'];
  departments.forEach((department) => {
    options.push(`<option value="${escapeHtml(department)}">${escapeHtml(department)}</option>`);
  });
  select.innerHTML = options.join("");
  select.disabled = !isAdmin;
  select.title = isAdmin ? "按部门筛选文档工作台" : "仅管理员可按部门筛选";

  if (isAdmin && departments.includes(previous)) {
    select.value = previous;
  } else {
    select.value = "all";
  }
}

function renderHero() {
  const heroText = $("heroText");
  if (!currentSession) {
    heroText.textContent = "16 个部门统一在系统内起草、提交和跟踪流程文件，管理员集中审核。";
    return;
  }

  if (currentSession.role === "admin") {
    heroText.textContent = "当前为管理员视角，可集中查看待审核文件、退回修改或审核通过。";
    return;
  }

  heroText.textContent = `${currentSession.department || "所属部门"} 当前已登录，可新建文件、保存并提交管理员审核。`;
}

function renderAccountCard() {
  const accountCard = $("accountCard");
  const sessionArea = $("sessionArea");
  const reviewPanel = $("reviewPanel");
  const adminUsersCard = $("adminUsersCard");
  const adminOnlineCard = $("adminOnlineCard");
  const adminAiCard = $("adminAiCard");

  if (!currentSession) {
    accountCard.innerHTML = "<strong>未登录</strong><p>请先登录后访问文档库和审核功能。</p>";
    sessionArea.innerHTML = '<div class="empty">登录后可查看个人工作区。</div>';
    reviewPanel.hidden = true;
    adminUsersCard.hidden = true;
    if (adminOnlineCard) adminOnlineCard.hidden = true;
    if (adminAiCard) adminAiCard.hidden = true;
    return;
  }

  accountCard.innerHTML = `
    <strong>${escapeHtml(currentSession.displayName)}</strong>
    <p>${escapeHtml(currentSession.username)} · ${escapeHtml(roleLabel(currentSession.role))}</p>
    <p>${escapeHtml(currentSession.department || "未分配部门")}</p>
  `;

  sessionArea.innerHTML = `
    <div class="session-card">
      <div class="list-card">
        <strong>当前身份</strong>
        <p>${escapeHtml(currentSession.displayName)}</p>
        <p>${escapeHtml(currentSession.department || "未分配部门")}</p>
        <p>${escapeHtml(roleLabel(currentSession.role))}</p>
      </div>
      <div class="session-actions">
        <button class="btn" type="button" data-open-template="1">新建文件</button>
      </div>
    </div>
  `;

  reviewPanel.hidden = currentSession.role !== "admin";
  adminUsersCard.hidden = currentSession.role !== "admin";
  if (adminOnlineCard) adminOnlineCard.hidden = currentSession.role !== "admin";
  if (adminAiCard) adminAiCard.hidden = currentSession.role !== "admin";
}

function updateStats() {
  const items = currentSession ? getFilteredDocuments() : [];
  $("docCount").textContent = String(items.length);
  $("editCount").textContent = String(items.filter((item) => item.canEdit).length);
  $("pendingCount").textContent = String(items.filter((item) => item.workflow?.status === "submitted").length);
  $("approvedCount").textContent = String(items.filter((item) => item.workflow?.status === "approved").length);
}

function getFilteredDocuments() {
  const keyword = $("searchInput").value.trim().toLowerCase();
  const department = getDepartmentFilterValue();
  const scope = $("scopeFilter").value;
  const status = $("statusFilter").value;
  const capability = $("capabilityFilter").value;

  return documentsCache.filter((item) => {
    const matchedKeyword =
      !keyword ||
      `${item.id} ${item.title} ${item.docNo} ${item.owner} ${item.department} ${item.updatedBy}`
        .toLowerCase()
        .includes(keyword);

    const matchedScope = scope === "all" || item.access?.level === scope;
    const matchedStatus = status === "all" || item.workflow?.status === status;
    const matchedDepartment = department === "all" || String(item.department || "").trim() === department;
    const matchedCapability =
      capability === "all" ||
      (capability === "edit" && item.canEdit) ||
      (capability === "view" && !item.canEdit);

    return matchedKeyword && matchedScope && matchedStatus && matchedDepartment && matchedCapability;
  });
}

async function openDocumentHistory(id) {
  openHistoryModal();
  $("historyDocMeta").textContent = `${id} · 正在读取历史版本`;
  $("historyList").innerHTML = '<div class="empty">正在读取历史版本...</div>';

  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}/versions`, {
      credentials: "include",
    });
    const data = await response.json();

    if (!response.ok) {
      $("historyList").innerHTML = `<div class="empty">${escapeHtml(data.error || "读取历史版本失败")}</div>`;
      return;
    }

    const items = Array.isArray(data.items) ? data.items : [];
    $("historyDocMeta").textContent = `${id} · 当前版本 V${String(data.currentVersion || 1).padStart(2, "0")}`;

    if (!items.length) {
      $("historyList").innerHTML = '<div class="empty">这份文件目前还没有历史版本记录。</div>';
      return;
    }

    $("historyList").innerHTML = items
      .map((item) => {
        const time = item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "-";
        return `
          <article class="history-item">
            <strong>V${String(item.version || 1).padStart(2, "0")} · ${escapeHtml(historyActionLabel(item.action))}</strong>
            <p>时间：${escapeHtml(time)}</p>
            <p>文件：${escapeHtml(item.file || "-")}</p>
            <div class="doc-actions" style="margin-top:10px;">
              <button class="primary" data-open-history="${escapeHtml(id)}" data-history-file="${escapeHtml(item.file || "")}">打开该历史版本并编辑</button>
            </div>
          </article>
        `;
      })
      .join("");

    $("historyList").querySelectorAll("[data-open-history]").forEach((button) => {
      button.addEventListener("click", () => {
        openHistoryVersionInEditor(button.getAttribute("data-open-history"), button.getAttribute("data-history-file"));
      });
    });
  } catch (_) {
    $("historyList").innerHTML = '<div class="empty">读取历史版本失败，请稍后重试。</div>';
  }
}
function bindReviewButtons(scope) {
  scope.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-review");
      const action = button.getAttribute("data-action");
      const defaultNote = action === "return" ? "请根据制度要求补充或修改后重新提交" : "审核通过";
      const note = window.prompt(action === "return" ? "请输入退回意见" : "请输入审核意见", defaultNote) || "";

      if (action === "return" && !note.trim()) {
        showToast("退回时请填写审核意见");
        return;
      }

      const response = await fetch(`/api/documents/${encodeURIComponent(id)}/review`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      const data = await response.json();

      if (!response.ok) {
        showToast(data.error || "审核失败");
        return;
      }

      showToast(action === "approve" ? "已审核通过" : "已退回修改");
      await fetchDocuments();
    });
  });
}

function bindSubmitButtons(scope) {
  scope.querySelectorAll("[data-submit]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-submit");
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}/submit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json();

      if (!response.ok) {
        showToast(data.error || "提交审核失败");
        return;
      }

      showToast("已提交给管理员审核");
      await fetchDocuments();
    });
  });
}

function bindDeleteButtons(scope) {
  scope.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-delete");
      if (!window.confirm(`确定删除文档“${id}”吗？`)) return;

      const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json();

      if (!response.ok) {
        showToast(data.error || "删除失败");
        return;
      }

      showToast("文档已删除");
      await fetchDocuments();
    });
  });
}

function bindHistoryButtons(scope) {
  scope.querySelectorAll("[data-history]").forEach((button) => {
    button.addEventListener("click", () => {
      openDocumentHistory(button.getAttribute("data-history"));
    });
  });
}

function renderReviewQueue() {
  const reviewPanel = $("reviewPanel");
  const reviewList = $("reviewList");

  if (!currentSession || currentSession.role !== "admin") {
    reviewPanel.hidden = true;
    reviewList.innerHTML = "";
    return;
  }

  reviewPanel.hidden = false;
  const department = getDepartmentFilterValue();
  const items = documentsCache.filter((item) => {
    if (item.workflow?.status !== "submitted") return false;
    if (department === "all") return true;
    return String(item.department || "").trim() === department;
  });

  if (!items.length) {
    reviewList.innerHTML = '<div class="empty">当前没有待审核文件。</div>';
    return;
  }

  reviewList.innerHTML = "";
  items.slice(0, 10).forEach((item) => {
    const card = document.createElement("div");
    card.className = "review-card";
    card.innerHTML = `
      <strong>${escapeHtml(item.title || item.id)}</strong>
      <p>${escapeHtml(item.department || "-")} · ${escapeHtml(item.owner || "-")}</p>
      <p>${escapeHtml(item.docNo || "未填写文号")}</p>
      <div class="doc-actions" style="margin-top: 12px;">
        <a class="action-link" href="/editor.html?doc=${encodeURIComponent(item.id)}&v=${Date.now()}" target="_blank" rel="noreferrer">打开</a>
        <button class="primary" data-review="${escapeHtml(item.id)}" data-action="approve">通过</button>
        <button data-review="${escapeHtml(item.id)}" data-action="return">退回</button>
      </div>
    `;
    reviewList.appendChild(card);
  });

  bindReviewButtons(reviewList);
}

function renderUsers() {
  const adminUsersCard = $("adminUsersCard");
  const userList = $("userList");

  if (!currentSession || currentSession.role !== "admin") {
    adminUsersCard.hidden = true;
    userList.innerHTML = "";
    return;
  }

  adminUsersCard.hidden = false;
  userList.innerHTML = "";

  usersCache.forEach((user) => {
    const currentAccess = String(user.specialBoardAccess || "own").toLowerCase() === "all" ? "all" : "own";
    const canToggleAccess = user.role !== "admin";
    const toggleBtnHtml = canToggleAccess
      ? `<button data-user-toggle-special-board="${escapeHtml(user.username)}">${
          currentAccess === "all" ? "改为仅本部门" : "开放全量可见"
        }</button>`
      : "";
    const row = document.createElement("div");
    row.className = "list-card";
    row.innerHTML = `
      <strong>${escapeHtml(user.displayName)}</strong>
      <p>${escapeHtml(user.username)} · ${escapeHtml(user.department || "未分配部门")}</p>
      <p>${escapeHtml(roleLabel(user.role))}</p>
      <p>${escapeHtml(specialBoardAccessLabel(currentAccess, user.role))}</p>
      <div class="doc-actions" style="margin-top:10px;">
        <button data-user-rename="${escapeHtml(user.username)}">改显示名/部门</button>
        <button data-user-reset-password="${escapeHtml(user.username)}">重置密码</button>
        ${toggleBtnHtml}
      </div>
    `;
    userList.appendChild(row);
  });

  bindUserManageButtons(userList);
}

function formatDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return "-";
  return new Date(time).toLocaleString("zh-CN");
}

function formatSecondsAgo(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 1) return "刚刚";
  if (value < 60) return `${Math.round(value)} 秒前`;
  if (value < 3600) return `${Math.round(value / 60)} 分钟前`;
  return `${Math.round(value / 3600)} 小时前`;
}

function stopOnlineSessionsPolling() {
  if (onlineSessionsTimer) {
    clearInterval(onlineSessionsTimer);
    onlineSessionsTimer = null;
  }
}

function renderOnlineSessions() {
  const adminOnlineCard = $("adminOnlineCard");
  const summary = $("onlineSummary");
  const accountList = $("onlineAccountList");
  if (!adminOnlineCard || !summary || !accountList) return;

  if (!currentSession || currentSession.role !== "admin") {
    adminOnlineCard.hidden = true;
    summary.innerHTML = "";
    accountList.innerHTML = "";
    return;
  }

  adminOnlineCard.hidden = false;

  if (!onlineSessionsCache) {
    summary.innerHTML = "";
    accountList.innerHTML = '<div class="empty">正在读取在线账号数据...</div>';
    return;
  }

  const stats = onlineSessionsCache.summary || {};
  summary.innerHTML = `
    <div class="presence-stat"><strong>${Number(stats.onlineAccounts || 0)}</strong><span>在线账号</span></div>
    <div class="presence-stat"><strong>${Number(stats.onlineSessions || 0)}</strong><span>在线会话</span></div>
    <div class="presence-stat"><strong>${Number(stats.activeSessions || 0)}</strong><span>活跃会话</span></div>
    <div class="presence-stat"><strong>${Number(stats.multiLoginAccounts || 0)}</strong><span>多端同登账号</span></div>
  `;

  const rows = Array.isArray(onlineSessionsCache.byUser) ? onlineSessionsCache.byUser : [];
  if (!rows.length) {
    accountList.innerHTML = '<div class="empty">当前没有在线账号。</div>';
    return;
  }

  accountList.innerHTML = rows
    .slice(0, 30)
    .map((row) => {
      const danger = Number(row.onlineSessions || 0) > 1 ? "（多端同登）" : "";
      return `
        <article class="presence-item">
          <strong>${escapeHtml(row.displayName || row.username)} · ${escapeHtml(row.username)} ${escapeHtml(danger)}</strong>
          <p>${escapeHtml(row.department || "未分配部门")} · ${escapeHtml(roleLabel(row.role))} · 在线会话 ${Number(row.onlineSessions || 0)} · 活跃 ${Number(row.activeSessions || 0)}</p>
          <p>最近心跳：${escapeHtml(formatDateTime(row.latestSeenAt))}（${escapeHtml(formatSecondsAgo((Date.now() - Date.parse(row.latestSeenAt || 0)) / 1000))}）</p>
          <p>IP 数量：${Number(row.ipCount || 0)} · ${escapeHtml((row.ips || []).join(", ") || "-")}</p>
        </article>
      `;
    })
    .join("");
}

async function fetchOnlineSessionsIfNeeded(options = {}) {
  if (!currentSession || currentSession.role !== "admin") {
    onlineSessionsCache = null;
    renderOnlineSessions();
    return;
  }

  try {
    const response = await fetch("/api/admin/online-sessions", { credentials: "include" });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        onlineSessionsCache = null;
        renderOnlineSessions();
      }
      if (!options.silent) showToast(data.error || "读取在线账号失败");
      return;
    }
    onlineSessionsCache = data;
    renderOnlineSessions();
  } catch (_) {
    if (!options.silent) showToast("读取在线账号失败");
  }
}

function refreshOnlineSessionsPolling() {
  stopOnlineSessionsPolling();
  if (!currentSession || currentSession.role !== "admin") {
    onlineSessionsCache = null;
    renderOnlineSessions();
    return;
  }

  renderOnlineSessions();
  fetchOnlineSessionsIfNeeded({ silent: true });
  onlineSessionsTimer = setInterval(() => {
    fetchOnlineSessionsIfNeeded({ silent: true });
  }, 10000);
}

function parseModelList(raw) {
  return Array.from(
    new Set(
      String(raw || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function renderAdminAiPanel() {
  const card = $("adminAiCard");
  const auditList = $("aiAuditList");
  const meta = $("aiConfigMeta");
  if (!card || !auditList || !meta) return;

  if (!currentSession || currentSession.role !== "admin") {
    card.hidden = true;
    auditList.innerHTML = "";
    meta.textContent = "";
    return;
  }

  card.hidden = false;

  if (!aiAdminConfigCache) {
    auditList.innerHTML = '<div class="empty">正在读取 AI 配置...</div>';
    meta.textContent = "";
    return;
  }

  const cfg = aiAdminConfigCache;
  const enabledSelect = $("aiEnabledSelect");
  const defaultModel = $("aiDefaultModelInput");
  const allowedModels = $("aiAllowedModelsInput");
  const limitUser = $("aiLimitUserInput");
  const limitDept = $("aiLimitDeptInput");
  if (enabledSelect) enabledSelect.value = String(!!cfg.enabled);
  if (defaultModel) defaultModel.value = String(cfg.defaultModel || "");
  if (allowedModels) allowedModels.value = Array.isArray(cfg.allowedModels) ? cfg.allowedModels.join(",") : "";
  if (limitUser) limitUser.value = String(cfg.limits?.dailyPerUser ?? 0);
  if (limitDept) limitDept.value = String(cfg.limits?.dailyPerDept ?? 0);

  meta.textContent = `配置状态：${cfg.enabled ? "开启" : "关闭"} · 服务端${
    cfg.configured ? "已配置" : "未配置"
  } · 更新人 ${cfg.updatedBy || "-"} · 更新时间 ${formatDateTime(cfg.updatedAt)}`;

  if (!aiAuditCache.length) {
    auditList.innerHTML = '<div class="empty">暂无调用日志。</div>';
    return;
  }

  auditList.innerHTML = aiAuditCache
    .slice(0, 120)
    .map((item) => {
      const tag = item.status === "ok" ? "成功" : "失败";
      const tokenText = Number(item.totalTokens || 0) > 0 ? ` · tokens ${Number(item.totalTokens || 0)}` : "";
      const err = item.error ? ` · ${escapeHtml(item.error)}` : "";
      return `
        <article class="audit-item">
          <strong>${escapeHtml(item.displayName || item.username || "-")} · ${escapeHtml(
            item.department || "-"
          )} · ${escapeHtml(item.model || "-")} · ${escapeHtml(tag)}</strong>
          <p>${escapeHtml(formatDateTime(item.ts))} · ${escapeHtml(item.action || "-")} · ${Number(
        item.durationMs || 0
      )}ms${tokenText}</p>
          <p>IP ${escapeHtml(item.ip || "-")}${err}</p>
        </article>
      `;
    })
    .join("");
}

async function fetchAdminAiConfig(options = {}) {
  if (!currentSession || currentSession.role !== "admin") {
    aiAdminConfigCache = null;
    renderAdminAiPanel();
    return;
  }
  try {
    const response = await fetch("/api/admin/ai/config", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (!options.silent) showToast(data.error || "读取 AI 配置失败");
      return;
    }
    aiAdminConfigCache = data.config || null;
    renderAdminAiPanel();
  } catch (_) {
    if (!options.silent) showToast("读取 AI 配置失败");
  }
}

async function fetchAdminAiAudit(options = {}) {
  if (!currentSession || currentSession.role !== "admin") {
    aiAuditCache = [];
    renderAdminAiPanel();
    return;
  }
  try {
    const response = await fetch("/api/admin/ai/audit?limit=120", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (!options.silent) showToast(data.error || "读取 AI 日志失败");
      return;
    }
    aiAuditCache = Array.isArray(data.items) ? data.items : [];
    renderAdminAiPanel();
  } catch (_) {
    if (!options.silent) showToast("读取 AI 日志失败");
  }
}

async function saveAdminAiConfig() {
  if (!currentSession || currentSession.role !== "admin") return;

  const enabled = $("aiEnabledSelect")?.value === "true";
  const allowedModels = parseModelList($("aiAllowedModelsInput")?.value || "");
  const defaultModel = String($("aiDefaultModelInput")?.value || "").trim();
  const dailyLimitPerUser = Number($("aiLimitUserInput")?.value || 0);
  const dailyLimitPerDept = Number($("aiLimitDeptInput")?.value || 0);

  if (!allowedModels.length) {
    showToast("至少保留一个可用模型");
    return;
  }

  const payload = {
    enabled,
    allowedModels,
    defaultModel: defaultModel || allowedModels[0],
    dailyLimitPerUser: Number.isFinite(dailyLimitPerUser) ? Math.max(0, Math.trunc(dailyLimitPerUser)) : 0,
    dailyLimitPerDept: Number.isFinite(dailyLimitPerDept) ? Math.max(0, Math.trunc(dailyLimitPerDept)) : 0,
  };

  const response = await fetch("/api/admin/ai/config", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(data.error || "保存 AI 配置失败");
    return;
  }
  aiAdminConfigCache = data.config || null;
  renderAdminAiPanel();
  showToast("AI 配置已保存");
}

async function updateUserByAdmin(username, payload) {
  const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    showToast(data.error || "账号更新失败");
    return false;
  }
  return true;
}

function bindUserManageButtons(scope) {
  scope.querySelectorAll("[data-user-rename]").forEach((button) => {
    button.addEventListener("click", async () => {
      const username = button.getAttribute("data-user-rename");
      const user = usersCache.find((item) => item.username === username);
      const nextDisplayName = window.prompt("请输入新的显示名", user?.displayName || "");
      if (nextDisplayName === null) return;
      const displayNameValue = String(nextDisplayName || "").trim();
      if (!displayNameValue) {
        showToast("显示名不能为空");
        return;
      }

      const nextDepartment = window.prompt("请输入新的部门名称", user?.department || "");
      if (nextDepartment === null) return;
      const departmentValue = String(nextDepartment || "").trim();
      if (!departmentValue) {
        showToast("部门名称不能为空");
        return;
      }

      let syncDepartmentGlobally = false;
      const oldDepartment = String(user?.department || "").trim();
      if (oldDepartment && oldDepartment !== departmentValue) {
        syncDepartmentGlobally = window.confirm(
          `是否同步改名整个部门？\n\n旧部门：${oldDepartment}\n新部门：${departmentValue}\n\n确定：同步该部门下所有账号和文件\n取消：仅修改当前账号（并同步该账号的历史文件）`
        );
      }

      const ok = await updateUserByAdmin(username, {
        displayName: displayNameValue,
        department: departmentValue,
        syncDepartmentGlobally,
      });
      if (!ok) return;

      if (syncDepartmentGlobally && oldDepartment && oldDepartment !== departmentValue) {
        showToast(`已同步部门：${oldDepartment} -> ${departmentValue}`);
      } else {
        showToast("账号信息已更新");
      }
      await fetchSession();
      await fetchUsersIfNeeded();
      await fetchDocuments();
    });
  });

  scope.querySelectorAll("[data-user-reset-password]").forEach((button) => {
    button.addEventListener("click", async () => {
      const username = button.getAttribute("data-user-reset-password");
      const nextPassword = window.prompt(`请输入 ${username} 的新密码（至少 8 位）`, "");
      if (nextPassword === null) return;
      const value = String(nextPassword || "").trim();
      if (value.length < 8) {
        showToast("新密码至少 8 位");
        return;
      }
      const ok = await updateUserByAdmin(username, { password: value });
      if (!ok) return;
      showToast(`已重置 ${username} 的密码`);
    });
  });

  scope.querySelectorAll("[data-user-toggle-special-board]").forEach((button) => {
    button.addEventListener("click", async () => {
      const username = button.getAttribute("data-user-toggle-special-board");
      const user = usersCache.find((item) => item.username === username);
      if (!user) return;
      if (user.role === "admin") {
        showToast("管理员默认全量可见，无需修改");
        return;
      }
      const currentAccess = String(user.specialBoardAccess || "own").toLowerCase() === "all" ? "all" : "own";
      const nextAccess = currentAccess === "all" ? "own" : "all";
      const confirmText =
        nextAccess === "all"
          ? `确认给 ${username} 开启“文件专项全量可见”权限吗？`
          : `确认把 ${username} 改为“仅本部门可见”吗？`;
      if (!window.confirm(confirmText)) return;

      const ok = await updateUserByAdmin(username, { specialBoardAccess: nextAccess });
      if (!ok) return;
      showToast(nextAccess === "all" ? `${username} 已开通全量可见` : `${username} 已改为仅本部门可见`);
      await fetchUsersIfNeeded();
      await fetchSession();
      await fetchDocuments();
    });
  });
}

function renderDocuments() {
  const docList = $("docList");
  syncDepartmentFilterOptions();

  if (!currentSession) {
    documentsCache = [];
    updateStats();
    renderReviewQueue();
    renderUsers();
    renderOnlineSessions();
    renderAdminAiPanel();
    docList.innerHTML = '<div class="empty">请先登录后查看文档列表。</div>';
    return;
  }

  updateStats();
  renderReviewQueue();
  renderUsers();
  renderOnlineSessions();
  renderAdminAiPanel();

  const items = getFilteredDocuments();
  if (!items.length) {
    docList.innerHTML = '<div class="empty">没有符合筛选条件的文档。</div>';
    return;
  }

  docList.innerHTML = "";
  items.forEach((item) => {
    const updatedAt = item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN") : "-";
    const reviewNote = item.workflow?.reviewNote ? ` · 审核意见：${escapeHtml(item.workflow.reviewNote)}` : "";
    const card = document.createElement("article");
    card.className = "doc-card";
    card.innerHTML = `
      <div class="doc-meta">
        <strong>${escapeHtml(item.title || item.id)}</strong>
        <p>文号：${escapeHtml(item.docNo || "-")} · 部门：${escapeHtml(item.department || "-")}</p>
        <p>创建人：${escapeHtml(item.owner || "-")} · 更新人：${escapeHtml(item.updatedBy || "-")}</p>
        <p>更新时间：${escapeHtml(updatedAt)}</p>
        <p>状态：${escapeHtml(statusLabel(item.workflow?.status || "draft"))}${reviewNote}</p>
        <div class="doc-badges">
          <span class="badge blue">${escapeHtml(scopeLabel(item.access?.level || "company"))}</span>
          <span class="badge ${statusBadgeClass(item.workflow?.status || "draft")}">${escapeHtml(statusLabel(item.workflow?.status || "draft"))}</span>
          <span class="badge ${item.canEdit ? "green" : "orange"}">${item.canEdit ? "可编辑" : "只读"}</span>
        </div>
      </div>
      <div class="doc-actions">
        <a class="action-link primary" href="/editor.html?doc=${encodeURIComponent(item.id)}&v=${Date.now()}" target="_blank" rel="noreferrer">
          ${item.canEdit ? "打开编辑" : "打开查看"}
        </a>
        <button data-history="${escapeHtml(item.id)}">历史版本</button>
        ${item.canSubmit ? `<button data-submit="${escapeHtml(item.id)}">提交审核</button>` : ""}
        ${item.canReview ? `<button class="primary" data-review="${escapeHtml(item.id)}" data-action="approve">通过</button>` : ""}
        ${item.canReview ? `<button data-review="${escapeHtml(item.id)}" data-action="return">退回</button>` : ""}
        ${item.canDelete ? `<button class="danger" data-delete="${escapeHtml(item.id)}">删除</button>` : ""}
      </div>
    `;
    docList.appendChild(card);
  });

  bindSubmitButtons(docList);
  bindReviewButtons(docList);
  bindHistoryButtons(docList);
  bindDeleteButtons(docList);
}

async function fetchSession() {
  const response = await fetch("/api/session", { credentials: "include" });
  const data = await response.json();
  currentSession = data.user || null;
  setLoggedInState();
  renderHero();
  renderAccountCard();
  refreshOnlineSessionsPolling();
  if (currentSession && currentSession.role === "admin") {
    fetchAdminAiConfig({ silent: true });
    fetchAdminAiAudit({ silent: true });
  } else {
    aiAdminConfigCache = null;
    aiAuditCache = [];
    renderAdminAiPanel();
  }
  return currentSession;
}

async function fetchUsersIfNeeded() {
  if (!currentSession || currentSession.role !== "admin") {
    usersCache = [];
    syncDepartmentFilterOptions();
    renderUsers();
    return;
  }

  const response = await fetch("/api/users", { credentials: "include" });
  const data = await response.json();
  if (!response.ok) {
    usersCache = [];
    syncDepartmentFilterOptions();
    renderUsers();
    return;
  }

  usersCache = Array.isArray(data.items) ? data.items : [];
  syncDepartmentFilterOptions();
  renderUsers();
}

async function fetchDocuments() {
  if (!currentSession) {
    documentsCache = [];
    renderDocuments();
    return;
  }

  const response = await fetch("/api/documents", { credentials: "include" });
  const data = await response.json();

  if (!response.ok) {
    showToast(data.error || "读取文档列表失败");
    return;
  }

  documentsCache = Array.isArray(data.items) ? data.items : [];
  renderDocuments();
}

async function login() {
  const username = $("usernameInput").value.trim();
  const password = $("passwordInput").value;

  if (!username || !password) {
    showToast("请输入用户名和密码");
    return;
  }

  const button = $("submitLoginBtn");
  button.disabled = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();

    if (!response.ok) {
      showToast(data.error || "登录失败");
      return;
    }

    currentSession = data.user;
    closeLogin();
    setLoggedInState();
    renderHero();
    renderAccountCard();
    refreshOnlineSessionsPolling();
    await fetchDocuments();
    await fetchUsersIfNeeded();
    if (currentSession.role === "admin") {
      await fetchAdminAiConfig({ silent: true });
      await fetchAdminAiAudit({ silent: true });
    }
    showToast("登录成功");
  } catch (_) {
    showToast("登录请求失败，请检查服务是否启动");
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await fetch("/api/logout", {
    method: "POST",
    credentials: "include",
  });

  stopOnlineSessionsPolling();
  currentSession = null;
  usersCache = [];
  documentsCache = [];
  onlineSessionsCache = null;
  aiAdminConfigCache = null;
  aiAuditCache = [];
  setLoggedInState();
  renderHero();
  renderAccountCard();
  renderDocuments();
  renderOnlineSessions();
  renderAdminAiPanel();
  showToast("已退出登录");
}

function bindEvents() {
  $("newDocBtn").addEventListener("click", () => {
    openTemplateModal();
  });
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-open-template]");
    if (!trigger) return;
    event.preventDefault();
    openTemplateModal();
  });
  $("refreshDocsBtn").addEventListener("click", fetchDocuments);
  $("searchInput").addEventListener("input", renderDocuments);
  $("departmentFilter").addEventListener("change", renderDocuments);
  $("scopeFilter").addEventListener("change", renderDocuments);
  $("statusFilter").addEventListener("change", renderDocuments);
  $("capabilityFilter").addEventListener("change", renderDocuments);
  $("openLoginBtn").addEventListener("click", openLogin);
  $("closeLoginBtn").addEventListener("click", closeLogin);
  $("closeHistoryBtn").addEventListener("click", closeHistoryModal);
  if ($("closeTemplateBtn")) $("closeTemplateBtn").addEventListener("click", closeTemplateModal);
  document.querySelectorAll("[data-template]").forEach((button) => {
    button.addEventListener("click", () => {
      openEditorByTemplate(button.getAttribute("data-template"));
    });
  });
  $("submitLoginBtn").addEventListener("click", login);
  $("logoutBtn").addEventListener("click", logout);
  if ($("saveAiConfigBtn")) {
    $("saveAiConfigBtn").addEventListener("click", saveAdminAiConfig);
  }
  if ($("refreshAiAuditBtn")) {
    $("refreshAiAuditBtn").addEventListener("click", async () => {
      await fetchAdminAiConfig({ silent: true });
      await fetchAdminAiAudit({ silent: false });
      showToast("AI 日志已刷新");
    });
  }
  $("historyOverlay").addEventListener("click", (event) => {
    if (event.target === $("historyOverlay")) closeHistoryModal();
  });
  if ($("templateOverlay")) {
    $("templateOverlay").addEventListener("click", (event) => {
      if (event.target === $("templateOverlay")) closeTemplateModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLogin();
      closeHistoryModal();
      closeTemplateModal();
    }
    if (event.key === "Enter" && $("loginOverlay").classList.contains("open")) {
      if (document.activeElement === $("usernameInput") || document.activeElement === $("passwordInput")) {
        login();
      }
    }
  });
}

(async function init() {
  const redirected = await resetClientCacheIfRequested();
  if (redirected) return;
  await ensureLegacyCachesClearedOnce();

  bindEvents();
  await fetchSession();
  if (currentSession) {
    await fetchDocuments();
    await fetchUsersIfNeeded();
    if (currentSession.role === "admin") {
      await fetchAdminAiConfig({ silent: true });
      await fetchAdminAiAudit({ silent: true });
    }
  } else {
    renderDocuments();
  }

  document.documentElement.dataset.appReady = "1";
})();

