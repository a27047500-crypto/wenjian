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
const PG_SSL = String(process.env.PG_SSL || "").toLowerCase() === "true";

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "sop_session";
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

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

const sessions = new Map();
const loginAttempts = new Map();
const specialBoardStreamClients = new Set();
let specialBoardPgPool = null;
let specialBoardDbReady = false;

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
    passwordHash: hashPassword("Admin@123"),
  };

  const departmentUsers = DEPARTMENTS.map((department, index) => {
    const no = String(index + 1).padStart(2, "0");
    return {
      username: `dept${no}`,
      displayName: `${department} Officer`,
      role: "editor",
      department,
      passwordHash: hashPassword(`Dept${no}@123`),
    };
  });

  return [admin, ...departmentUsers];
}

function normalizeUserRecord(user) {
  return {
    username: String(user?.username || "").trim(),
    displayName: String(user?.displayName || user?.username || "").trim(),
    role: user?.role === "admin" ? "admin" : user?.role === "viewer" ? "viewer" : "editor",
    department: String(user?.department || "").trim(),
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

async function writeSpecialBoardStoreToFile(data, user, options = {}) {
  const current = readSpecialBoardStoreFromFile();
  const normalizedData = normalizeSpecialBoardData(data);
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
  await fs.promises.writeFile(SPECIAL_BOARD_FILE, JSON.stringify(payload), "utf8");
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

async function buildSpecialBoardChangesPayload(queryRevision, includeData = false) {
  const store = await readSpecialBoardStore();
  return buildSpecialBoardChangesPayloadFromStore(store, queryRevision, includeData);
}

async function writeSpecialBoardStore(data, user, options = {}) {
  if (SPECIAL_BOARD_STORAGE !== "postgres") {
    return await writeSpecialBoardStoreToFile(data, user, options);
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
    const normalizedData = normalizeSpecialBoardData(data);
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

function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, {
    token,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    department: user.department,
    expiresAt,
  });
  return { token, expiresAt };
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function getUserFromSession(req) {
  const session = getSession(req);
  if (!session) return null;
  const user = readUsers().find((item) => item.username === session.username);
  return user ? publicUser(user) : null;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
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

function requireAuth(req, res) {
  const user = getUserFromSession(req);
  if (!user) {
    sendJson(res, 401, { error: "Please login first" });
    return null;
  }
  return user;
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
  const session = createSession(user);
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
  const syncDepartmentGlobally = body.syncDepartmentGlobally === true;

  if (!hasDisplayName && !hasPassword && !hasDepartment) {
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

  if (req.method === "GET" && apiPath === "/api/special-board") {
    const user = requireAuth(req, res);
    if (!user) return true;
    sendJson(res, 200, { ok: true, ...(await readSpecialBoardStore()) });
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
        ...(await buildSpecialBoardChangesPayload(revision, includeData)),
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
    const saved = await writeSpecialBoardStore(body.data, user, { expectedRevision: baseRevision });
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
