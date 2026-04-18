const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");

const APP_NAME = process.env.APP_NAME || "Flow Docs";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3100);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(ROOT, "data"));
const DOCUMENTS_DIR = path.join(DATA_ROOT, "documents");
const HISTORY_DIR = path.join(DATA_ROOT, "history");
const METADATA_DIR = path.join(DATA_ROOT, "metadata");
const USERS_FILE = path.join(DATA_ROOT, "users.json");
const SPECIAL_BOARD_FILE = path.join(DATA_ROOT, "special-board.json");
const SPECIAL_BOARD_STORAGE = String(process.env.SPECIAL_BOARD_STORAGE || "file").toLowerCase();
const SPECIAL_BOARD_PDF_PROVIDER = String(process.env.SPECIAL_BOARD_PDF_PROVIDER || "local").toLowerCase();
const PG_SSL = String(process.env.PG_SSL || "").toLowerCase() === "true";
const COS_SECRET_ID = String(process.env.COS_SECRET_ID || "").trim();
const COS_SECRET_KEY = String(process.env.COS_SECRET_KEY || "").trim();
const COS_BUCKET = String(process.env.COS_BUCKET || "").trim();
const COS_REGION = String(process.env.COS_REGION || "").trim();
const AI_ASSIST_PROVIDER = String(process.env.AI_ASSIST_PROVIDER || "deepseek").trim().toLowerCase();
const DEEPSEEK_BASE_URL = String(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").trim().replace(/\/+$/, "");
const DEEPSEEK_API_KEY = String(process.env.DEEPSEEK_API_KEY || "").trim();
const DEEPSEEK_MODEL = String(process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
const AI_ASSIST_TIMEOUT_MS = Number(process.env.AI_ASSIST_TIMEOUT_MS || 45000);
const AI_ASSIST_MAX_INPUT_CHARS = Number(process.env.AI_ASSIST_MAX_INPUT_CHARS || 120000);
const AI_ASSIST_ENABLED_DEFAULT = String(process.env.AI_ASSIST_ENABLED || "true").trim().toLowerCase() !== "false";
const AI_ASSIST_ALLOWED_MODELS_ENV = String(
  process.env.AI_ASSIST_ALLOWED_MODELS || `${DEEPSEEK_MODEL},deepseek-chat,deepseek-reasoner`
).trim();
const AI_ASSIST_DAILY_LIMIT_PER_USER_DEFAULT = Math.max(0, Number(process.env.AI_ASSIST_DAILY_LIMIT_PER_USER || 80));
const AI_ASSIST_DAILY_LIMIT_PER_DEPT_DEFAULT = Math.max(0, Number(process.env.AI_ASSIST_DAILY_LIMIT_PER_DEPT || 300));
const AI_ASSIST_AUDIT_MAX_DAYS = Math.max(1, Number(process.env.AI_ASSIST_AUDIT_MAX_DAYS || 30));
const SPECIAL_BOARD_ATTACHMENT_PREFIX = String(
  process.env.SPECIAL_BOARD_ATTACHMENT_PREFIX || "special-board-pdf"
).trim();
const SPECIAL_BOARD_PDF_MAX_BYTES = Number(process.env.SPECIAL_BOARD_PDF_MAX_BYTES || 30 * 1024 * 1024);
const SPECIAL_BOARD_LOCAL_ATTACHMENT_DIR = path.join(DATA_ROOT, "special-board-attachments");
const AI_ASSIST_SETTINGS_FILE = path.join(DATA_ROOT, "ai-assist-settings.json");
const AI_ASSIST_AUDIT_LOG_FILE = path.join(DATA_ROOT, "ai-assist-audit.log");

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "sop_session";
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_ONLINE_WINDOW_MS = Number(process.env.SESSION_ONLINE_WINDOW_MS || 90 * 1000);
const SESSION_ACTIVE_WINDOW_MS = Number(process.env.SESSION_ACTIVE_WINDOW_MS || 5 * 60 * 1000);

const MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE || 200 * 1024 * 1024);
const PASSWORD_PBKDF2_ITERATIONS = Number(process.env.PASSWORD_PBKDF2_ITERATIONS || 210000);
const PASSWORD_PBKDF2_KEYLEN = 32;
const PASSWORD_PBKDF2_DIGEST = "sha256";
const LOGIN_ATTEMPT_WINDOW_MS = Number(process.env.LOGIN_ATTEMPT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const LOGIN_BLOCK_MS = Number(process.env.LOGIN_BLOCK_MS || 15 * 60 * 1000);

const WORKFLOW_STATUSES = ["draft", "submitted", "returned", "approved"];
const ACCESS_LEVELS = ["private", "team", "company"];
const TEMPLATE_KEYS = ["standard-sipoc", "core-fixed", "fully-flexible", "default", "procurement", "quality"];
const SPECIAL_BOARD_ACCESS_OWN = "own";
const SPECIAL_BOARD_ACCESS_ALL = "all";

const DEPARTMENTS = [
  "General Management",
  "Human Resources",
  "Finance",
  "Procurement",
  "Production",
  "Quality",
  "Engineering",
  "R&D",
  "Sales",
  "Marketing",
  "Warehouse & Logistics",
  "IT",
  "Equipment",
  "EHS",
  "Customer Service",
  "Legal & Audit",
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(METADATA_DIR, { recursive: true });
fs.mkdirSync(SPECIAL_BOARD_LOCAL_ATTACHMENT_DIR, { recursive: true });

const sessions = new Map();
const loginAttempts = new Map();
const specialBoardStreamClients = new Set();
let specialBoardPgPool = null;
let specialBoardDbReady = false;
let cosClient = null;

function sanitizeAiAssistText(value, maxChars = 0) {
  const raw = String(value || "").replace(/\u0000/g, "").replace(/\r\n/g, "\n");
  const trimmed = raw.trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0 || trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars);
}

function sanitizeAiAssistList(values, maxItems = 20, maxChars = 160) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  for (const item of values) {
    const text = sanitizeAiAssistText(item, maxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= Math.max(1, maxItems)) break;
  }
  return result;
}

function sanitizeAiAssistTableContexts(values) {
  if (!Array.isArray(values)) return [];
  const tables = [];
  for (const raw of values) {
    const title = sanitizeAiAssistText(raw?.title, 120) || "";
    const headers = sanitizeAiAssistList(raw?.headers, 20, 80);
    const sampleRows = Array.isArray(raw?.sampleRows)
      ? raw.sampleRows
          .slice(0, 3)
          .map((row) => sanitizeAiAssistList(Array.isArray(row) ? row : [], 20, 100))
          .filter((row) => row.length > 0)
      : [];
    const rowCount = Math.max(0, Math.min(5000, Number(raw?.rowCount || 0) || 0));
    const colCount = Math.max(0, Math.min(50, Number(raw?.colCount || 0) || 0));
    tables.push({
      title,
      headers,
      sampleRows,
      rowCount,
      colCount,
    });
    if (tables.length >= 10) break;
  }
  return tables;
}

function sanitizeAiAssistTargetContext(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    preferredFormat: ["table", "rich_text", "text"].includes(String(raw.preferredFormat || "").trim())
      ? String(raw.preferredFormat || "").trim()
      : "rich_text",
    inTable: !!raw.inTable,
    tableTitle: sanitizeAiAssistText(raw.tableTitle, 120),
    headers: sanitizeAiAssistList(raw.headers, 20, 80),
    rowCount: Math.max(0, Math.min(5000, Number(raw.rowCount || 0) || 0)),
    colCount: Math.max(0, Math.min(50, Number(raw.colCount || 0) || 0)),
    activeCellText: sanitizeAiAssistText(raw.activeCellText, 300),
  };
}

function stripHtmlTagsToText(value, maxChars = 0) {
  const text = String(value || "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeAiAssistText(text, maxChars);
}

function sanitizeAiAssistHtml(value, maxChars = 60000) {
  const html = sanitizeAiAssistText(value, maxChars);
  if (!html) return "";
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/\bon\w+\s*=\s*(['"]).*?\1/gi, "")
    .trim();
}

function extractFirstJsonObjectFromText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const fenceRemoved = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(fenceRemoved);
  } catch (_) {}

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < fenceRemoved.length; i += 1) {
    const ch = fenceRemoved[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth <= 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = fenceRemoved.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (_) {
          start = -1;
        }
      }
    }
  }
  return null;
}

function parseAiAssistStructuredOutput(action, rawContent) {
  const raw = sanitizeAiAssistText(rawContent, 120000);
  const base = {
    outputFormat: action === "write" ? "rich_text" : "text",
    html: "",
    text: raw,
    insertHint: "",
    assumptions: [],
  };
  if (!raw || action !== "write") return base;

  const parsed = extractFirstJsonObjectFromText(raw);
  if (!parsed || typeof parsed !== "object") return base;

  const outputFormatRaw = sanitizeAiAssistText(parsed.format, 24).toLowerCase();
  const outputFormat = ["table", "rich_text", "text"].includes(outputFormatRaw) ? outputFormatRaw : "rich_text";
  const html = sanitizeAiAssistHtml(parsed.html, 80000);
  const text = sanitizeAiAssistText(parsed.text, 120000) || stripHtmlTagsToText(html, 120000) || raw;
  const insertHint = sanitizeAiAssistText(parsed.insertHint || parsed.insert_hint, 200);
  const assumptions = sanitizeAiAssistList(parsed.assumptions, 10, 200);

  return {
    outputFormat,
    html,
    text,
    insertHint,
    assumptions,
  };
}

function isDeepSeekAssistConfigured() {
  return AI_ASSIST_PROVIDER === "deepseek" && Boolean(DEEPSEEK_API_KEY) && Boolean(DEEPSEEK_MODEL);
}

function normalizeAiModelList(input, fallback = []) {
  const rawList = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const cleaned = [];
  const seen = new Set();
  for (const item of rawList) {
    const value = String(item || "").trim();
    if (!value) continue;
    if (!/^[a-zA-Z0-9._:-]{2,100}$/.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value);
    if (cleaned.length >= 20) break;
  }

  if (cleaned.length > 0) return cleaned;
  return Array.isArray(fallback) ? normalizeAiModelList(fallback, []) : [];
}

function pickDefaultAiModel(allowedModels = []) {
  if (allowedModels.includes(DEEPSEEK_MODEL)) return DEEPSEEK_MODEL;
  return allowedModels[0] || DEEPSEEK_MODEL;
}

function buildDefaultAiAssistSettings() {
  const allowedModels = normalizeAiModelList(AI_ASSIST_ALLOWED_MODELS_ENV, [DEEPSEEK_MODEL]);
  return {
    enabled: AI_ASSIST_ENABLED_DEFAULT,
    allowedModels,
    defaultModel: pickDefaultAiModel(allowedModels),
    dailyLimitPerUser: AI_ASSIST_DAILY_LIMIT_PER_USER_DEFAULT,
    dailyLimitPerDept: AI_ASSIST_DAILY_LIMIT_PER_DEPT_DEFAULT,
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
  };
}

function normalizeAiAssistSettings(input = {}, fallback = null) {
  const base = fallback || buildDefaultAiAssistSettings();
  const raw = input && typeof input === "object" ? input : {};
  const enabled = raw.enabled === undefined ? !!base.enabled : Boolean(raw.enabled);
  const allowedModels = normalizeAiModelList(raw.allowedModels, base.allowedModels || [DEEPSEEK_MODEL]);
  const defaultModelRaw = String(raw.defaultModel || "").trim();
  const defaultModel = allowedModels.includes(defaultModelRaw) ? defaultModelRaw : pickDefaultAiModel(allowedModels);

  const dailyLimitPerUserRaw = Number(raw.dailyLimitPerUser);
  const dailyLimitPerDeptRaw = Number(raw.dailyLimitPerDept);
  const dailyLimitPerUser = Number.isFinite(dailyLimitPerUserRaw)
    ? Math.max(0, Math.trunc(dailyLimitPerUserRaw))
    : Math.max(0, Number(base.dailyLimitPerUser || 0));
  const dailyLimitPerDept = Number.isFinite(dailyLimitPerDeptRaw)
    ? Math.max(0, Math.trunc(dailyLimitPerDeptRaw))
    : Math.max(0, Number(base.dailyLimitPerDept || 0));

  return {
    enabled,
    allowedModels,
    defaultModel,
    dailyLimitPerUser,
    dailyLimitPerDept,
    updatedAt: String(raw.updatedAt || base.updatedAt || new Date().toISOString()),
    updatedBy: String(raw.updatedBy || base.updatedBy || "system"),
  };
}

function ensureAiAssistSettingsFile() {
  if (fs.existsSync(AI_ASSIST_SETTINGS_FILE)) return;
  const defaults = buildDefaultAiAssistSettings();
  fs.writeFileSync(AI_ASSIST_SETTINGS_FILE, JSON.stringify(defaults, null, 2), "utf8");
}

function readAiAssistSettings() {
  const defaults = buildDefaultAiAssistSettings();
  try {
    ensureAiAssistSettingsFile();
    const raw = JSON.parse(fs.readFileSync(AI_ASSIST_SETTINGS_FILE, "utf8"));
    return normalizeAiAssistSettings(raw, defaults);
  } catch (_) {
    return defaults;
  }
}

function saveAiAssistSettings(next, user = null) {
  const current = readAiAssistSettings();
  const merged = normalizeAiAssistSettings(
    {
      ...current,
      ...(next && typeof next === "object" ? next : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: user?.username || "system",
    },
    current
  );
  fs.writeFileSync(AI_ASSIST_SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function getTodayKeyLocal(now = Date.now()) {
  const dt = new Date(now);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseAiAssistAuditLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  try {
    const item = JSON.parse(text);
    if (!item || typeof item !== "object") return null;
    return item;
  } catch (_) {
    return null;
  }
}

function appendAiAssistAudit(entry = {}) {
  const row = {
    ts: new Date().toISOString(),
    day: getTodayKeyLocal(),
    username: String(entry.username || ""),
    displayName: String(entry.displayName || ""),
    department: String(entry.department || ""),
    role: String(entry.role || ""),
    action: String(entry.action || ""),
    model: String(entry.model || ""),
    status: String(entry.status || "unknown"),
    durationMs: Math.max(0, Number(entry.durationMs || 0)),
    promptChars: Math.max(0, Number(entry.promptChars || 0)),
    inputChars: Math.max(0, Number(entry.inputChars || 0)),
    outputChars: Math.max(0, Number(entry.outputChars || 0)),
    promptTokens: Math.max(0, Number(entry.promptTokens || 0)),
    completionTokens: Math.max(0, Number(entry.completionTokens || 0)),
    totalTokens: Math.max(0, Number(entry.totalTokens || 0)),
    error: String(entry.error || ""),
    ip: String(entry.ip || ""),
  };
  fs.appendFileSync(AI_ASSIST_AUDIT_LOG_FILE, `${JSON.stringify(row)}\n`, "utf8");
}

function listAiAssistAudit(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
  const cutoffMs = Date.now() - AI_ASSIST_AUDIT_MAX_DAYS * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(AI_ASSIST_AUDIT_LOG_FILE)) return [];
  try {
    const lines = fs.readFileSync(AI_ASSIST_AUDIT_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < safeLimit; i -= 1) {
      const item = parseAiAssistAuditLine(lines[i]);
      if (!item) continue;
       const ts = Date.parse(String(item.ts || ""));
       if (Number.isFinite(ts) && ts < cutoffMs) continue;
      rows.push(item);
    }
    return rows;
  } catch (_) {
    return [];
  }
}

function getAiAssistUsageForDay(dayKey = getTodayKeyLocal()) {
  const usage = {
    byUser: Object.create(null),
    byDept: Object.create(null),
  };
  if (!fs.existsSync(AI_ASSIST_AUDIT_LOG_FILE)) return usage;
  try {
    const lines = fs.readFileSync(AI_ASSIST_AUDIT_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const item = parseAiAssistAuditLine(line);
      if (!item) continue;
      if (String(item.day || "") !== String(dayKey)) continue;
      if (String(item.status || "") !== "ok") continue;
      const username = String(item.username || "");
      const dept = String(item.department || "");
      if (username) usage.byUser[username] = Number(usage.byUser[username] || 0) + 1;
      if (dept) usage.byDept[dept] = Number(usage.byDept[dept] || 0) + 1;
    }
  } catch (_) {
  }
  return usage;
}

function sanitizeAiAuditForClient(item = {}) {
  return {
    ts: String(item.ts || ""),
    day: String(item.day || ""),
    username: String(item.username || ""),
    displayName: String(item.displayName || ""),
    department: String(item.department || ""),
    role: String(item.role || ""),
    action: String(item.action || ""),
    model: String(item.model || ""),
    status: String(item.status || ""),
    durationMs: Math.max(0, Number(item.durationMs || 0)),
    promptChars: Math.max(0, Number(item.promptChars || 0)),
    inputChars: Math.max(0, Number(item.inputChars || 0)),
    outputChars: Math.max(0, Number(item.outputChars || 0)),
    promptTokens: Math.max(0, Number(item.promptTokens || 0)),
    completionTokens: Math.max(0, Number(item.completionTokens || 0)),
    totalTokens: Math.max(0, Number(item.totalTokens || 0)),
    error: String(item.error || ""),
    ip: String(item.ip || ""),
  };
}

function getAiAssistPublicConfig(user = null) {
  const settings = readAiAssistSettings();
  const usageToday = getAiAssistUsageForDay(getTodayKeyLocal());
  const username = String(user?.username || "");
  const department = String(user?.department || "");
  const usedByUser = username ? Number(usageToday.byUser[username] || 0) : 0;
  const usedByDept = department ? Number(usageToday.byDept[department] || 0) : 0;
  const limitPerUser = Math.max(0, Number(settings.dailyLimitPerUser || 0));
  const limitPerDept = Math.max(0, Number(settings.dailyLimitPerDept || 0));

  return {
    enabled: !!settings.enabled,
    provider: AI_ASSIST_PROVIDER,
    configured: isDeepSeekAssistConfigured(),
    allowedModels: settings.allowedModels,
    defaultModel: settings.defaultModel,
    limits: {
      dailyPerUser: limitPerUser,
      dailyPerDept: limitPerDept,
      usedByUser,
      usedByDept,
      remainingByUser: limitPerUser <= 0 ? null : Math.max(0, limitPerUser - usedByUser),
      remainingByDept: limitPerDept <= 0 ? null : Math.max(0, limitPerDept - usedByDept),
    },
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    canManage: !!(user && isAdmin(user)),
  };
}

function extractAiTextFromMessagePart(part) {
  if (!part) return "";
  if (typeof part === "string") return part.trim();
  if (typeof part?.text === "string") return part.text.trim();
  if (typeof part?.content === "string") return part.content.trim();
  return "";
}

function extractDeepSeekChoiceContent(choice) {
  const message = choice?.message || {};
  const chunks = [];

  if (typeof message.content === "string") {
    chunks.push(message.content.trim());
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const text = extractAiTextFromMessagePart(part);
      if (text) chunks.push(text);
    }
  } else if (message.content && typeof message.content === "object") {
    const text =
      extractAiTextFromMessagePart(message.content) ||
      sanitizeAiAssistText(message.content?.text, 120000) ||
      sanitizeAiAssistText(message.content?.value, 120000);
    if (text) chunks.push(text);
  }

  if (typeof message.reasoning_content === "string") {
    const reasoning = message.reasoning_content.trim();
    if (reasoning) chunks.push(reasoning);
  } else if (Array.isArray(message.reasoning_content)) {
    for (const part of message.reasoning_content) {
      const text = extractAiTextFromMessagePart(part);
      if (text) chunks.push(text);
    }
  }

  if (!chunks.length && typeof choice?.text === "string") {
    const fallback = choice.text.trim();
    if (fallback) chunks.push(fallback);
  }
  if (!chunks.length && typeof choice?.output_text === "string") {
    const fallback = choice.output_text.trim();
    if (fallback) chunks.push(fallback);
  }
  if (!chunks.length && typeof message.refusal === "string") {
    const refusal = message.refusal.trim();
    if (refusal) chunks.push(refusal);
  }

  return chunks.join("\n\n").trim();
}

function buildDocumentAiMessages(action, payload, user) {
  const docText = sanitizeAiAssistText(payload?.text, AI_ASSIST_MAX_INPUT_CHARS);
  const instructionRaw = sanitizeAiAssistText(payload?.instruction, 3000);
  const instruction =
    instructionRaw ||
    (action === "write"
      ? "请基于当前文档上下文，生成可直接粘贴的新增内容。"
      : "请审阅当前文档，指出风险、缺失项、逻辑问题和可落地优化建议。");
  const sourceOutline = sanitizeAiAssistList(payload?.sourceOutline, 30, 160);
  const sourceTables = sanitizeAiAssistTableContexts(payload?.sourceTables);
  const targetContext = sanitizeAiAssistTargetContext(payload?.targetContext);

  const docMeta = [
    `- 标题: ${sanitizeAiAssistText(payload?.title, 200) || "未提供"}`,
    `- 文号: ${sanitizeAiAssistText(payload?.docNo, 120) || "未提供"}`,
    `- 部门: ${sanitizeAiAssistText(payload?.department, 120) || sanitizeAiAssistText(user?.department, 120) || "未提供"}`,
    `- 模板: ${sanitizeAiAssistText(payload?.templateKey, 80) || "未提供"}`,
    `- 操作人: ${sanitizeAiAssistText(user?.displayName || user?.username, 120) || "unknown"}`,
  ].join("\n");

  const outlineText = sourceOutline.length
    ? sourceOutline.map((item, idx) => `${idx + 1}. ${item}`).join("\n")
    : "(未提供)";

  const tableContextText = sourceTables.length
    ? sourceTables
        .map((table, idx) => {
          const headerText = table.headers.length ? table.headers.join(" | ") : "(无表头)";
          const sampleRows = table.sampleRows
            .map((row, rowIdx) => `   示例${rowIdx + 1}: ${row.join(" | ")}`)
            .join("\n");
          const summary = [
            `表${idx + 1}: ${table.title || "未命名表格"} (${table.rowCount}行/${table.colCount}列)`,
            `   列: ${headerText}`,
            sampleRows || "   示例: (无)",
          ].join("\n");
          return summary;
        })
        .join("\n")
    : "(未提供)";

  const targetContextText = [
    `- preferredFormat: ${targetContext.preferredFormat}`,
    `- inTable: ${targetContext.inTable ? "true" : "false"}`,
    `- tableTitle: ${targetContext.tableTitle || "未提供"}`,
    `- headers: ${targetContext.headers.join(" | ") || "(未提供)"}`,
    `- rowCount: ${targetContext.rowCount}`,
    `- colCount: ${targetContext.colCount}`,
    `- activeCellText: ${targetContext.activeCellText || "(未提供)"}`,
  ].join("\n");

  const systemPrompt =
    action === "write"
      ? [
          "你是企业流程文件写作助手。",
          "目标：根据现有上下文输出可直接插入模板的结果，优先保留模板结构与排版。",
          "要求：语言正式、结构清晰、可执行，避免空话。",
          "重要：如果目标上下文是表格（preferredFormat=table 或 inTable=true），必须输出表格结构，不要只输出纯文字。",
          "你必须只输出一个 JSON 对象，不要输出 Markdown 代码块、不要输出额外解释。",
          "JSON Schema:",
          '{"format":"table|rich_text|text","insertHint":"建议插入位置","html":"可插入的HTML片段","text":"给人读的版本","assumptions":["待确认项1","待确认项2"]}',
          "HTML 规范：",
          "1) 仅输出片段，不要<html>/<body>；",
          "2) 表格必须使用<table><thead><tbody>；",
          "3) 允许标签: h3,h4,p,ul,ol,li,strong,em,table,thead,tbody,tr,th,td,br；",
          "4) 不要输出脚本、样式、事件属性。",
        ].join("\n")
      : [
          "你是企业流程文件审阅助手。",
          "目标：发现当前文件在逻辑、合规、可执行性和一致性上的问题。",
          "输出格式：",
          "1) 总体结论（2-4句）；",
          "2) 高风险问题（按严重度排序，给出修改建议）；",
          "3) 中低风险优化建议；",
          "4) 一份可执行的“下一步修改清单”（Checklist）。",
        ].join("\n");

  const userPrompt = [
    "【文档元信息】",
    docMeta,
    "",
    "【用户诉求】",
    instruction,
    "",
    "【目标上下文】",
    targetContextText,
    "",
    "【模板大纲】",
    outlineText,
    "",
    "【模板表格结构摘要】",
    tableContextText,
    "",
    "【文档正文（节选/全文）】",
    docText || "(空)",
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

async function callDeepSeekDocumentAssist(messages, options = {}) {
  if (!isDeepSeekAssistConfigured()) {
    throw new Error("DeepSeek is not configured. Please set DEEPSEEK_API_KEY and DEEPSEEK_MODEL.");
  }
  const timeoutMs = Number(options.timeoutMs || AI_ASSIST_TIMEOUT_MS || 45000);
  const maxTokens = Number(options.maxTokens || 1800);
  const temperature = Number(options.temperature ?? 0.2);
  const model = String(options.model || DEEPSEEK_MODEL).trim() || DEEPSEEK_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: Math.max(256, Math.min(4096, Math.trunc(maxTokens))),
      }),
      signal: controller.signal,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `DeepSeek request failed with status ${response.status}`;
      throw new Error(message);
    }

    const choice = data?.choices?.[0] || null;
    const content = extractDeepSeekChoiceContent(choice);
    if (!content) {
      const finishReason = String(choice?.finish_reason || "unknown");
      throw new Error(`DeepSeek returned empty content (finish_reason=${finishReason}).`);
    }
    return {
      model: String(data?.model || model),
      usage: data?.usage || null,
      content,
    };
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`DeepSeek request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function writeSseFrame(res, event, payload) {
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function broadcastSpecialBoardUpdate(store) {
  for (const client of [...specialBoardStreamClients]) {
    const ok = writeSseFrame(client, "update", {
      revision: Number(store?.revision || 0),
      updatedAt: String(store?.updatedAt || ""),
      updatedBy: String(store?.updatedBy || ""),
    });
    if (!ok) {
      specialBoardStreamClients.delete(client);
    }
  }
}

function hashPasswordLegacy(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashPassword(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto
    .pbkdf2Sync(String(value), salt, PASSWORD_PBKDF2_ITERATIONS, PASSWORD_PBKDF2_KEYLEN, PASSWORD_PBKDF2_DIGEST)
    .toString("hex");
  return `pbkdf2$${PASSWORD_PBKDF2_ITERATIONS}$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  const raw = String(storedHash || "").trim();
  if (!raw) return { ok: false, needsUpgrade: false };

  if (raw.startsWith("pbkdf2$")) {
    const parts = raw.split("$");
    if (parts.length !== 4) return { ok: false, needsUpgrade: false };

    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expectedHex = parts[3];
    if (!Number.isFinite(iterations) || iterations < 100000 || !salt || !/^[a-f0-9]+$/i.test(expectedHex)) {
      return { ok: false, needsUpgrade: false };
    }

    const actualHex = crypto
      .pbkdf2Sync(String(password), salt, iterations, PASSWORD_PBKDF2_KEYLEN, PASSWORD_PBKDF2_DIGEST)
      .toString("hex");

    const expected = Buffer.from(expectedHex, "hex");
    const actual = Buffer.from(actualHex, "hex");
    if (expected.length !== actual.length || expected.length === 0) {
      return { ok: false, needsUpgrade: false };
    }

    return {
      ok: crypto.timingSafeEqual(expected, actual),
      needsUpgrade: iterations < PASSWORD_PBKDF2_ITERATIONS,
    };
  }

  if (!/^[a-f0-9]{64}$/i.test(raw)) return { ok: false, needsUpgrade: false };
  const expected = Buffer.from(raw.toLowerCase(), "hex");
  const actual = Buffer.from(hashPasswordLegacy(password), "hex");
  if (expected.length !== actual.length || expected.length === 0) {
    return { ok: false, needsUpgrade: false };
  }

  return {
    ok: crypto.timingSafeEqual(expected, actual),
    needsUpgrade: true,
  };
}

function createDefaultUsers() {
  const admin = {
    username: "admin",
    displayName: "System Admin",
    role: "admin",
    department: "Management Center",
    specialBoardAccess: SPECIAL_BOARD_ACCESS_ALL,
    passwordHash: hashPassword("Admin@123"),
  };

  const departmentUsers = DEPARTMENTS.map((department, index) => {
    const no = String(index + 1).padStart(2, "0");
    return {
      username: `dept${no}`,
      displayName: `${department} Officer`,
      role: "editor",
      department,
      specialBoardAccess: SPECIAL_BOARD_ACCESS_OWN,
      passwordHash: hashPassword(`Dept${no}@123`),
    };
  });

  return [admin, ...departmentUsers];
}

function normalizeUserRecord(user) {
  const role = user?.role === "admin" ? "admin" : user?.role === "viewer" ? "viewer" : "editor";
  const accessRaw = String(user?.specialBoardAccess || "").trim().toLowerCase();
  return {
    username: String(user?.username || "").trim(),
    displayName: String(user?.displayName || user?.username || "").trim(),
    role,
    department: String(user?.department || "").trim(),
    specialBoardAccess:
      role === "admin" || accessRaw === SPECIAL_BOARD_ACCESS_ALL ? SPECIAL_BOARD_ACCESS_ALL : SPECIAL_BOARD_ACCESS_OWN,
    passwordHash: String(user?.passwordHash || "").trim(),
  };
}

function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(createDefaultUsers(), null, 2), "utf8");
  }
}

function readUsers() {
  ensureUsersFile();
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"))
      .map(normalizeUserRecord)
      .filter((item) => item.username && item.passwordHash);
  } catch (_) {
    return [];
  }
}

function saveUsers(users) {
  const normalized = Array.isArray(users) ? users.map(normalizeUserRecord) : [];
  fs.writeFileSync(USERS_FILE, JSON.stringify(normalized, null, 2), "utf8");
}

function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    department: user.department || "",
    specialBoardAccess:
      String(user.specialBoardAccess || "").toLowerCase() === SPECIAL_BOARD_ACCESS_ALL
        ? SPECIAL_BOARD_ACCESS_ALL
        : SPECIAL_BOARD_ACCESS_OWN,
  };
}

function sanitizeId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || `doc-${Date.now()}`;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_) {
    return String(value || "");
  }
}

function documentPath(id) {
  return path.join(DOCUMENTS_DIR, `${sanitizeId(id)}.json`);
}

function historyDir(id) {
  return path.join(HISTORY_DIR, sanitizeId(id));
}

function metadataPath(id) {
  return path.join(METADATA_DIR, `${sanitizeId(id)}.json`);
}

function normalizeSpecialBoardData(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const depts = Array.isArray(raw.depts) ? raw.depts.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const arch = Array.isArray(raw.arch) ? raw.arch : [];
  const plans = Array.isArray(raw.plans) ? raw.plans : [];
  const notes =
    raw.notes && typeof raw.notes === "object"
      ? raw.notes
      : { depts: "", modules: "", flows: "", sipoc: "", drafting: "", final: "", published: "" };
  const deptOrg = raw.deptOrg && typeof raw.deptOrg === "object" ? raw.deptOrg : {};
  return {
    depts,
    arch,
    notes,
    plans,
    deptOrg,
  };
}

function hasSpecialBoardData(input = {}) {
  const data = normalizeSpecialBoardData(input);
  return Boolean(
    data.depts.length ||
      data.arch.length ||
      data.plans.length ||
      Object.keys(data.deptOrg || {}).length ||
      Object.values(data.notes || {}).some((value) => String(value || "").trim())
  );
}

function normalizeDepartmentName(value) {
  return String(value || "").trim();
}

function canViewAllSpecialBoard(user) {
  if (isAdmin(user)) return true;
  return String(user?.specialBoardAccess || "").trim().toLowerCase() === SPECIAL_BOARD_ACCESS_ALL;
}

function filterSpecialBoardDeptOrgByDepartment(rawDeptOrg = {}, department = "") {
  const deptOrg = rawDeptOrg && typeof rawDeptOrg === "object" ? rawDeptOrg : {};
  const dept = normalizeDepartmentName(department);
  if (!dept) return {};
  const allowed = new Set([dept]);
  let cursor = dept;
  let guard = 0;
  while (guard < 64) {
    guard += 1;
    const node = deptOrg[cursor];
    if (!node || typeof node !== "object") break;
    const parent = normalizeDepartmentName(node.parent);
    if (!parent || allowed.has(parent)) break;
    allowed.add(parent);
    cursor = parent;
  }
  const next = {};
  for (const name of allowed) {
    if (Object.prototype.hasOwnProperty.call(deptOrg, name)) {
      next[name] = deptOrg[name];
    }
  }
  return next;
}

function filterSpecialBoardDataByDepartment(input = {}, department = "") {
  const data = normalizeSpecialBoardData(input);
  const dept = normalizeDepartmentName(department);
  if (!dept) return normalizeSpecialBoardData({});

  const deptInData = data.depts.some((item) => normalizeDepartmentName(item) === dept);
  const ownArch = data.arch.filter((item) => normalizeDepartmentName(item?.dept) === dept);
  const ownPlans = data.plans.filter((item) => normalizeDepartmentName(item?.dept) === dept);

  const depts = deptInData || ownArch.length || ownPlans.length ? [dept] : [];
  return {
    depts,
    arch: ownArch,
    notes: data.notes,
    plans: ownPlans,
    deptOrg: filterSpecialBoardDeptOrgByDepartment(data.deptOrg, dept),
  };
}

function buildSpecialBoardStoreForUser(store, user) {
  const normalizedStore = {
    revision: Number(store?.revision || 0),
    updatedAt: String(store?.updatedAt || ""),
    updatedBy: String(store?.updatedBy || ""),
    data: normalizeSpecialBoardData(store?.data),
  };
  if (canViewAllSpecialBoard(user)) return normalizedStore;
  return {
    ...normalizedStore,
    data: filterSpecialBoardDataByDepartment(normalizedStore.data, user?.department),
  };
}

function mergeSpecialBoardDataByDepartment(currentInput = {}, incomingInput = {}, department = "") {
  const dept = normalizeDepartmentName(department);
  const current = normalizeSpecialBoardData(currentInput);
  const incoming = normalizeSpecialBoardData(incomingInput);
  if (!dept) return current;

  const incomingOwnArch = incoming.arch.filter((item) => normalizeDepartmentName(item?.dept) === dept);
  const incomingOwnPlans = incoming.plans.filter((item) => normalizeDepartmentName(item?.dept) === dept);

  const nextDepts = Array.isArray(current.depts) ? [...current.depts] : [];
  if (
    !nextDepts.some((item) => normalizeDepartmentName(item) === dept) &&
    (incomingOwnArch.length || incomingOwnPlans.length || incoming.depts.some((item) => normalizeDepartmentName(item) === dept))
  ) {
    nextDepts.push(dept);
  }

  const nextDeptOrg = { ...(current.deptOrg || {}) };
  if (incoming.deptOrg && Object.prototype.hasOwnProperty.call(incoming.deptOrg, dept)) {
    const incomingDeptNode = incoming.deptOrg[dept];
    if (incomingDeptNode && typeof incomingDeptNode === "object") nextDeptOrg[dept] = incomingDeptNode;
    else delete nextDeptOrg[dept];
  }

  return {
    depts: nextDepts,
    arch: [...current.arch.filter((item) => normalizeDepartmentName(item?.dept) !== dept), ...incomingOwnArch],
    notes: current.notes,
    plans: [...current.plans.filter((item) => normalizeDepartmentName(item?.dept) !== dept), ...incomingOwnPlans],
    deptOrg: nextDeptOrg,
  };
}

function validateSpecialBoardScopedPayloadForDepartment(input = {}, department = "") {
  const dept = normalizeDepartmentName(department);
  if (!dept) return { ok: false, reason: "missing_department" };
  const data = normalizeSpecialBoardData(input);

  const deptsOk = data.depts.every((item) => normalizeDepartmentName(item) === dept);
  if (!deptsOk) return { ok: false, reason: "depts_mismatch" };

  const archOk = data.arch.every((item) => normalizeDepartmentName(item?.dept) === dept);
  if (!archOk) return { ok: false, reason: "arch_mismatch" };

  const plansOk = data.plans.every((item) => normalizeDepartmentName(item?.dept) === dept);
  if (!plansOk) return { ok: false, reason: "plans_mismatch" };

  const deptOrgKeys = Object.keys(data.deptOrg || {});
  const deptOrgOk = deptOrgKeys.every((key) => normalizeDepartmentName(key) === dept);
  if (!deptOrgOk) return { ok: false, reason: "dept_org_mismatch" };

  // 保护：如果 payload 里完全没有当前部门痕迹，拒绝写入，避免“账号被切换”导致覆盖他部门数据
  const hasDeptMarker = Boolean(
    data.depts.some((item) => normalizeDepartmentName(item) === dept) ||
      data.arch.some((item) => normalizeDepartmentName(item?.dept) === dept) ||
      data.plans.some((item) => normalizeDepartmentName(item?.dept) === dept) ||
      Object.prototype.hasOwnProperty.call(data.deptOrg || {}, dept)
  );
  if (!hasDeptMarker) return { ok: false, reason: "no_scope_marker" };

  return { ok: true, reason: "" };
}

function getSpecialBoardNodePdf(node) {
  if (!node || typeof node !== "object") return null;
  if (!node.pdf || typeof node.pdf !== "object") return null;
  return node.pdf;
}

function isInlinePdfAttachment(pdf) {
  const data = String(pdf?.data || "");
  return data.startsWith("data:application/pdf;base64,") || data.startsWith("data:application/octet-stream;base64,");
}

function normalizePdfAttachmentMeta(pdf = {}) {
  if (!pdf || typeof pdf !== "object") return null;
  const key = String(pdf.key || "").trim();
  const name = sanitizeUploadFileName(pdf.name || "attachment.pdf");
  const size = Number(pdf.size || 0);
  const date = String(pdf.date || "").trim();
  const providerRaw = String(pdf.provider || "").trim().toLowerCase();
  const provider = providerRaw === "cos" || providerRaw === "local" ? providerRaw : "local";
  if (!key && !String(pdf.data || "").trim()) return null;
  const result = {
    name,
  };
  if (key) {
    result.provider = provider;
    result.key = key;
    result.size = Number.isFinite(size) && size > 0 ? Math.trunc(size) : undefined;
    result.date = date || new Date().toISOString().slice(0, 10);
    result.downloadUrl = buildSpecialBoardPdfDownloadUrl({ key, name });
  }
  return result;
}

async function migrateInlinePdfForNode(node, username, stats) {
  const pdf = getSpecialBoardNodePdf(node);
  if (!pdf) return;
  if (!isInlinePdfAttachment(pdf)) {
    const normalized = normalizePdfAttachmentMeta(pdf);
    if (normalized) node.pdf = normalized;
    return;
  }
  if (!isServerAttachmentEnabled()) return;

  const uploaded = await putPdfAttachment(pdf.name || "attachment.pdf", pdf.data, username);
  node.pdf = {
    ...uploaded,
    downloadUrl: buildSpecialBoardPdfDownloadUrl(uploaded),
  };
  if (stats) {
    stats.migratedCount += 1;
    stats.migratedBytes += Number(uploaded.size || 0);
  }
}

async function migrateInlinePdfInSpecialBoardData(data, username, stats = null) {
  const normalized = normalizeSpecialBoardData(data);
  const localStats =
    stats ||
    {
      migratedCount: 0,
      migratedBytes: 0,
    };

  for (const module of normalized.arch) {
    await migrateInlinePdfForNode(module, username, localStats);
    if (Array.isArray(module?.subs)) {
      for (const sub of module.subs) {
        await migrateInlinePdfForNode(sub, username, localStats);
      }
    }
  }
  return { data: normalized, stats: localStats };
}

function readSpecialBoardStoreFromFile() {
  if (!fs.existsSync(SPECIAL_BOARD_FILE)) {
    return { revision: 0, updatedAt: "", updatedBy: "", data: normalizeSpecialBoardData({}) };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SPECIAL_BOARD_FILE, "utf8"));
    const parsedRevision = Number(raw.revision);
    const revision =
      Number.isFinite(parsedRevision) && parsedRevision >= 0
        ? Math.trunc(parsedRevision)
        : raw.updatedAt
          ? 1
          : 0;
    return {
      revision,
      updatedAt: String(raw.updatedAt || ""),
      updatedBy: String(raw.updatedBy || ""),
      data: normalizeSpecialBoardData(raw.data),
    };
  } catch (_) {
    return { revision: 0, updatedAt: "", updatedBy: "", data: normalizeSpecialBoardData({}) };
  }
}

function isCosAttachmentConfigured() {
  return Boolean(COS_SECRET_ID && COS_SECRET_KEY && COS_BUCKET && COS_REGION);
}

function isLocalAttachmentEnabled() {
  return SPECIAL_BOARD_PDF_PROVIDER === "local";
}

function isCosAttachmentEnabled() {
  return SPECIAL_BOARD_PDF_PROVIDER === "cos" && isCosAttachmentConfigured();
}

function isServerAttachmentEnabled() {
  return isLocalAttachmentEnabled() || isCosAttachmentEnabled();
}

function getCosClient() {
  if (cosClient) return cosClient;
  if (!isCosAttachmentEnabled()) {
    throw new Error("COS attachment is not configured. Please set COS_* env vars.");
  }
  let COSCtor = null;
  try {
    COSCtor = require("cos-nodejs-sdk-v5");
  } catch (_) {
    throw new Error("COS SDK missing. Run: npm install cos-nodejs-sdk-v5");
  }
  cosClient = new COSCtor({
    SecretId: COS_SECRET_ID,
    SecretKey: COS_SECRET_KEY,
  });
  return cosClient;
}

function sanitizeUploadFileName(fileName) {
  const base = path.basename(String(fileName || "attachment.pdf")).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function parsePdfDataUrl(dataUrl) {
  const text = String(dataUrl || "");
  const match = text.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error("Invalid data URL payload");
  }
  const mime = String(match[1] || "").toLowerCase();
  if (!mime.includes("pdf")) {
    throw new Error("Only PDF data URL is allowed");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("Empty PDF payload");
  }
  if (buffer.length > SPECIAL_BOARD_PDF_MAX_BYTES) {
    throw new Error(`PDF is too large (max ${SPECIAL_BOARD_PDF_MAX_BYTES} bytes)`);
  }
  return { buffer, mime };
}

function buildSpecialBoardAttachmentKey(fileName, username = "user") {
  const safeName = sanitizeUploadFileName(fileName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const token = crypto.randomBytes(5).toString("hex");
  const safeUser = String(username || "user").replace(/[^\w.\-]/g, "_");
  return `${SPECIAL_BOARD_ATTACHMENT_PREFIX}/${safeUser}/${stamp}-${token}-${safeName}`;
}

function resolveLocalAttachmentPathFromKey(key) {
  const raw = String(key || "").trim().replace(/\\/g, "/");
  const normalized = path.posix.normalize(raw).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.includes("\0")) return null;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  const base = path.resolve(SPECIAL_BOARD_LOCAL_ATTACHMENT_DIR);
  const absPath = path.resolve(base, normalized);
  if (absPath !== base && !absPath.startsWith(base + path.sep)) return null;
  return { key: normalized, absPath };
}

function buildSpecialBoardPdfDownloadUrl(pdf = {}) {
  if (!pdf || typeof pdf !== "object" || !pdf.key) return "";
  return `/api/special-board/pdf/download?key=${encodeURIComponent(String(pdf.key))}&name=${encodeURIComponent(
    String(pdf.name || "attachment.pdf")
  )}`;
}

async function putPdfToCos(fileName, dataUrl, username) {
  const client = getCosClient();
  const { buffer } = parsePdfDataUrl(dataUrl);
  const key = buildSpecialBoardAttachmentKey(fileName, username);
  await new Promise((resolve, reject) => {
    client.putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key,
        Body: buffer,
        ContentType: "application/pdf",
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });

  const now = new Date().toISOString();
  return {
    provider: "cos",
    key,
    name: sanitizeUploadFileName(fileName),
    size: buffer.length,
    date: now.slice(0, 10),
    uploadedAt: now,
    uploadedBy: String(username || "system"),
  };
}

async function putPdfToLocal(fileName, dataUrl, username) {
  const { buffer } = parsePdfDataUrl(dataUrl);
  const localKey = buildSpecialBoardAttachmentKey(fileName, username);
  const resolved = resolveLocalAttachmentPathFromKey(localKey);
  if (!resolved) {
    throw new Error("Invalid local attachment key");
  }
  fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
  fs.writeFileSync(resolved.absPath, buffer);

  const now = new Date().toISOString();
  return {
    provider: "local",
    key: resolved.key,
    name: sanitizeUploadFileName(fileName),
    size: buffer.length,
    date: now.slice(0, 10),
    uploadedAt: now,
    uploadedBy: String(username || "system"),
  };
}

async function putPdfAttachment(fileName, dataUrl, username) {
  if (isCosAttachmentEnabled()) return putPdfToCos(fileName, dataUrl, username);
  if (isLocalAttachmentEnabled()) return putPdfToLocal(fileName, dataUrl, username);
  throw new Error("PDF attachment storage is not enabled");
}

async function removePdfFromCosByKey(key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) return;
  const client = getCosClient();
  await new Promise((resolve, reject) => {
    client.deleteObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: trimmed,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
}

async function removePdfFromLocalByKey(key) {
  const resolved = resolveLocalAttachmentPathFromKey(key);
  if (!resolved) return;
  try {
    fs.unlinkSync(resolved.absPath);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
}

async function removePdfAttachmentByKey(key) {
  if (isCosAttachmentEnabled()) return removePdfFromCosByKey(key);
  if (isLocalAttachmentEnabled()) return removePdfFromLocalByKey(key);
  throw new Error("PDF attachment storage is not enabled");
}

async function buildSignedCosGetUrl(key, expiresSeconds = 600) {
  const trimmed = String(key || "").trim();
  if (!trimmed) throw new Error("Missing attachment key");
  const client = getCosClient();
  return new Promise((resolve, reject) => {
    client.getObjectUrl(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: trimmed,
        Sign: true,
        Expires: Number(expiresSeconds || 600),
      },
      (error, data) => {
        if (error) reject(error);
        else resolve(data?.Url || "");
      }
    );
  });
}

async function readPdfAttachmentForDownload(key) {
  if (isCosAttachmentEnabled()) {
    const signedUrl = await buildSignedCosGetUrl(key, 600);
    return { type: "redirect", url: signedUrl };
  }
  if (isLocalAttachmentEnabled()) {
    const resolved = resolveLocalAttachmentPathFromKey(key);
    if (!resolved || !fs.existsSync(resolved.absPath)) return { type: "missing" };
    const buffer = fs.readFileSync(resolved.absPath);
    return { type: "buffer", buffer };
  }
  return { type: "disabled" };
}

function buildSpecialBoardChangesPayloadFromStore(store, queryRevision, includeData = false) {
  const parsedRevision = Number(queryRevision);
  const knownRevision = Number.isFinite(parsedRevision) ? Math.max(0, Math.trunc(parsedRevision)) : null;
  const changed = knownRevision === null || store.revision > knownRevision;

  return {
    changed,
    revision: Number(store.revision || 0),
    updatedAt: String(store.updatedAt || ""),
    updatedBy: String(store.updatedBy || ""),
    ...(changed && includeData ? { data: store.data } : {}),
  };
}

function writeSpecialBoardStoreToFile(data, user, options = {}) {
  const current = readSpecialBoardStoreFromFile();
  let normalizedData = normalizeSpecialBoardData(data);
  if (options.scopeDepartment) {
    normalizedData = mergeSpecialBoardDataByDepartment(current.data, normalizedData, options.scopeDepartment);
  }
  const currentHasData = hasSpecialBoardData(current.data);
  const incomingHasData = hasSpecialBoardData(normalizedData);
  if (currentHasData && !incomingHasData && !options.allowEmptyOverwrite) {
    return { conflict: true, current, blockedEmptyOverwrite: true };
  }

  const hasExpectedRevision =
    options.expectedRevision !== undefined &&
    options.expectedRevision !== null &&
    options.expectedRevision !== "";
  if (hasExpectedRevision) {
    const expectedRevision = Number(options.expectedRevision);
    if (Number.isFinite(expectedRevision) && expectedRevision >= 0 && Math.trunc(expectedRevision) !== current.revision) {
      return { conflict: true, current };
    }
  }

  const payload = {
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: String(user?.username || "system"),
    data: normalizedData,
  };
  fs.writeFileSync(SPECIAL_BOARD_FILE, JSON.stringify(payload, null, 2), "utf8");
  broadcastSpecialBoardUpdate(payload);
  return { conflict: false, current: payload };
}

function getSpecialBoardPgPool() {
  if (specialBoardPgPool) return specialBoardPgPool;
  let PoolCtor = null;
  try {
    ({ Pool: PoolCtor } = require("pg"));
  } catch (error) {
    throw new Error("SPECIAL_BOARD_STORAGE=postgres requires package 'pg'. Run: npm install pg");
  }

  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  const poolConfig = hasDatabaseUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: PG_SSL ? { rejectUnauthorized: false } : false,
      }
    : {
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || "sop_company_app",
        user: process.env.PGUSER || "sopapp",
        password: process.env.PGPASSWORD || "",
        ssl: PG_SSL ? { rejectUnauthorized: false } : false,
      };
  specialBoardPgPool = new PoolCtor(poolConfig);
  return specialBoardPgPool;
}

async function ensureSpecialBoardDbReady() {
  if (specialBoardDbReady) return;
  const pool = getSpecialBoardPgPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS special_board_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision BIGINT NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        data JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query(`
      INSERT INTO special_board_state (id, revision, updated_at, updated_by, data)
      VALUES (1, 0, '', '', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);

    // one-time seed from legacy file if DB is still empty
    const rowRes = await client.query(
      "SELECT revision, updated_at, updated_by, data FROM special_board_state WHERE id = 1 LIMIT 1"
    );
    const row = rowRes.rows[0] || null;
    const dbRevision = row ? Number(row.revision || 0) : 0;
    const dbHasData = hasSpecialBoardData(row?.data || {});
    if (dbRevision <= 0 && !dbHasData && fs.existsSync(SPECIAL_BOARD_FILE)) {
      const fileStore = readSpecialBoardStoreFromFile();
      if (Number(fileStore.revision || 0) > 0 || hasSpecialBoardData(fileStore.data)) {
        await client.query(
          `
            UPDATE special_board_state
               SET revision = $1,
                   updated_at = $2,
                   updated_by = $3,
                   data = $4::jsonb
             WHERE id = 1
          `,
          [
            Number(fileStore.revision || 0),
            String(fileStore.updatedAt || ""),
            String(fileStore.updatedBy || ""),
            JSON.stringify(normalizeSpecialBoardData(fileStore.data)),
          ]
        );
      }
    }
    specialBoardDbReady = true;
  } finally {
    client.release();
  }
}

function normalizeSpecialBoardRow(row) {
  return {
    revision: Number(row?.revision || 0),
    updatedAt: String(row?.updated_at || ""),
    updatedBy: String(row?.updated_by || ""),
    data: normalizeSpecialBoardData(row?.data),
  };
}

async function readSpecialBoardStore() {
  if (SPECIAL_BOARD_STORAGE !== "postgres") {
    return readSpecialBoardStoreFromFile();
  }
  await ensureSpecialBoardDbReady();
  const pool = getSpecialBoardPgPool();
  const result = await pool.query(
    "SELECT revision, updated_at, updated_by, data FROM special_board_state WHERE id = 1 LIMIT 1"
  );
  if (!result.rows.length) {
    return { revision: 0, updatedAt: "", updatedBy: "", data: normalizeSpecialBoardData({}) };
  }
  return normalizeSpecialBoardRow(result.rows[0]);
}

async function buildSpecialBoardChangesPayload(queryRevision, includeData = false, user = null) {
  const store = await readSpecialBoardStore();
  const visibleStore = includeData ? buildSpecialBoardStoreForUser(store, user) : store;
  return buildSpecialBoardChangesPayloadFromStore(visibleStore, queryRevision, includeData);
}

async function writeSpecialBoardStore(data, user, options = {}) {
  const migrated = await migrateInlinePdfInSpecialBoardData(data, String(user?.username || "system"));
  const preparedData = migrated.data;

  if (SPECIAL_BOARD_STORAGE !== "postgres") {
    return writeSpecialBoardStoreToFile(preparedData, user, options);
  }

  await ensureSpecialBoardDbReady();
  const pool = getSpecialBoardPgPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentRes = await client.query(
      "SELECT revision, updated_at, updated_by, data FROM special_board_state WHERE id = 1 FOR UPDATE"
    );
    const current = normalizeSpecialBoardRow(currentRes.rows[0] || {});
    let normalizedData = normalizeSpecialBoardData(preparedData);
    if (options.scopeDepartment) {
      normalizedData = mergeSpecialBoardDataByDepartment(current.data, normalizedData, options.scopeDepartment);
    }
    const currentHasData = hasSpecialBoardData(current.data);
    const incomingHasData = hasSpecialBoardData(normalizedData);
    if (currentHasData && !incomingHasData && !options.allowEmptyOverwrite) {
      await client.query("ROLLBACK");
      return { conflict: true, current, blockedEmptyOverwrite: true };
    }

    const hasExpectedRevision =
      options.expectedRevision !== undefined &&
      options.expectedRevision !== null &&
      options.expectedRevision !== "";
    if (hasExpectedRevision) {
      const expectedRevision = Number(options.expectedRevision);
      if (
        Number.isFinite(expectedRevision) &&
        expectedRevision >= 0 &&
        Math.trunc(expectedRevision) !== Math.trunc(current.revision)
      ) {
        await client.query("ROLLBACK");
        return { conflict: true, current };
      }
    }

    const payload = {
      revision: Math.trunc(Number(current.revision || 0)) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: String(user?.username || "system"),
      data: normalizedData,
    };
    await client.query(
      `
        UPDATE special_board_state
           SET revision = $1,
               updated_at = $2,
               updated_by = $3,
               data = $4::jsonb
         WHERE id = 1
      `,
      [payload.revision, payload.updatedAt, payload.updatedBy, JSON.stringify(payload.data)]
    );
    await client.query("COMMIT");
    broadcastSpecialBoardUpdate(payload);
    return { conflict: false, current: payload };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback error
    }
    throw error;
  } finally {
    client.release();
  }
}

function sendJson(res, statusCode, payload, headers = {}, reqOverride = null) {
  const body = JSON.stringify(payload);
  const req = reqOverride || res.req || null;
  const acceptEncoding = String(req?.headers?.["accept-encoding"] || "");
  const canGzip =
    body.length >= 2048 &&
    /\bgzip\b/i.test(acceptEncoding) &&
    !Object.keys(headers).some((key) => key.toLowerCase() === "content-encoding");

  if (canGzip) {
    const gzipped = zlib.gzipSync(body, { level: 5 });
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
      ...headers,
    });
    res.end(gzipped);
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let done = false;
    let total = 0;
    const chunks = [];

    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };

    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };

    req.on("data", (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        const error = new Error("Request body too large");
        error.code = "BODY_TOO_LARGE";
        fail(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", finish);
    req.on("error", fail);
  });
}

async function readJsonBody(req, res) {
  try {
    const rawBuffer = await readBody(req);
    const encoding = String(req.headers["content-encoding"] || "").toLowerCase();
    let jsonText = "";
    const hasGzipMagic = rawBuffer.length >= 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b;

    if (!encoding || encoding === "identity") {
      if (hasGzipMagic) {
        try {
          jsonText = zlib.gunzipSync(rawBuffer).toString("utf8");
        } catch (_) {
          jsonText = rawBuffer.toString("utf8");
        }
      } else {
        jsonText = rawBuffer.toString("utf8");
      }
    } else if (encoding.includes("gzip")) {
      try {
        jsonText = zlib.gunzipSync(rawBuffer).toString("utf8");
      } catch (_) {
        jsonText = rawBuffer.toString("utf8");
      }
    } else {
      sendJson(res, 415, { error: `Unsupported Content-Encoding: ${encoding}` });
      return { ok: false, body: null };
    }

    try {
      return { ok: true, body: JSON.parse(jsonText) };
    } catch (_) {
      if (!rawBuffer) {
        console.error("[SpecialBoard] empty request body", req.url);
      } else {
        const preview = String(jsonText || "").slice(0, 280).replace(/\r?\n/g, "\\n");
        console.error(`[SpecialBoard] invalid json payload`, {
          url: req.url,
          encoding,
          length: rawBuffer.length,
          preview,
        });
      }
      const trimmed = String(jsonText).trim();
      if (trimmed.charCodeAt(0) === 0xfeff) {
        jsonText = trimmed.slice(1);
      }
      return { ok: true, body: JSON.parse(trimmed) };
    }
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") {
      sendJson(res, 413, { error: `Request body too large (max ${MAX_BODY_SIZE} bytes)` });
    } else {
      sendJson(res, 400, { error: "Invalid JSON payload" });
    }
    return { ok: false, body: null };
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, pair) => {
    const index = pair.indexOf("=");
    if (index === -1) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function buildSessionCookie(token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
  ];

  if (SESSION_COOKIE_SECURE) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function sanitizeUserAgent(value) {
  const ua = String(value || "").trim();
  if (!ua) return "";
  return ua.length > 320 ? ua.slice(0, 320) : ua;
}

function cleanupExpiredSessions(now = Date.now()) {
  for (const [token, session] of sessions.entries()) {
    if (!session || Number(session.expiresAt || 0) <= now) {
      sessions.delete(token);
    }
  }
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE_NAME] || "";
}

function touchSessionByToken(token, req, options = {}) {
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  const now = Date.now();

  if (!session || Number(session.expiresAt || 0) <= now) {
    sessions.delete(token);
    return null;
  }

  session.lastSeenAt = now;
  session.lastPath = String(options.path || req.url || session.lastPath || "");

  const ip = getClientIp(req);
  if (ip) session.ip = ip;
  const userAgent = sanitizeUserAgent(req.headers["user-agent"]);
  if (userAgent) session.userAgent = userAgent;

  if (options.activity) {
    session.lastActivityAt = now;
  }

  return session;
}

function markSessionPresence(req, options = {}) {
  cleanupExpiredSessions();
  const token = getSessionToken(req);
  return touchSessionByToken(token, req, options);
}

function createSession(user, req) {
  const now = Date.now();
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = now + SESSION_TTL_MS;
  sessions.set(token, {
    token,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    department: user.department,
    expiresAt,
    loginAt: now,
    lastSeenAt: now,
    lastActivityAt: now,
    ip: req ? getClientIp(req) : "unknown",
    userAgent: sanitizeUserAgent(req?.headers?.["user-agent"]),
    lastPath: req ? String(req.url || "/api/login") : "/api/login",
  });
  return { token, expiresAt };
}

function getSession(req, options = {}) {
  cleanupExpiredSessions();
  const token = getSessionToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (options.touch === false) return session;
  return touchSessionByToken(token, req, { activity: false, path: options.path });
}

function getUserFromSession(req, options = {}) {
  const session = getSession(req, options);
  if (!session) return null;
  const user = readUsers().find((item) => item.username === session.username);
  return user ? publicUser(user) : null;
}

function loginAttemptKey(req, username) {
  return `${getClientIp(req)}|${String(username || "").trim().toLowerCase() || "-"}`;
}

function cleanupLoginAttempts(now = Date.now()) {
  for (const [key, value] of loginAttempts.entries()) {
    if (!value || typeof value !== "object") {
      loginAttempts.delete(key);
      continue;
    }

    if (value.blockedUntil && value.blockedUntil > now) continue;
    if (now - Number(value.lastAttemptAt || 0) > LOGIN_ATTEMPT_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}

function checkLoginThrottle(req, username) {
  cleanupLoginAttempts();
  const key = loginAttemptKey(req, username);
  const state = loginAttempts.get(key);
  const now = Date.now();
  if (!state || !state.blockedUntil || state.blockedUntil <= now) {
    return { blocked: false, retryAfterMs: 0 };
  }
  return { blocked: true, retryAfterMs: Math.max(0, state.blockedUntil - now) };
}

function recordLoginFailure(req, username) {
  const key = loginAttemptKey(req, username);
  const now = Date.now();
  const current = loginAttempts.get(key);
  let state = current;

  if (!state || now - Number(state.firstAttemptAt || 0) > LOGIN_ATTEMPT_WINDOW_MS) {
    state = {
      count: 0,
      firstAttemptAt: now,
      lastAttemptAt: now,
      blockedUntil: 0,
    };
  }

  state.count += 1;
  state.lastAttemptAt = now;
  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    state.blockedUntil = now + LOGIN_BLOCK_MS;
    state.count = 0;
    state.firstAttemptAt = now;
  }

  loginAttempts.set(key, state);
  return state.blockedUntil > now ? state.blockedUntil - now : 0;
}

function clearLoginAttempts(req, username) {
  loginAttempts.delete(loginAttemptKey(req, username));
}

function normalizeCsvList(input) {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map((item) => String(item).trim()).filter(Boolean)));
  }

  return Array.from(
    new Set(
      String(input || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function normalizeAccess(access = {}) {
  const level = ACCESS_LEVELS.includes(access.level) ? access.level : "company";
  return {
    level,
    editors: normalizeCsvList(access.editors),
    viewers: normalizeCsvList(access.viewers),
  };
}

function normalizeWorkflow(workflow = {}, fallbackUser = null) {
  const status = WORKFLOW_STATUSES.includes(workflow.status) ? workflow.status : "draft";
  return {
    status,
    submittedAt: workflow.submittedAt || "",
    submittedBy: workflow.submittedBy || "",
    reviewedAt: workflow.reviewedAt || "",
    reviewedBy: workflow.reviewedBy || "",
    reviewNote: workflow.reviewNote || "",
    lastActionAt: workflow.lastActionAt || "",
    lastActionBy: workflow.lastActionBy || fallbackUser?.username || "",
  };
}

function normalizeTemplateKey(value, fallback = "standard-sipoc") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "default") return "standard-sipoc";
  if (TEMPLATE_KEYS.includes(raw)) return raw;
  return fallback;
}

function normalizeDocument(raw = {}, fallbackUser = null) {
  const owner = String(raw.owner || fallbackUser?.username || "").trim();
  const department = String(raw.department || fallbackUser?.department || "").trim();
  return {
    id: sanitizeId(raw.id || raw.docNo || raw.title || owner || Date.now()),
    title: String(raw.title || raw.docNo || raw.id || "Untitled Document").trim(),
    docNo: String(raw.docNo || "").trim(),
    version: Number(raw.version || 1),
    saveVersion: Number(raw.saveVersion || 1),
    updatedAt: raw.updatedAt || "",
    updatedBy: String(raw.updatedBy || owner).trim(),
    owner,
    department,
    access: normalizeAccess(raw.access),
    workflow: normalizeWorkflow(raw.workflow, fallbackUser),
    templateKey: normalizeTemplateKey(raw.templateKey, "standard-sipoc"),
    html: String(raw.html || ""),
    source: String(raw.source || "editor"),
  };
}

function isAdmin(user) {
  return !!user && user.role === "admin";
}

function isSameDepartment(user, doc) {
  return !!user && !!doc && !!user.department && user.department === doc.department;
}

function canViewDocument(user, doc) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (doc.owner === user.username) return true;

  const access = normalizeAccess(doc.access);
  if (access.level === "company") return true;
  if (access.editors.includes(user.username) || access.viewers.includes(user.username)) return true;
  if (access.level === "team" && isSameDepartment(user, doc)) return true;
  return false;
}

function canEditDocument(user, rawDoc) {
  if (!user) return false;
  if (isAdmin(user)) return true;

  const doc = normalizeDocument(rawDoc);
  if (doc.workflow.status === "submitted" || doc.workflow.status === "approved") return false;
  if (doc.owner === user.username) return true;

  const access = normalizeAccess(doc.access);
  if (access.editors.includes(user.username)) return true;
  if (access.level === "team" && user.role === "editor" && isSameDepartment(user, doc)) return true;
  return false;
}

function canDeleteDocument(user, rawDoc) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const doc = normalizeDocument(rawDoc);
  return doc.owner === user.username && ["draft", "returned"].includes(doc.workflow.status);
}

function canSubmitDocument(user, rawDoc) {
  if (!user) return false;
  const doc = normalizeDocument(rawDoc);
  return canEditDocument(user, doc) && ["draft", "returned"].includes(doc.workflow.status);
}

function canReviewDocument(user, rawDoc) {
  if (!isAdmin(user)) return false;
  const doc = normalizeDocument(rawDoc);
  return doc.workflow.status === "submitted";
}

function toDocumentListItem(doc, currentUser, stat) {
  return {
    id: doc.id,
    title: doc.title || doc.docNo || doc.id,
    docNo: doc.docNo || "",
    updatedAt: doc.updatedAt || stat.mtime.toISOString(),
    updatedBy: doc.updatedBy || doc.owner || "",
    owner: doc.owner || "",
    department: doc.department || "",
    version: doc.version || 1,
    saveVersion: doc.saveVersion || 1,
    templateKey: normalizeTemplateKey(doc.templateKey, "standard-sipoc"),
    access: normalizeAccess(doc.access),
    workflow: normalizeWorkflow(doc.workflow),
    canEdit: canEditDocument(currentUser, doc),
    canDelete: canDeleteDocument(currentUser, doc),
    canSubmit: canSubmitDocument(currentUser, doc),
    canReview: canReviewDocument(currentUser, doc),
  };
}

function buildDocumentMeta(doc) {
  return {
    id: doc.id,
    title: doc.title || doc.docNo || doc.id,
    docNo: doc.docNo || "",
    version: Number(doc.version || 1),
    saveVersion: Number(doc.saveVersion || 1),
    updatedAt: doc.updatedAt || "",
    updatedBy: doc.updatedBy || doc.owner || "",
    owner: doc.owner || "",
    department: doc.department || "",
    access: normalizeAccess(doc.access),
    workflow: normalizeWorkflow(doc.workflow),
    templateKey: normalizeTemplateKey(doc.templateKey, "standard-sipoc"),
    source: doc.source || "editor",
  };
}

function writeDocumentMeta(doc) {
  fs.writeFileSync(metadataPath(doc.id), JSON.stringify(buildDocumentMeta(doc), null, 2), "utf8");
}

function listStoredDocuments(currentUser) {
  const docFiles = fs.readdirSync(DOCUMENTS_DIR).filter((name) => name.endsWith(".json"));
  const metadataFiles = fs.readdirSync(METADATA_DIR).filter((name) => name.endsWith(".json"));
  const idSet = new Set();

  docFiles.forEach((name) => idSet.add(path.basename(name, ".json")));
  metadataFiles.forEach((name) => idSet.add(path.basename(name, ".json")));

  return Array.from(idSet)
    .map((id) => {
      const filePath = documentPath(id);
      const metaPath = metadataPath(id);
      const hasDoc = fs.existsSync(filePath);
      const hasMeta = fs.existsSync(metaPath);

      // If metadata exists but the main document file is missing, clean stale metadata.
      if (!hasDoc) {
        if (hasMeta) {
          try {
            fs.unlinkSync(metaPath);
          } catch (_) {
          }
        }
        return null;
      }

      try {
        const doc = normalizeDocument(JSON.parse(fs.readFileSync(filePath, "utf8")));
        writeDocumentMeta(doc);
        if (!canViewDocument(currentUser, doc)) return null;
        return toDocumentListItem(doc, currentUser, fs.statSync(filePath));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function readDocumentById(id) {
  const filePath = documentPath(id);
  if (!fs.existsSync(filePath)) return null;
  return normalizeDocument(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function resolveDocumentId(input) {
  const candidate = sanitizeId(input);
  if (fs.existsSync(documentPath(candidate))) return candidate;
  if (!fs.existsSync(DOCUMENTS_DIR)) return candidate;

  const needleRaw = String(input || "").trim().toLowerCase();
  const files = fs.readdirSync(DOCUMENTS_DIR).filter((name) => name.endsWith(".json"));
  for (const name of files) {
    const filePath = path.join(DOCUMENTS_DIR, name);
    try {
      const doc = normalizeDocument(JSON.parse(fs.readFileSync(filePath, "utf8")));
      const keys = [doc.id, doc.docNo, doc.title].filter(Boolean).map((v) => String(v).trim());
      if (keys.some((v) => sanitizeId(v) === candidate)) return sanitizeId(doc.id);
      if (needleRaw && keys.some((v) => v.toLowerCase() === needleRaw)) return sanitizeId(doc.id);
    } catch (_) {
    }
  }

  return candidate;
}

function writeDocument(doc) {
  fs.writeFileSync(documentPath(doc.id), JSON.stringify(doc, null, 2), "utf8");
}

function syncDepartmentForUserDocuments(username, oldDepartment, newDepartment, actor = "system") {
  const userKey = String(username || "").trim();
  if (!userKey || !newDepartment) return 0;
  const oldDept = String(oldDepartment || "").trim();
  const docFiles = fs.readdirSync(DOCUMENTS_DIR).filter((name) => name.endsWith(".json"));
  let changed = 0;

  for (const name of docFiles) {
    const filePath = path.join(DOCUMENTS_DIR, name);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const doc = normalizeDocument(raw);
      if (doc.owner !== userKey && doc.updatedBy !== userKey) continue;
      if (oldDept && String(doc.department || "").trim() !== oldDept) continue;
      if (String(doc.department || "").trim() === newDepartment) continue;

      doc.department = newDepartment;
      doc.updatedAt = new Date().toISOString();
      doc.updatedBy = actor || doc.updatedBy || userKey;
      writeDocument(doc);
      writeDocumentMeta(doc);
      writeDocumentSnapshot(doc, "dept-sync");
      changed += 1;
    } catch (_) {
    }
  }

  return changed;
}

function syncDepartmentForAllDocuments(oldDepartment, newDepartment, actor = "system") {
  const oldDept = String(oldDepartment || "").trim();
  if (!oldDept || !newDepartment || oldDept === newDepartment) return 0;
  const docFiles = fs.readdirSync(DOCUMENTS_DIR).filter((name) => name.endsWith(".json"));
  let changed = 0;

  for (const name of docFiles) {
    const filePath = path.join(DOCUMENTS_DIR, name);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const doc = normalizeDocument(raw);
      if (String(doc.department || "").trim() !== oldDept) continue;

      doc.department = newDepartment;
      doc.updatedAt = new Date().toISOString();
      doc.updatedBy = actor || doc.updatedBy || "system";
      writeDocument(doc);
      writeDocumentMeta(doc);
      writeDocumentSnapshot(doc, "dept-sync");
      changed += 1;
    } catch (_) {
    }
  }

  return changed;
}

function writeDocumentSnapshot(doc, action = "save") {
  const dir = historyDir(doc.id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `v${String(doc.saveVersion || 1).padStart(3, "0")}-${action}-${stamp}.json`;
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(doc, null, 2), "utf8");
}

function listDocumentVersions(id) {
  const dir = historyDir(id);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      const match = name.match(/^v(\d+)-([^-]+)-(.+)\.json$/);
      return {
        file: name,
        version: match ? Number(match[1]) : 0,
        action: match ? match[2] : "save",
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function readDocumentVersionSnapshot(id, fileName) {
  const dir = historyDir(id);
  if (!fs.existsSync(dir)) return null;
  const safeName = path.basename(String(fileName || "").trim());
  if (!safeName || !safeName.endsWith(".json")) return null;
  const fullPath = path.join(dir, safeName);
  if (!fullPath.startsWith(path.resolve(dir)) || !fs.existsSync(fullPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    return normalizeDocument(raw);
  } catch (_) {
    return null;
  }
}

function removeDocumentHistory(id) {
  const dir = historyDir(id);
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
  }
}

function ensureDocumentHasHistorySnapshot(doc) {
  const versions = listDocumentVersions(doc.id);
  if (versions.length > 0) return versions;
  writeDocumentSnapshot(doc, "save");
  return listDocumentVersions(doc.id);
}

function buildDocumentPayload(doc, user) {
  return {
    ...doc,
    access: normalizeAccess(doc.access),
    workflow: normalizeWorkflow(doc.workflow),
    canEdit: canEditDocument(user, doc),
    canDelete: canDeleteDocument(user, doc),
    canSubmit: canSubmitDocument(user, doc),
    canReview: canReviewDocument(user, doc),
    currentUser: publicUser(user),
  };
}

function normalizeAccessForUser(user, access = {}) {
  const normalized = normalizeAccess(access);
  if (!isAdmin(user) && normalized.level === "company") {
    normalized.level = "team";
  }
  return normalized;
}

function requireAuth(req, res, options = {}) {
  const user = getUserFromSession(req, { touch: true, path: options.path });
  if (!user) {
    sendJson(res, 401, { error: "Please login first" });
    return null;
  }
  const shouldMarkActivity = options.markActivity === undefined ? req.method !== "GET" : !!options.markActivity;
  if (shouldMarkActivity) {
    markSessionPresence(req, { activity: true, path: options.path });
  }
  return user;
}

function formatIsoFromTs(timestamp) {
  const value = Number(timestamp || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Date(value).toISOString();
}

function buildOnlineSessionsPayload(currentToken = "") {
  const now = Date.now();
  cleanupExpiredSessions(now);
  const users = readUsers();
  const userMap = new Map(users.map((item) => [item.username, publicUser(item)]));
  const byUserMap = new Map();
  const onlineSessions = [];

  for (const session of sessions.values()) {
    const seenAt = Number(session.lastSeenAt || session.loginAt || 0);
    const activityAt = Number(session.lastActivityAt || session.loginAt || 0);
    const online = now - seenAt <= SESSION_ONLINE_WINDOW_MS;
    if (!online) continue;

    const active = now - activityAt <= SESSION_ACTIVE_WINDOW_MS;
    const userInfo = userMap.get(session.username) || {
      username: session.username,
      displayName: session.displayName || session.username,
      role: session.role || "editor",
      department: session.department || "",
      specialBoardAccess: SPECIAL_BOARD_ACCESS_OWN,
    };

    const item = {
      id: String(session.token || "").slice(0, 12),
      username: userInfo.username,
      displayName: userInfo.displayName || userInfo.username,
      department: userInfo.department || "",
      role: userInfo.role || "editor",
      specialBoardAccess: userInfo.specialBoardAccess || SPECIAL_BOARD_ACCESS_OWN,
      ip: session.ip || "",
      userAgent: session.userAgent || "",
      loginAt: formatIsoFromTs(session.loginAt),
      lastSeenAt: formatIsoFromTs(seenAt),
      lastActivityAt: formatIsoFromTs(activityAt),
      idleSeconds: Math.max(0, Math.round((now - seenAt) / 1000)),
      activeSeconds: Math.max(0, Math.round((now - activityAt) / 1000)),
      current: Boolean(currentToken) && currentToken === session.token,
      active,
    };
    onlineSessions.push(item);

    if (!byUserMap.has(item.username)) {
      byUserMap.set(item.username, {
        username: item.username,
        displayName: item.displayName,
        department: item.department,
        role: item.role,
        specialBoardAccess: item.specialBoardAccess,
        onlineSessions: 0,
        activeSessions: 0,
        ips: new Set(),
        latestSeenAtMs: 0,
        latestActivityAtMs: 0,
      });
    }

    const bucket = byUserMap.get(item.username);
    bucket.onlineSessions += 1;
    if (item.active) bucket.activeSessions += 1;
    if (item.ip) bucket.ips.add(item.ip);
    bucket.latestSeenAtMs = Math.max(bucket.latestSeenAtMs, seenAt);
    bucket.latestActivityAtMs = Math.max(bucket.latestActivityAtMs, activityAt);
  }

  const byUser = Array.from(byUserMap.values())
    .map((item) => ({
      username: item.username,
      displayName: item.displayName,
      department: item.department,
      role: item.role,
      specialBoardAccess: item.specialBoardAccess,
      onlineSessions: item.onlineSessions,
      activeSessions: item.activeSessions,
      ipCount: item.ips.size,
      ips: Array.from(item.ips).sort(),
      latestSeenAt: formatIsoFromTs(item.latestSeenAtMs),
      latestActivityAt: formatIsoFromTs(item.latestActivityAtMs),
    }))
    .sort((a, b) => {
      if (b.onlineSessions !== a.onlineSessions) return b.onlineSessions - a.onlineSessions;
      return a.username.localeCompare(b.username, "zh-Hans-CN");
    });

  onlineSessions.sort((a, b) => {
    const bSeen = Date.parse(b.lastSeenAt || 0);
    const aSeen = Date.parse(a.lastSeenAt || 0);
    if (bSeen !== aSeen) return bSeen - aSeen;
    return a.username.localeCompare(b.username, "zh-Hans-CN");
  });

  return {
    ok: true,
    now: new Date(now).toISOString(),
    windows: {
      onlineMs: SESSION_ONLINE_WINDOW_MS,
      activeMs: SESSION_ACTIVE_WINDOW_MS,
    },
    summary: {
      onlineSessions: onlineSessions.length,
      activeSessions: onlineSessions.filter((item) => item.active).length,
      onlineAccounts: byUser.length,
      multiLoginAccounts: byUser.filter((item) => item.onlineSessions > 1).length,
    },
    byUser,
    sessions: onlineSessions,
  };
}

function serveStatic(reqPath, res) {
  const pathname = reqPath === "/" ? "/index.html" : decodeURIComponent(reqPath);
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = [".html", ".js", ".json", ".webmanifest"].includes(ext)
      ? "no-cache"
      : "public, max-age=3600";

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleLogin(req, res) {
  const bodyState = await readJsonBody(req, res);
  if (!bodyState.ok) return;
  const body = bodyState.body;

  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const throttle = checkLoginThrottle(req, username);
  if (throttle.blocked) {
    sendJson(
      res,
      429,
      { error: "Too many login attempts. Please try again later." },
      { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) }
    );
    return;
  }

  const users = readUsers();
  const user = users.find((item) => item.username === username);
  const passwordCheck = verifyPassword(password, user?.passwordHash || "");

  if (!user || !passwordCheck.ok) {
    const waitMs = recordLoginFailure(req, username);
    if (waitMs > 0) {
      sendJson(
        res,
        429,
        { error: "Too many login attempts. Please try again later." },
        { "Retry-After": String(Math.ceil(waitMs / 1000)) }
      );
      return;
    }
    sendJson(res, 401, { error: "Invalid username or password" });
    return;
  }

  if (passwordCheck.needsUpgrade) {
    const upgradedUsers = users.map((item) =>
      item.username === user.username ? { ...item, passwordHash: hashPassword(password) } : item
    );
    saveUsers(upgradedUsers);
  }

  clearLoginAttempts(req, username);
  const session = createSession(user, req);
  sendJson(
    res,
    200,
    { ok: true, user: publicUser(user) },
    { "Set-Cookie": buildSessionCookie(session.token, Math.floor(SESSION_TTL_MS / 1000)) }
  );
}

function handleLogout(req, res) {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE_NAME]) {
    sessions.delete(cookies[SESSION_COOKIE_NAME]);
  }
  sendJson(res, 200, { ok: true }, { "Set-Cookie": buildSessionCookie("", 0) });
}

async function handleUserAdminUpdate(req, res, adminUser, usernameInput) {
  if (!isAdmin(adminUser)) {
    sendJson(res, 403, { error: "Only admin can update users" });
    return;
  }

  const username = String(usernameInput || "").trim();
  if (!username) {
    sendJson(res, 400, { error: "Invalid username" });
    return;
  }

  const bodyState = await readJsonBody(req, res);
  if (!bodyState.ok) return;
  const body = bodyState.body || {};
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "displayName");
  const hasPassword = Object.prototype.hasOwnProperty.call(body, "password");
  const hasDepartment = Object.prototype.hasOwnProperty.call(body, "department");
  const hasSpecialBoardAccess = Object.prototype.hasOwnProperty.call(body, "specialBoardAccess");
  const syncDepartmentGlobally = body.syncDepartmentGlobally === true;

  if (!hasDisplayName && !hasPassword && !hasDepartment && !hasSpecialBoardAccess) {
    sendJson(res, 400, { error: "No update fields provided" });
    return;
  }

  const users = readUsers();
  const index = users.findIndex((item) => item.username === username);
  if (index < 0) {
    sendJson(res, 404, { error: "User not found" });
    return;
  }

  const next = { ...users[index] };
  const oldDepartment = String(next.department || "").trim();

  if (hasDisplayName) {
    const displayName = String(body.displayName || "").trim();
    if (!displayName) {
      sendJson(res, 400, { error: "Display name cannot be empty" });
      return;
    }
    next.displayName = displayName;
  }
  if (hasPassword) {
    const password = String(body.password || "").trim();
    if (password.length < 8) {
      sendJson(res, 400, { error: "Password must be at least 8 characters" });
      return;
    }
    next.passwordHash = hashPassword(password);
  }
  if (hasDepartment) {
    const department = String(body.department || "").trim();
    if (!department) {
      sendJson(res, 400, { error: "Department cannot be empty" });
      return;
    }
    next.department = department;
  }
  if (hasSpecialBoardAccess) {
    const rawAccess = String(body.specialBoardAccess || "").trim().toLowerCase();
    if (next.role === "admin") {
      next.specialBoardAccess = SPECIAL_BOARD_ACCESS_ALL;
    } else if (rawAccess === SPECIAL_BOARD_ACCESS_ALL || rawAccess === SPECIAL_BOARD_ACCESS_OWN) {
      next.specialBoardAccess = rawAccess;
    } else {
      sendJson(res, 400, { error: "specialBoardAccess must be 'own' or 'all'" });
      return;
    }
  }

  users[index] = normalizeUserRecord(next);

  let usersDepartmentSynced = 0;
  let documentsDepartmentSynced = 0;
  const departmentChanged = hasDepartment && oldDepartment !== users[index].department;
  if (departmentChanged && syncDepartmentGlobally && oldDepartment) {
    const nextDepartment = users[index].department;
    for (let i = 0; i < users.length; i += 1) {
      if (i === index) continue;
      if (String(users[i].department || "").trim() !== oldDepartment) continue;
      users[i] = normalizeUserRecord({ ...users[i], department: nextDepartment });
      usersDepartmentSynced += 1;
    }
    documentsDepartmentSynced = syncDepartmentForAllDocuments(oldDepartment, nextDepartment, adminUser.username);
  } else if (departmentChanged) {
    documentsDepartmentSynced = syncDepartmentForUserDocuments(
      users[index].username,
      oldDepartment,
      users[index].department,
      adminUser.username
    );
  }

  saveUsers(users);
  sendJson(res, 200, {
    ok: true,
    user: publicUser(users[index]),
    departmentSync: departmentChanged
      ? {
          oldDepartment,
          newDepartment: users[index].department,
          global: syncDepartmentGlobally && !!oldDepartment,
          usersSynced: usersDepartmentSynced,
          documentsSynced: documentsDepartmentSynced,
        }
      : null,
  });
}

async function handleDocumentSave(req, res, user) {
  const bodyState = await readJsonBody(req, res);
  if (!bodyState.ok) return;
  const body = bodyState.body;

  const id = sanitizeId(body.id || body.docNo || body.title);
  const now = new Date().toISOString();
  const existing = readDocumentById(id);

  if (existing && !canEditDocument(user, existing)) {
    sendJson(res, 403, { error: "Document is not editable in current workflow state" });
    return;
  }

  const workflow = existing
    ? normalizeWorkflow(existing.workflow, user)
    : normalizeWorkflow({ status: "draft", lastActionAt: now, lastActionBy: user.username }, user);

  const payload = normalizeDocument(
    {
      id,
      title: String(body.title || body.docNo || id).trim(),
      docNo: String(body.docNo || "").trim(),
      version: Number(body.version || existing?.version || 1),
      saveVersion: existing ? Number(existing.saveVersion || 1) + 1 : 1,
      updatedAt: now,
      updatedBy: user.username,
      owner: existing?.owner || user.username,
      department: existing?.department || body.department || user.department || "",
      access: normalizeAccessForUser(user, body.access || existing?.access || { level: "team" }),
      workflow,
      templateKey: normalizeTemplateKey(body.templateKey, existing?.templateKey || "standard-sipoc"),
      html: String(body.html || existing?.html || ""),
      source: body.source || existing?.source || "editor",
    },
    user
  );

  payload.workflow.lastActionAt = now;
  payload.workflow.lastActionBy = user.username;
  writeDocument(payload);
  writeDocumentMeta(payload);
  writeDocumentSnapshot(payload, "save");

  sendJson(res, 200, {
    ok: true,
    id: payload.id,
    updatedAt: payload.updatedAt,
    saveVersion: payload.saveVersion,
    templateKey: normalizeTemplateKey(payload.templateKey, "standard-sipoc"),
    access: payload.access,
    workflow: payload.workflow,
    department: payload.department,
    canEdit: canEditDocument(user, payload),
    canDelete: canDeleteDocument(user, payload),
    canSubmit: canSubmitDocument(user, payload),
    canReview: canReviewDocument(user, payload),
  });
}

async function handleDocumentSubmit(res, user, id) {
  const doc = readDocumentById(id);
  if (!doc) {
    sendJson(res, 404, { error: "Document not found" });
    return;
  }

  if (!canSubmitDocument(user, doc)) {
    sendJson(res, 403, { error: "Document cannot be submitted" });
    return;
  }

  const now = new Date().toISOString();
  doc.updatedAt = now;
  doc.updatedBy = user.username;
  doc.workflow = normalizeWorkflow(doc.workflow, user);
  doc.workflow.status = "submitted";
  doc.workflow.submittedAt = now;
  doc.workflow.submittedBy = user.username;
  doc.workflow.reviewedAt = "";
  doc.workflow.reviewedBy = "";
  doc.workflow.reviewNote = "";
  doc.workflow.lastActionAt = now;
  doc.workflow.lastActionBy = user.username;

  writeDocument(doc);
  writeDocumentMeta(doc);
  writeDocumentSnapshot(doc, "submit");

  sendJson(res, 200, {
    ok: true,
    id: doc.id,
    workflow: doc.workflow,
    canEdit: canEditDocument(user, doc),
    canDelete: canDeleteDocument(user, doc),
    canSubmit: canSubmitDocument(user, doc),
    canReview: canReviewDocument(user, doc),
  });
}

async function handleDocumentReview(req, res, user, id) {
  if (!isAdmin(user)) {
    sendJson(res, 403, { error: "Only admin can review documents" });
    return;
  }

  const bodyState = await readJsonBody(req, res);
  if (!bodyState.ok) return;
  const body = bodyState.body;

  const action = body.action === "approve" ? "approve" : body.action === "return" ? "return" : "";
  if (!action) {
    sendJson(res, 400, { error: "Invalid review action" });
    return;
  }

  const doc = readDocumentById(id);
  if (!doc) {
    sendJson(res, 404, { error: "Document not found" });
    return;
  }

  if (!canReviewDocument(user, doc)) {
    sendJson(res, 403, { error: "Document is not in reviewable state" });
    return;
  }

  const now = new Date().toISOString();
  doc.updatedAt = now;
  doc.updatedBy = user.username;
  doc.workflow = normalizeWorkflow(doc.workflow, user);
  doc.workflow.status = action === "approve" ? "approved" : "returned";
  doc.workflow.reviewedAt = now;
  doc.workflow.reviewedBy = user.username;
  doc.workflow.reviewNote = String(body.note || "").trim();
  doc.workflow.lastActionAt = now;
  doc.workflow.lastActionBy = user.username;

  writeDocument(doc);
  writeDocumentMeta(doc);
  writeDocumentSnapshot(doc, action);

  sendJson(res, 200, {
    ok: true,
    id: doc.id,
    workflow: doc.workflow,
    canEdit: canEditDocument(user, doc),
    canDelete: canDeleteDocument(user, doc),
    canSubmit: canSubmitDocument(user, doc),
    canReview: canReviewDocument(user, doc),
  });
}

async function handleApi(req, url, res) {
  const apiPath = (url.pathname || "").replace(/\/+$/, "");

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: APP_NAME,
      now: new Date().toISOString(),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    await handleLogin(req, res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    handleLogout(req, res);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, { user: getUserFromSession(req) });
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/session/heartbeat") {
    const user = requireAuth(req, res, { markActivity: false, path: "/api/session/heartbeat" });
    if (!user) return true;
    markSessionPresence(req, { activity: false, path: "/api/session/heartbeat" });
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/session/activity") {
    const user = requireAuth(req, res, { markActivity: true, path: "/api/session/activity" });
    if (!user) return true;
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/ai/config") {
    const user = requireAuth(req, res, { markActivity: false, path: "/api/ai/config" });
    if (!user) return true;
    sendJson(res, 200, { ok: true, config: getAiAssistPublicConfig(user) });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/admin/ai/config") {
    const user = requireAuth(req, res, { markActivity: false, path: "/api/admin/ai/config" });
    if (!user) return true;
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: "Only admin can view AI config" });
      return true;
    }
    sendJson(res, 200, { ok: true, config: getAiAssistPublicConfig(user) });
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/admin/ai/config") {
    const user = requireAuth(req, res, { markActivity: true, path: "/api/admin/ai/config" });
    if (!user) return true;
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: "Only admin can update AI config" });
      return true;
    }
    const bodyState = await readJsonBody(req, res);
    if (!bodyState.ok) return true;
    const body = bodyState.body || {};
    const next = {};
    if (Object.prototype.hasOwnProperty.call(body, "enabled")) next.enabled = body.enabled;
    if (Object.prototype.hasOwnProperty.call(body, "allowedModels")) next.allowedModels = body.allowedModels;
    if (Object.prototype.hasOwnProperty.call(body, "defaultModel")) next.defaultModel = body.defaultModel;
    if (Object.prototype.hasOwnProperty.call(body, "dailyLimitPerUser")) next.dailyLimitPerUser = body.dailyLimitPerUser;
    if (Object.prototype.hasOwnProperty.call(body, "dailyLimitPerDept")) next.dailyLimitPerDept = body.dailyLimitPerDept;
    const saved = saveAiAssistSettings(next, user);
    sendJson(res, 200, { ok: true, config: getAiAssistPublicConfig(user), saved });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/admin/ai/audit") {
    const user = requireAuth(req, res, { markActivity: false, path: "/api/admin/ai/audit" });
    if (!user) return true;
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: "Only admin can view AI audit" });
      return true;
    }
    const limit = Number(url.searchParams.get("limit") || 120);
    const items = listAiAssistAudit(limit).map(sanitizeAiAuditForClient);
    sendJson(res, 200, { ok: true, items });
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/ai/document-assist") {
    const user = requireAuth(req, res, { markActivity: true, path: "/api/ai/document-assist" });
    if (!user) return true;

    const bodyState = await readJsonBody(req, res);
    if (!bodyState.ok) return true;

    const body = bodyState.body || {};
    const action = String(body.action || "").trim().toLowerCase();
    const startedAt = Date.now();
    const instruction = sanitizeAiAssistText(body.instruction, 3000);
    const text = sanitizeAiAssistText(body.text, AI_ASSIST_MAX_INPUT_CHARS);
    const requestedModel = String(body.model || "").trim();
    const settings = readAiAssistSettings();
    const selectedModel = requestedModel || settings.defaultModel || DEEPSEEK_MODEL;

    if (!["review", "write"].includes(action)) {
      sendJson(res, 400, { error: "Invalid action. Use 'review' or 'write'." });
      return true;
    }

    if (AI_ASSIST_PROVIDER !== "deepseek") {
      sendJson(res, 400, {
        error: `Unsupported AI provider '${AI_ASSIST_PROVIDER}'. Current implementation supports provider=deepseek.`,
      });
      return true;
    }
    if (!isDeepSeekAssistConfigured()) {
      sendJson(res, 400, {
        error: "AI assistant is not configured. Please set DEEPSEEK_API_KEY and DEEPSEEK_MODEL in /etc/sop-company-app.env.",
      });
      return true;
    }
    if (!settings.enabled) {
      sendJson(res, 403, { error: "AI 助手当前已被管理员关闭" });
      return true;
    }
    if (!settings.allowedModels.includes(selectedModel)) {
      sendJson(res, 400, {
        error: `当前模型不可用。可选模型：${settings.allowedModels.join(", ") || "无"}`,
      });
      return true;
    }
    if (!text || text.length < 20) {
      sendJson(res, 400, { error: "Document text is too short for AI analysis." });
      return true;
    }

    const usageToday = getAiAssistUsageForDay(getTodayKeyLocal());
    const usedByUser = Number(usageToday.byUser[user.username] || 0);
    const userDept = String(user.department || "");
    const usedByDept = Number(usageToday.byDept[userDept] || 0);
    if (Number(settings.dailyLimitPerUser || 0) > 0 && usedByUser >= Number(settings.dailyLimitPerUser || 0)) {
      sendJson(res, 429, { error: "今日 AI 调用次数已达个人上限，请联系管理员调整额度。" });
      return true;
    }
    if (
      userDept &&
      Number(settings.dailyLimitPerDept || 0) > 0 &&
      usedByDept >= Number(settings.dailyLimitPerDept || 0)
    ) {
      sendJson(res, 429, { error: "今日 AI 调用次数已达部门上限，请联系管理员调整额度。" });
      return true;
    }

    const messages = buildDocumentAiMessages(action, body, user);
    const candidateModels = [selectedModel, ...settings.allowedModels.filter((item) => item !== selectedModel)];
    const retryTextCandidates = [
      text,
      sanitizeAiAssistText(body?.text, Math.max(12000, Math.min(32000, AI_ASSIST_MAX_INPUT_CHARS))),
      sanitizeAiAssistText(body?.text, 18000),
      sanitizeAiAssistText(body?.text, 9000),
    ].filter((item, idx, arr) => {
      const value = String(item || "").trim();
      if (!value || value.length < 20) return false;
      return arr.findIndex((probe) => String(probe || "").trim() === value) === idx;
    });
    try {
      let aiResult = null;
      let lastError = null;
      let usedInputChars = text.length;
      let attemptSummary = "";
      for (const candidateModel of candidateModels) {
        for (let i = 0; i < retryTextCandidates.length; i += 1) {
          const attemptText = retryTextCandidates[i];
          const attemptBody = i === 0 && candidateModel === selectedModel ? body : { ...body, text: attemptText };
          const attemptMessages =
            i === 0 && candidateModel === selectedModel
              ? messages
              : buildDocumentAiMessages(action, attemptBody, user);
          try {
            aiResult = await callDeepSeekDocumentAssist(attemptMessages, {
              model: candidateModel,
              temperature: action === "write" ? (i === 0 ? 0.45 : 0.35) : 0.1,
              maxTokens: action === "write" ? (i <= 1 ? 2200 : 1800) : i <= 1 ? 1800 : 1500,
            });
            usedInputChars = attemptText.length;
            const textPolicy = i === 0 ? "full" : `short_${attemptText.length}`;
            attemptSummary = `model=${candidateModel},text=${textPolicy}`;
            break;
          } catch (attemptError) {
            lastError = attemptError;
            const msg = String(attemptError?.message || "");
            const retryable =
              /empty content/i.test(msg) ||
              /finish_reason=unknown/i.test(msg) ||
              /timeout/i.test(msg) ||
              /rate limit/i.test(msg) ||
              /temporar/i.test(msg);
            if (!retryable) break;
          }
        }
        if (aiResult) break;
      }
      if (!aiResult) throw lastError || new Error("AI model did not return content");

      const structured = parseAiAssistStructuredOutput(action, aiResult.content);
      appendAiAssistAudit({
        username: user.username,
        displayName: user.displayName,
        department: user.department,
        role: user.role,
        action,
        model: aiResult.model || selectedModel,
        status: "ok",
        durationMs: Date.now() - startedAt,
        promptChars: instruction.length,
        inputChars: usedInputChars,
        outputChars: String(aiResult.content || "").length,
        promptTokens: Number(aiResult?.usage?.prompt_tokens || 0),
        completionTokens: Number(aiResult?.usage?.completion_tokens || 0),
        totalTokens: Number(aiResult?.usage?.total_tokens || 0),
        ip: getClientIp(req),
        note: attemptSummary,
      });
      sendJson(res, 200, {
        ok: true,
        provider: "deepseek",
        action,
        model: aiResult.model,
        content: aiResult.content,
        displayText: structured.text,
        outputFormat: structured.outputFormat,
        html: structured.html,
        insertHint: structured.insertHint,
        assumptions: structured.assumptions,
        usage: aiResult.usage,
      });
    } catch (error) {
      appendAiAssistAudit({
        username: user.username,
        displayName: user.displayName,
        department: user.department,
        role: user.role,
        action,
        model: selectedModel,
        status: "error",
        durationMs: Date.now() - startedAt,
        promptChars: instruction.length,
        inputChars: text.length,
        error: String(error?.message || error || ""),
        ip: getClientIp(req),
      });
      const errorText = String(error?.message || error || "");
      const friendly = /empty content/i.test(errorText)
        ? "AI assist failed: 模型本次返回空内容，请切换为 deepseek-reasoner 或缩短上下文后重试。"
        : `AI assist failed: ${errorText}`;
      sendJson(res, 502, { error: friendly });
    }
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/special-board/pdf/upload") {
    const user = requireAuth(req, res);
    if (!user) return true;
    if (!isServerAttachmentEnabled()) {
      sendJson(res, 400, {
        error:
          "PDF attachment storage is not configured. Set SPECIAL_BOARD_PDF_PROVIDER=local, or SPECIAL_BOARD_PDF_PROVIDER=cos with COS_* env vars.",
      });
      return true;
    }
    const bodyState = await readJsonBody(req, res);
    if (!bodyState.ok) return true;
    const body = bodyState.body || {};
    const fileName = String(body.fileName || "attachment.pdf");
    const dataUrl = String(body.dataUrl || "");
    if (!dataUrl) {
      sendJson(res, 400, { error: "Missing dataUrl" });
      return true;
    }
    try {
      const uploaded = await putPdfAttachment(fileName, dataUrl, user.username);
      sendJson(res, 200, {
        ok: true,
        file: {
          ...uploaded,
          downloadUrl: buildSpecialBoardPdfDownloadUrl(uploaded),
        },
      });
    } catch (error) {
      sendJson(res, 500, { error: `PDF upload failed: ${error.message || error}` });
    }
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/special-board/pdf/delete") {
    const user = requireAuth(req, res);
    if (!user) return true;
    if (!isServerAttachmentEnabled()) {
      sendJson(res, 400, { error: "PDF attachment storage is not configured" });
      return true;
    }
    const bodyState = await readJsonBody(req, res);
    if (!bodyState.ok) return true;
    const key = String(bodyState.body?.key || "").trim();
    if (!key) {
      sendJson(res, 400, { error: "Missing key" });
      return true;
    }
    try {
      await removePdfAttachmentByKey(key);
      sendJson(res, 200, { ok: true, key });
    } catch (error) {
      sendJson(res, 500, { error: `PDF delete failed: ${error.message || error}` });
    }
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/special-board/pdf/download") {
    const user = requireAuth(req, res);
    if (!user) return true;
    if (!isServerAttachmentEnabled()) {
      sendJson(res, 400, { error: "PDF attachment storage is not configured" });
      return true;
    }
    const key = String(url.searchParams.get("key") || "").trim();
    const name = sanitizeUploadFileName(String(url.searchParams.get("name") || "attachment.pdf"));
    if (!key) {
      sendJson(res, 400, { error: "Missing key" });
      return true;
    }
    try {
      const downloadable = await readPdfAttachmentForDownload(key);
      if (downloadable.type === "missing") {
        sendJson(res, 404, { error: "Attachment not found" });
        return true;
      }
      if (downloadable.type === "redirect") {
        if (!downloadable.url) {
          sendJson(res, 404, { error: "Attachment not found" });
          return true;
        }
        res.writeHead(302, {
          Location: downloadable.url,
          "Cache-Control": "no-store",
        });
        res.end();
        return true;
      }
      if (downloadable.type === "buffer") {
        const contentDisposition = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
          "Content-Disposition": contentDisposition,
          "Content-Length": String(downloadable.buffer.length),
        });
        res.end(downloadable.buffer);
        return true;
      }
      sendJson(res, 400, { error: "PDF attachment storage is not configured" });
    } catch (error) {
      sendJson(res, 500, { error: `PDF download failed: ${error.message || error}` });
    }
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/special-board/migrate-inline-pdf") {
    const user = requireAuth(req, res);
    if (!user) return true;
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: "Only admin can trigger migration" });
      return true;
    }
    if (!isServerAttachmentEnabled()) {
      sendJson(res, 400, { error: "PDF attachment storage is not configured" });
      return true;
    }
    const current = await readSpecialBoardStore();
    const stats = { migratedCount: 0, migratedBytes: 0 };
    const migrated = await migrateInlinePdfInSpecialBoardData(current.data, user.username, stats);
    if (stats.migratedCount <= 0) {
      sendJson(res, 200, { ok: true, migratedCount: 0, migratedBytes: 0, revision: current.revision });
      return true;
    }
    const saved = await writeSpecialBoardStore(migrated.data, user, {
      expectedRevision: current.revision,
      allowEmptyOverwrite: true,
    });
    if (saved.conflict) {
      sendJson(res, 409, { error: "Migration conflict, please retry", conflict: true });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      migratedCount: stats.migratedCount,
      migratedBytes: stats.migratedBytes,
      revision: saved.current.revision,
      updatedAt: saved.current.updatedAt,
    });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/special-board") {
    const user = requireAuth(req, res);
    if (!user) return true;
    const store = await readSpecialBoardStore();
    sendJson(res, 200, { ok: true, ...buildSpecialBoardStoreForUser(store, user) });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/special-board/meta") {
    const user = requireAuth(req, res);
    if (!user) return true;
    const store = await readSpecialBoardStore();
    sendJson(res, 200, {
      ok: true,
      revision: store.revision,
      updatedAt: store.updatedAt,
      updatedBy: store.updatedBy,
    });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/special-board/changes") {
    const user = requireAuth(req, res);
    if (!user) return true;

    const includeData = String(url.searchParams.get("full") || "").toLowerCase() === "1";
    const revision = url.searchParams.get("revision");
    sendJson(
      res,
      200,
      {
        ok: true,
        ...(await buildSpecialBoardChangesPayload(revision, includeData, user)),
      }
    );
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/special-board/stream") {
    const user = requireAuth(req, res);
    if (!user) return true;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    res.write(": connected\n\n");
    const store = await readSpecialBoardStore();
    writeSseFrame(res, "ready", {
      revision: store.revision,
      updatedAt: store.updatedAt,
      updatedBy: store.updatedBy,
    });

    specialBoardStreamClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (_) {
        clearInterval(heartbeat);
        specialBoardStreamClients.delete(res);
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      specialBoardStreamClients.delete(res);
    });
    req.on("error", () => {
      clearInterval(heartbeat);
      specialBoardStreamClients.delete(res);
    });
    return true;
  }

  if (req.method === "POST" && apiPath === "/api/special-board") {
    const user = requireAuth(req, res);
    if (!user) return true;
    const bodyState = await readJsonBody(req, res);
    if (!bodyState.ok) return true;
    const body = bodyState.body || {};
    const baseRevisionRaw = body.baseRevision;
    const baseRevision =
      baseRevisionRaw === undefined || baseRevisionRaw === null || baseRevisionRaw === ""
        ? null
        : Number(baseRevisionRaw);
    const scopeDepartment = isAdmin(user) ? "" : normalizeDepartmentName(user.department);
    if (!isAdmin(user) && !scopeDepartment) {
      sendJson(res, 400, { error: "当前账号未配置部门，无法保存文件专项数据" });
      return true;
    }
    if (!isAdmin(user)) {
      const scopedCheck = validateSpecialBoardScopedPayloadForDepartment(body.data, scopeDepartment);
      if (!scopedCheck.ok) {
        sendJson(res, 409, {
          error: "检测到账号/部门与页面数据不一致，已拒绝保存。请刷新页面并重新登录当前部门后再试。",
          conflict: true,
          scopeMismatch: true,
          reason: scopedCheck.reason,
        });
        return true;
      }
    }
    const saved = await writeSpecialBoardStore(body.data, user, {
      expectedRevision: baseRevision,
      scopeDepartment,
    });
    if (saved.conflict) {
      if (saved.blockedEmptyOverwrite) {
        sendJson(res, 409, {
          error: "Blocked empty payload overwrite to protect existing board data.",
          conflict: true,
          blockedEmptyOverwrite: true,
          currentRevision: saved.current.revision,
          updatedAt: saved.current.updatedAt,
          updatedBy: saved.current.updatedBy,
        });
        return true;
      }
      sendJson(res, 409, {
        error: "Special board has a newer version. Please refresh before saving.",
        conflict: true,
        currentRevision: saved.current.revision,
        updatedAt: saved.current.updatedAt,
        updatedBy: saved.current.updatedBy,
      });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      revision: saved.current.revision,
      updatedAt: saved.current.updatedAt,
      updatedBy: saved.current.updatedBy,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    const user = requireAuth(req, res);
    if (!user) return true;
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: "Only admin can list users" });
      return true;
    }

    sendJson(res, 200, { items: readUsers().map(publicUser) });
    return true;
  }

  if (req.method === "GET" && apiPath === "/api/admin/online-sessions") {
    const user = requireAuth(req, res, { markActivity: false, path: "/api/admin/online-sessions" });
    if (!user) return true;
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: "Only admin can view online sessions" });
      return true;
    }
    const currentToken = getSessionToken(req);
    sendJson(res, 200, buildOnlineSessionsPayload(currentToken));
    return true;
  }

  const userUpdateMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (req.method === "POST" && userUpdateMatch) {
    const user = requireAuth(req, res);
    if (!user) return true;
    await handleUserAdminUpdate(req, res, user, safeDecodeURIComponent(userUpdateMatch[1]));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/documents") {
    const user = requireAuth(req, res);
    if (!user) return true;
    sendJson(res, 200, { items: listStoredDocuments(user), user });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/documents") {
    const user = requireAuth(req, res);
    if (!user) return true;
    await handleDocumentSave(req, res, user);
    return true;
  }

  const actionMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/(submit|review)$/);
  if (req.method === "POST" && actionMatch) {
    const user = requireAuth(req, res);
    if (!user) return true;

    const id = resolveDocumentId(safeDecodeURIComponent(actionMatch[1]));
    if (actionMatch[2] === "submit") {
      await handleDocumentSubmit(res, user, id);
    } else {
      await handleDocumentReview(req, res, user, id);
    }
    return true;
  }

  const versionsMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/versions$/);
  if (req.method === "GET" && versionsMatch) {
    const user = requireAuth(req, res);
    if (!user) return true;

    const id = resolveDocumentId(safeDecodeURIComponent(versionsMatch[1]));
    const doc = readDocumentById(id);
    if (!doc) {
      sendJson(res, 404, { error: "Document not found" });
      return true;
    }

    if (!canViewDocument(user, doc)) {
      sendJson(res, 403, { error: "No permission to view document versions" });
      return true;
    }

    const items = ensureDocumentHasHistorySnapshot(doc);

    sendJson(res, 200, {
      id,
      currentVersion: Number(doc.saveVersion || 1),
      items,
    });
    return true;
  }

  const versionFileMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/versions\/([^/]+)$/);
  if (req.method === "GET" && versionFileMatch) {
    const user = requireAuth(req, res);
    if (!user) return true;

    const id = resolveDocumentId(safeDecodeURIComponent(versionFileMatch[1]));
    const currentDoc = readDocumentById(id);
    if (!currentDoc) {
      sendJson(res, 404, { error: "Document not found" });
      return true;
    }
    if (!canViewDocument(user, currentDoc)) {
      sendJson(res, 403, { error: "No permission to view document versions" });
      return true;
    }

    const fileName = decodeURIComponent(versionFileMatch[2] || "");
    const snapshot = readDocumentVersionSnapshot(id, fileName);
    if (!snapshot) {
      sendJson(res, 404, { error: "Version snapshot not found" });
      return true;
    }

    sendJson(res, 200, {
      id,
      file: path.basename(fileName),
      snapshot: buildDocumentPayload(snapshot, user),
      current: buildDocumentPayload(currentDoc, user),
    });
    return true;
  }

  if (url.pathname.startsWith("/api/documents/")) {
    const user = requireAuth(req, res);
    if (!user) return true;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) return false;

    const id = resolveDocumentId(safeDecodeURIComponent(parts[2]));
    const doc = readDocumentById(id);

    if (req.method === "GET") {
      if (!doc) {
        sendJson(res, 404, { error: "Document not found" });
        return true;
      }
      if (!canViewDocument(user, doc)) {
        sendJson(res, 403, { error: "No permission to view document" });
        return true;
      }
      sendJson(res, 200, buildDocumentPayload(doc, user));
      return true;
    }

    if (req.method === "DELETE") {
      if (!doc) {
        const hasMeta = fs.existsSync(metadataPath(id));
        const hadHistory = fs.existsSync(historyDir(id));
        if (hasMeta) {
          try {
            fs.unlinkSync(metadataPath(id));
          } catch (_) {
          }
        }
        if (hadHistory) {
          removeDocumentHistory(id);
        }
        if (hasMeta || hadHistory) {
          sendJson(res, 200, { ok: true, id, stale: true });
        } else {
          sendJson(res, 404, { error: "Document not found" });
        }
        return true;
      }
      if (!canDeleteDocument(user, doc)) {
        sendJson(res, 403, { error: "Document cannot be deleted in current state" });
        return true;
      }
      fs.unlinkSync(documentPath(id));
      if (fs.existsSync(metadataPath(id))) {
        fs.unlinkSync(metadataPath(id));
      }
      removeDocumentHistory(id);
      sendJson(res, 200, { ok: true, id });
      return true;
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, url, res);
      if (!handled) sendJson(res, 404, { error: "API endpoint not found" });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} running at http://${HOST}:${PORT}`);
  console.log(`Data root: ${DATA_ROOT}`);
  console.log(`Special board storage: ${SPECIAL_BOARD_STORAGE}`);
  console.log(`Special board PDF provider: ${SPECIAL_BOARD_PDF_PROVIDER}`);
  console.log(
    `AI assist provider: ${AI_ASSIST_PROVIDER}${AI_ASSIST_PROVIDER === "deepseek" ? ` (${isDeepSeekAssistConfigured() ? "configured" : "not configured"})` : ""}`
  );
  const aiConfig = readAiAssistSettings();
  console.log(
    `AI assist policy: enabled=${aiConfig.enabled} default=${aiConfig.defaultModel} models=${aiConfig.allowedModels.join(",")}`
  );
  console.log(
    `AI assist limit: per-user=${aiConfig.dailyLimitPerUser || 0} per-dept=${aiConfig.dailyLimitPerDept || 0}`
  );
  if (SPECIAL_BOARD_STORAGE === "postgres") {
    ensureSpecialBoardDbReady()
      .then(() => {
        console.log("Special board postgres storage ready.");
      })
      .catch((error) => {
        console.error("Special board postgres init failed:", error.message || error);
        process.exit(1);
      });
  }
});
