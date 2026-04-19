let toastTimer = null;
let currentSession = null;
let documentsCache = [];
let usersCache = [];

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
  const onlineSessionsCard = $("onlineSessionsCard");
  const aiAdminCard = $("aiAdminCard");

  if (!currentSession) {
    accountCard.innerHTML = "<strong>未登录</strong><p>请先登录后访问文档库和审核功能。</p>";
    sessionArea.innerHTML = '<div class="empty">登录后可查看个人工作区。</div>';
    reviewPanel.hidden = true;
    adminUsersCard.hidden = true;
    if (onlineSessionsCard) onlineSessionsCard.hidden = true;
    if (aiAdminCard) aiAdminCard.hidden = true;
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
  if (onlineSessionsCard) onlineSessionsCard.hidden = currentSession.role !== "admin";
  if (aiAdminCard) aiAdminCard.hidden = currentSession.role !== "admin";
  if (currentSession.role === "admin") {
    loadOnlineSessions();
    loadAiConfig();
  }
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
    const row = document.createElement("div");
    row.className = "list-card";
    row.innerHTML = `
      <strong>${escapeHtml(user.displayName)}</strong>
      <p>${escapeHtml(user.username)} · ${escapeHtml(user.department || "未分配部门")}</p>
      <p>${escapeHtml(roleLabel(user.role))}</p>
      <div class="doc-actions" style="margin-top:10px;">
        <button data-user-rename="${escapeHtml(user.username)}">改显示名/部门</button>
        <button data-user-reset-password="${escapeHtml(user.username)}">重置密码</button>
      </div>
    `;
    userList.appendChild(row);
  });

  bindUserManageButtons(userList);
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
}

function renderDocuments() {
  const docList = $("docList");
  syncDepartmentFilterOptions();

  if (!currentSession) {
    documentsCache = [];
    updateStats();
    renderReviewQueue();
    renderUsers();
    docList.innerHTML = '<div class="empty">请先登录后查看文档列表。</div>';
    return;
  }

  updateStats();
  renderReviewQueue();
  renderUsers();

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
    await fetchDocuments();
    await fetchUsersIfNeeded();
    startHeartbeat();
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

  currentSession = null;
  usersCache = [];
  documentsCache = [];
  setLoggedInState();
  stopHeartbeat();
  renderHero();
  renderAccountCard();
  renderDocuments();
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

// ── 心跳 ──────────────────────────────────────────────────────────────────────
let _heartbeatTimer = null;
function startHeartbeat() {
  if (_heartbeatTimer) return;
  const ping = () => { if (currentSession) fetch("/api/heartbeat", { method: "POST", credentials: "include" }).catch(() => {}); };
  ping();
  _heartbeatTimer = setInterval(ping, 30000);
}
function stopHeartbeat() {
  clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
}

// ── 在线账号监控 ──────────────────────────────────────────────────────────────
async function loadOnlineSessions() {
  const el = $("onlineSessionsList");
  if (!el) return;
  try {
    const res = await fetch("/api/admin/online-sessions", { credentials: "include" });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<div class="empty">加载失败：${escapeHtml(data.error || "未知错误")}</div>`; return; }
    renderOnlineSessions(data);
  } catch (e) {
    el.innerHTML = `<div class="empty">请求失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderOnlineSessions(data) {
  const el = $("onlineSessionsList");
  if (!el) return;
  const { byUser = [], total = 0 } = data;
  if (byUser.length === 0) {
    el.innerHTML = '<div class="empty">暂无在线账号（心跳 90 秒内算在线）</div>';
    return;
  }
  const rows = byUser.map(u => {
    const multi = u.onlineCount > 1;
    const badge = u.onlineCount > 0
      ? `<span style="background:${multi ? '#fee2e2' : '#dcfce7'};color:${multi ? '#ef4444' : '#16a34a'};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">${u.onlineCount > 0 ? `在线 ${u.onlineCount} 会话` : '离线'}${multi ? ' ⚠️多设备' : ''}</span>`
      : `<span style="background:#f1f5f9;color:#94a3b8;padding:2px 8px;border-radius:12px;font-size:11px;">离线</span>`;
    const deviceRows = u.sessions.map(s => {
      const t = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString("zh-CN") : "-";
      const ua = s.userAgent ? s.userAgent.slice(0, 60) : "-";
      return `<div style="font-size:11px;color:#64748b;padding:2px 0 2px 12px;border-left:2px solid ${s.online ? '#22c55e' : '#e2e8f0'};">
        ${s.online ? '🟢' : '⚪'} IP: ${escapeHtml(s.ip)} · 最后活跃: ${t}<br><span style="color:#94a3b8">${escapeHtml(ua)}</span></div>`;
    }).join('');
    return `<div style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <strong style="font-size:13px;">${escapeHtml(u.displayName)}</strong>
        <span style="font-size:11px;color:#94a3b8;">${escapeHtml(u.username)} · ${escapeHtml(u.department || '未分配')}</span>
        ${badge}
      </div>
      ${deviceRows}
    </div>`;
  }).join('');
  el.innerHTML = `<div style="font-size:12px;color:#64748b;margin-bottom:8px;">当前在线总会话数：<strong>${total}</strong></div>${rows}
    <button class="ghost" style="margin-top:10px;font-size:12px;" onclick="loadOnlineSessions()">刷新</button>`;
}

// ── AI 管理 ────────────────────────────────────────────────────────────────────
async function loadAiConfig() {
  try {
    const res = await fetch("/api/admin/ai-config", { credentials: "include" });
    const data = await res.json();
    if (!res.ok) return;
    const cfg = data.config || {};
    const enabled = $("aiEnabled");
    const defModel = $("aiDefaultModel");
    const allowed = $("aiAllowedModels");
    const limitUser = $("aiLimitPerUser");
    const limitDept = $("aiLimitPerDept");
    if (enabled) enabled.value = cfg.enabled !== false ? "true" : "false";
    if (defModel) defModel.value = cfg.defaultModel || "deepseek-chat";
    if (allowed) allowed.value = Array.isArray(cfg.allowedModels) ? cfg.allowedModels.join(",") : "deepseek-chat,deepseek-reasoner";
    if (limitUser) limitUser.value = cfg.limitPerUser || 0;
    if (limitDept) limitDept.value = cfg.limitPerDept || 0;
    const logPanel = $("aiLogPanel");
    if (logPanel) logPanel.innerHTML = '<div class="empty">点击「刷新日志」查看调用记录</div>';
  } catch (_) {}
}

async function saveAiConfig() {
  const enabled = $("aiEnabled")?.value === "true";
  const defaultModel = $("aiDefaultModel")?.value.trim() || "deepseek-chat";
  const allowedModels = ($("aiAllowedModels")?.value || "").split(",").map(s => s.trim()).filter(Boolean);
  const limitPerUser = Number($("aiLimitPerUser")?.value) || 0;
  const limitPerDept = Number($("aiLimitPerDept")?.value) || 0;
  try {
    const res = await fetch("/api/admin/ai-config", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, defaultModel, allowedModels, limitPerUser, limitPerDept }),
    });
    const data = await res.json();
    showToast(res.ok ? "AI 配置已保存" : (data.error || "保存失败"));
  } catch (e) {
    showToast("请求失败：" + e.message);
  }
}

async function loadAiLogs() {
  const logPanel = $("aiLogPanel");
  if (!logPanel) return;
  logPanel.innerHTML = '<div class="empty">加载中...</div>';
  try {
    const res = await fetch("/api/admin/ai-logs", { credentials: "include" });
    const data = await res.json();
    if (!res.ok) { logPanel.innerHTML = `<div class="empty">加载失败</div>`; return; }
    const logs = data.logs || [];
    if (logs.length === 0) { logPanel.innerHTML = '<div class="empty">暂无调用记录</div>'; return; }
    logPanel.innerHTML = logs.map(l => {
      const t = l.ts ? new Date(l.ts).toLocaleString("zh-CN") : "-";
      return `<div style="padding:3px 0;border-bottom:1px solid #e2e8f0;">${t} · <strong>${escapeHtml(l.username)}</strong> [${escapeHtml(l.dept || "-")}] · ${escapeHtml(l.model || "-")} · ${escapeHtml(l.action || "-")} · ${l.ms || 0}ms</div>`;
    }).join('');
  } catch (e) {
    logPanel.innerHTML = `<div class="empty">请求失败</div>`;
  }
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
    startHeartbeat();
  } else {
    renderDocuments();
  }

  document.documentElement.dataset.appReady = "1";
})();

