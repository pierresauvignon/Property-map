// Property Map API — single Lambda handler behind a Function URL (fronted by CloudFront).
// Node 22.x, ESM, no bundler. AWS SDK v3 modules bundled in the runtime only.
//
// Event shape: API Gateway v2 / Lambda Function URL payload format.
//   event.requestContext.http.method   e.g. "GET"
//   event.rawPath                      e.g. "/api/data"  (includes /api prefix)
//   event.headers                      lower-cased header map
//   event.body / event.isBase64Encoded
//
// Table: PropertyMap (pk, sk). See docs/ARCHITECTURE.md for the full contract.

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.AWS_REGION || "us-east-1";
// All four come from the Lambda's environment, set by infra/provision.sh.
const TABLE = process.env.TABLE_NAME;
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET;

const ddbClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: REGION });
const ses = new SESv2Client({ region: REGION });

const SITE = process.env.SITE_ORIGIN;
// Empty means no email: notifications are simply skipped.
const MAIL_FROM = process.env.MAIL_FROM || "";

const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60; // 90 days
const COOKIE_NAME = "pm_s";
const VALID_USERS = ["alex", "sam", "guest"];
// Accounts that may read everything and say things — comments, photos,
// documents — but may not change the record itself: no scores, no edits, no
// deletions. The two of us decide; the rest look and comment.
const READ_ONLY_USERS = new Set(["guest"]);
// Who goes round to a visit: one of the two of us.
const VISITORS = ["alex", "sam"];
const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
// Documents attached to a listing: floorplans, the DPE, a surveyor's report.
// Images are here too because the drop zone accepts anything and the client
// decides which flow a file takes; a picture dropped by mistake still lands.
const ALLOWED_FILE_TYPES = {
  ...ALLOWED_IMAGE_TYPES,
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "text/plain": "txt",
};
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — a scanned plan, not a video
// A walk-through filmed on a phone. They go in the Photos section with the
// pictures we take ourselves, never the listing's carousel. The cap is about
// two minutes of iPhone 1080p — enough for a room-by-room tour.
const ALLOWED_VIDEO_TYPES = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const PROPERTY_ALLOWLIST = [
  "geo",
  "hidden",
  "gallery",
  "name",
  "address",
  "town",
  "kind",
  "lat",
  "lng",
  "price",
  "surface",
  "rooms",
  "chambres",
  "terrain",
  "type",
  "url",
  "links",
  "photo",
  "listing",
  "dpe",
  "ges",
  "spot",
  "visit",
  "visitBy",
  "visits",
  "sold",
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function json(status, body, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

// Parses the Cookie header into a map. Function URL events may deliver
// cookies either in event.cookies[] (when using the ALB/API GW v2 style) or
// folded into the "cookie" header — handle both.
function parseCookies(event) {
  const out = {};
  const pieces = [];
  if (Array.isArray(event.cookies)) pieces.push(...event.cookies);
  const headerVal = event.headers && (event.headers.cookie || event.headers.Cookie);
  if (headerVal) pieces.push(...headerVal.split(";"));
  for (const piece of pieces) {
    const idx = piece.indexOf("=");
    if (idx === -1) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookieHeader(token, { clear = false } = {}) {
  if (clear) {
    return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

// salted sha256: stores salt separately, hash = sha256(salt + password) hex
function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + password, "utf8").digest("hex");
}

function verifyPassword(password, salt, expectedHex) {
  const gotHex = hashPassword(password, salt);
  const gotBuf = Buffer.from(gotHex, "hex");
  const expBuf = Buffer.from(expectedHex, "hex");
  if (gotBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(gotBuf, expBuf);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function genId() {
  // short, url-safe, collision-resistant enough for ~100 properties
  return "p" + crypto.randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

async function requireSession(event) {
  const cookies = parseCookies(event);
  const token = cookies[COOKIE_NAME];
  if (!token) throw new HttpError(401, "not authenticated");

  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `SESS#${token}`, sk: "SESS" } })
  );
  const sess = res.Item;
  if (!sess) throw new HttpError(401, "not authenticated");
  if (typeof sess.ttl === "number" && sess.ttl < nowSeconds()) {
    throw new HttpError(401, "session expired");
  }
  return { user: sess.user, token };
}

// Brute-force brake. Short passwords are fine for us only if nobody can try
// them all: every LOGIN_FAILS_PER_LOCK wrong guesses lock the account, and each
// lock lasts twice as long as the last, up to a day. The count only resets on
// a successful login, so ten thousand guesses take years, not an afternoon.
// Being signed in for 90 days means a lock rarely costs either of us anything.
const LOGIN_FAILS_PER_LOCK = 5;
const LOGIN_LOCK_BASE_SECONDS = 15 * 60;
const LOGIN_LOCK_MAX_SECONDS = 24 * 60 * 60;

async function assertNotLocked(userId) {
  const r = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `LOCK#${userId}`, sk: "LOCK" } })
  );
  const until = r.Item?.until || 0;
  if (until > nowSeconds()) {
    const minutes = Math.ceil((until - nowSeconds()) / 60);
    throw new HttpError(429, `trop d'essais — réessayer dans ${minutes} min`);
  }
}

async function recordFailedLogin(userId) {
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `LOCK#${userId}`, sk: "LOCK" },
    UpdateExpression: "ADD fails :one",
    ExpressionAttributeValues: { ":one": 1 },
    ReturnValues: "ALL_NEW",
  }));
  const fails = r.Attributes?.fails || 0;
  if (fails % LOGIN_FAILS_PER_LOCK !== 0) return;
  const locks = fails / LOGIN_FAILS_PER_LOCK;
  const seconds = Math.min(LOGIN_LOCK_BASE_SECONDS * 2 ** (locks - 1), LOGIN_LOCK_MAX_SECONDS);
  const until = nowSeconds() + seconds;
  console.warn("login locked", userId, "fails", fails, "for", seconds, "s");
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `LOCK#${userId}`, sk: "LOCK" },
    UpdateExpression: "SET #u = :u",
    ExpressionAttributeNames: { "#u": "until" },
    ExpressionAttributeValues: { ":u": until },
  }));
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

async function handleLogin(event) {
  const body = parseBody(event);
  const userRaw = typeof body.user === "string" ? body.user : "";
  const password = typeof body.password === "string" ? body.password : "";
  const userId = userRaw.trim().toLowerCase();

  if (!VALID_USERS.includes(userId) || !password) {
    throw new HttpError(401, "invalid credentials");
  }

  await assertNotLocked(userId);

  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `USER#${userId}`, sk: "USER" } })
  );
  const userItem = res.Item;
  if (!userItem || !userItem.passHash || !userItem.salt) {
    throw new HttpError(401, "invalid credentials");
  }

  const ok = verifyPassword(password, userItem.salt, userItem.passHash);
  if (!ok) {
    await recordFailedLogin(userId);
    throw new HttpError(401, "invalid credentials");
  }
  await ddb
    .send(new DeleteCommand({ TableName: TABLE, Key: { pk: `LOCK#${userId}`, sk: "LOCK" } }))
    .catch(() => {});

  const token = crypto.randomBytes(32).toString("hex");
  const ttl = nowSeconds() + SESSION_MAX_AGE_SECONDS;
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { pk: `SESS#${token}`, sk: "SESS", user: userId, createdAt: Date.now(), ttl },
    })
  );

  return json(200, { user: userId }, { "set-cookie": setCookieHeader(token) });
}

async function handleLogout(event) {
  const cookies = parseCookies(event);
  const token = cookies[COOKIE_NAME];
  if (token) {
    await ddb
      .send(new DeleteCommand({ TableName: TABLE, Key: { pk: `SESS#${token}`, sk: "SESS" } }))
      .catch(() => {}); // best effort
  }
  return json(200, { ok: true }, { "set-cookie": setCookieHeader(null, { clear: true }) });
}

async function handleMe(event) {
  const { user } = await requireSession(event);
  return json(200, { user });
}

// GET /api/data — one Scan, fanned out by sk prefix.
async function handleData(event) {
  await requireSession(event);

  const properties = [];
  const scores = {}; // { propId: { user: value } }
  const notes = {}; // { propId: [{ts,user,text}] }
  const photos = {}; // { propId: [...] }
  const files = {}; // { propId: [{ts,user,name,url,size,contentType}] }
  const pois = []; // schools, shops, work — the things that make a street liveable
  let rev = 0;

  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey })
    );
    for (const item of page.Items || []) {
      const pk = item.pk || "";
      const sk = item.sk || "";

      if (pk.startsWith("POI#")) {
        if (sk === "META") pois.push({ id: pk.slice("POI#".length), ...stripKeys(item) });
        const t = item.updatedAt || item.createdAt || 0;
        if (t > rev) rev = t;
        continue;
      }
      if (!pk.startsWith("PROP#")) continue; // skip SESS#/USER# items
      const propId = pk.slice("PROP#".length);

      const updatedAt = item.updatedAt || item.editedAt || item.createdAt || 0;
      if (updatedAt > rev) rev = updatedAt;

      if (sk === "META") {
        properties.push({ id: propId, ...stripKeys(item) });
      } else if (sk.startsWith("SCORE#")) {
        const user = sk.slice("SCORE#".length);
        scores[propId] = scores[propId] || {};
        scores[propId][user] = item.value;
      } else if (sk.startsWith("NOTE#")) {
        const parts = sk.split("#"); // NOTE#<ts>#<user>
        const ts = Number(parts[1]);
        notes[propId] = notes[propId] || [];
        notes[propId].push({ ts, user: item.user, text: item.text, reactions: item.reactions || {} });
      } else if (sk.startsWith("PHOTO#")) {
        photos[propId] = photos[propId] || [];
        photos[propId].push({
          ts: Number(sk.slice("PHOTO#".length)),
          user: item.user,
          key: item.key,
          url: item.url,
          contentType: item.contentType,
        });
      } else if (sk.startsWith("FILE#")) {
        files[propId] = files[propId] || [];
        files[propId].push({
          ts: Number(sk.slice("FILE#".length)),
          user: item.user,
          key: item.key,
          url: item.url,
          name: item.name,
          size: item.size,
          contentType: item.contentType,
        });
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  // sort notes/photos chronologically for a stable client experience
  for (const arr of Object.values(notes)) arr.sort((a, b) => a.ts - b.ts);
  for (const arr of Object.values(photos)) arr.sort((a, b) => a.ts - b.ts);
  for (const arr of Object.values(files)) arr.sort((a, b) => a.ts - b.ts);

  return json(200, { properties, scores, notes, photos, files, pois, rev });
}

function stripKeys(item) {
  const { pk, sk, ...rest } = item;
  return rest;
}

async function handlePutScore(event, params) {
  const { user } = requireEditor(await requireSession(event));
  const propId = params.id;
  const body = parseBody(event);

  // 0..5 in half steps — a house is often a 3.5 and never quite a 4
  if (
    body.value !== null &&
    !(isFiniteNumber(body.value) && body.value >= 0 && body.value <= 5 &&
      body.value * 2 === Math.round(body.value * 2))
  ) {
    throw new HttpError(400, "value must be a number 0..5 in half steps, or null");
  }

  const key = { pk: `PROP#${propId}`, sk: `SCORE#${user}` };
  if (body.value === null) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));
  } else {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...key, value: body.value, updatedAt: Date.now() },
      })
    );
  }
  return json(200, { ok: true });
}

async function handlePostNote(event, params) {
  const { user } = await requireSession(event);
  const propId = params.id;
  const body = parseBody(event);

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 2000) {
    throw new HttpError(400, "text must be non-empty and at most 2000 characters");
  }

  const ts = Date.now();
  const item = {
    pk: `PROP#${propId}`,
    sk: `NOTE#${ts}#${user}`,
    user,
    text,
    createdAt: ts,
    updatedAt: ts,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

  // awaited on purpose: an un-awaited promise can be frozen with the
  // container before it sends, so the mail would simply never arrive
  const name = await propertyName(propId);
  await notify(user, {
    subject: `${user === "alex" ? "Alex" : "Sam"} a commenté ${name}`,
    headline: `${user === "alex" ? "Alex" : "Sam"} a laissé un commentaire sur ${name}`,
    body: text,
    propertyId: propId,
    cta: "Lire et répondre",
  });

  return json(200, { ts, user, text });
}

async function handleDeleteNote(event, params) {
  const { user } = requireEditor(await requireSession(event));
  const propId = params.id;
  const ts = params.ts;

  // sk is NOTE#<ts>#<user> and the author (not just the caller) is embedded
  // in it, so the caller's ts alone doesn't tell us the sk — query by prefix
  // to find whichever user's note this is, then check ownership explicitly.
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `PROP#${propId}`,
        ":skPrefix": `NOTE#${ts}#`,
      },
    })
  );
  const note = (res.Items || [])[0];
  if (!note) throw new HttpError(404, "note not found");
  if (note.user !== user) throw new HttpError(403, "you can only delete your own notes");

  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: note.pk, sk: note.sk } }));
  return json(200, { ok: true });
}

// A fixed palette rather than any emoji: a reaction is a nod, not a message,
// and an allowlist keeps the stored map small and the email legible.
const REACTIONS = ["👍", "❤️", "😂", "😮", "🤔", "👎"];

// PUT /api/note/:id/:ts/react {emoji, on} — set, not toggle, so the client's
// outbox can replay it after a dropped connection without flipping it back.
// Guests may react, as they may comment.
async function handleReactNote(event, params) {
  const { user } = await requireSession(event);
  const propId = params.id;
  const body = parseBody(event);
  if (!REACTIONS.includes(body.emoji)) throw new HttpError(400, "unknown reaction");
  if (typeof body.on !== "boolean") throw new HttpError(400, "on must be a boolean");

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `PROP#${propId}`,
        ":skPrefix": `NOTE#${params.ts}#`,
      },
    })
  );
  const note = (res.Items || [])[0];
  if (!note) throw new HttpError(404, "note not found");

  const reactions = { ...(note.reactions || {}) };
  const who = (reactions[body.emoji] || []).filter((u) => u !== user);
  const had = who.length !== (reactions[body.emoji] || []).length;
  if (body.on) who.push(user);
  if (who.length) reactions[body.emoji] = who;
  else delete reactions[body.emoji];

  // updatedAt moves so the other phone's rev check picks the reaction up
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: note.pk, sk: note.sk },
    UpdateExpression: "SET reactions = :r, updatedAt = :t",
    ExpressionAttributeValues: { ":r": reactions, ":t": Date.now() },
  }));

  // only a new reaction is news, and nobody needs telling about their own
  if (body.on && !had && note.user !== user) {
    const name = await propertyName(propId);
    const actor = userName(user);
    await notify(user, {
      to: note.user,
      subject: `${actor} a réagi ${body.emoji} à ton commentaire sur ${name}`,
      headline: `${actor} a réagi ${body.emoji} à ton commentaire sur ${name}`,
      body: note.text.length > 400 ? note.text.slice(0, 400) + "…" : note.text,
      propertyId: propId,
      cta: "Voir le commentaire",
    });
  }

  return json(200, { reactions });
}

// Mirror listing photos into our own bucket on the way in. The portals 403
// any server request for their HTML, but the image CDN itself is open, so
// this works where a page fetch would not. Best-effort and time-boxed:
// whatever does not make it stays a remote URL and can be mirrored later.
// Public https hosts only: never a bare IP, localhost or an internal name,
// which is where a server-side fetch could reach things a browser cannot.
function isMirrorableUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false; // IPv4 / IPv6 literal
  return true;
}

async function mirrorGallery(id, urls) {
  if (!Array.isArray(urls) || !urls.length) return urls;
  const deadline = Date.now() + 9000;
  const out = [];
  for (const url of urls) {
    if (typeof url !== "string" || !isMirrorableUrl(url)) { out.push(url); continue; }
    if (Date.now() > deadline) { out.push(url); continue; }
    const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
    const key = `photos/${id}/${hash}.jpg`;
    try {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: UPLOAD_BUCKET, Key: key }));
        out.push(`/${key}`);
        continue;
      } catch (_) { /* not mirrored yet */ }
      // redirect: "error" so an open CDN cannot bounce us somewhere internal
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      // Whatever lands here is served from our own origin, so only ever store
      // a picture: anything else (an HTML page, say) would run as our app.
      const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!ALLOWED_IMAGE_TYPES[type]) throw new Error("not an image: " + type);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) throw new Error("too small");
      if (buf.length > MAX_FILE_BYTES) throw new Error("too big");
      await s3.send(new PutObjectCommand({
        Bucket: UPLOAD_BUCKET, Key: key, Body: buf,
        ContentType: type,
        CacheControl: "public, max-age=31536000, immutable",
      }));
      out.push(`/${key}`);
    } catch (e) {
      console.warn("mirror failed", key, e.message);
      out.push(url);
    }
  }
  return out;
}

// ── telling the other one ──────────────────────────────────────────────
// Two people, so "notify" always means the other one. Best-effort: a mail
// that fails must never cost someone their comment, so every path swallows
// its errors and logs them.
async function otherUser(actor) {
  return recipient(actor === "alex" ? "sam" : "alex");
}

async function recipient(other) {
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { pk: `USER#${other}`, sk: "USER" },
    }));
    if (!r.Item || !r.Item.email || r.Item.notify === false) return null;
    return { id: other, name: r.Item.name || other, email: r.Item.email };
  } catch (e) {
    console.warn("notify lookup failed", e.message);
    return null;
  }
}

function requireEditor(session) {
  if (READ_ONLY_USERS.has(session.user)) {
    throw new HttpError(403, "ce compte est en lecture seule");
  }
  return session;
}

function esc(t) {
  return String(t == null ? "" : t).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// `to` names a specific recipient (a reaction goes to the comment's author);
// without it, the mail goes to the other one of us.
async function notify(actor, { to: toUser, subject, headline, body, propertyId, cta }) {
  if (!MAIL_FROM) return;
  const to = await (toUser ? recipient(toUser) : otherUser(actor));
  if (!to) return;
  const who = userName(actor);
  const link = propertyId ? `${SITE}/#bien/${encodeURIComponent(propertyId)}` : SITE;

  const html = `<!doctype html><html><body style="margin:0;background:#17161a;padding:28px 16px;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#201f25;border-radius:18px;overflow:hidden">
        <tr><td style="padding:26px 26px 6px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fe3f55">Les biens</div>
          <h1 style="margin:10px 0 0;font-size:21px;line-height:1.25;color:#fbfbfc;font-weight:800">${esc(headline)}</h1>
        </td></tr>
        ${body ? `<tr><td style="padding:14px 26px 0">
          <div style="background:#2a2930;border-radius:12px;padding:14px 16px;color:#d6d5db;font-size:15px;line-height:1.5">${esc(body)}</div>
        </td></tr>` : ""}
        <tr><td style="padding:22px 26px 28px">
          <a href="${link}" style="display:inline-block;background:#fe3f55;color:#1a0d10;text-decoration:none;
             padding:13px 22px;border-radius:999px;font-weight:800;font-size:15px">${esc(cta || "Voir sur la carte")}</a>
          <div style="margin-top:18px;font-size:12px;color:#8d8c96">
            Tu reçois ceci parce que ${esc(who)} a fait une modification sur Les biens.
          </div>
        </td></tr>
      </table>
    </td></tr></table></body></html>`;

  const text = `${headline}\n\n${body ? body + "\n\n" : ""}${link}\n`;

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: MAIL_FROM,
      Destination: { ToAddresses: [to.email] },
      Content: { Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } },
      } },
    }));
  } catch (e) {
    console.warn("notify send failed", e.message);
  }
}

const USER_NAMES = { alex: "Alex", sam: "Sam", guest: "Invité" };
function userName(id) {
  return USER_NAMES[id] || id;
}

async function propertyName(id) {
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { pk: `PROP#${id}`, sk: "META" },
    }));
    return (r.Item && r.Item.name) || "un bien";
  } catch (e) { return "un bien"; }
}

function validatePropertyPatch(body) {
  const unknown = Object.keys(body).filter((k) => !PROPERTY_ALLOWLIST.includes(k));
  if (unknown.length) {
    throw new HttpError(400, `unknown field(s): ${unknown.join(", ")}`);
  }

  const patch = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new HttpError(400, "name must be a non-empty string");
    patch.name = body.name.trim();
  }
  if ("address" in body) {
    if (typeof body.address !== "string") throw new HttpError(400, "address must be a string");
    patch.address = body.address;
  }
  if ("town" in body) {
    if (typeof body.town !== "string") throw new HttpError(400, "town must be a string");
    patch.town = body.town;
  }
  if ("kind" in body) {
    if (body.kind !== "property" && body.kind !== "land") {
      throw new HttpError(400, 'kind must be "property" or "land"');
    }
    patch.kind = body.kind;
  }
  // The two letters off the French energy label: DPE is consumption, GES is
  // emissions. Null clears one — a plot of land has neither.
  for (const letterField of ["dpe", "ges"]) {
    if (!(letterField in body)) continue;
    const v = body[letterField];
    if (v === null || v === "") {
      patch[letterField] = null;
      continue;
    }
    if (typeof v !== "string" || !/^[A-G]$/.test(v.toUpperCase())) {
      throw new HttpError(400, `${letterField} must be a single letter A..G, or null`);
    }
    patch[letterField] = v.toUpperCase();
  }
  // When we are going round: local wall-clock, "YYYY-MM-DD" or
  // "YYYY-MM-DDTHH:mm". A visit is at three o'clock wherever the phone is.
  if ("visit" in body) {
    const v = body.visit;
    if (v === null || v === "") {
      patch.visit = null;
    } else if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) {
      throw new HttpError(400, "visit must be YYYY-MM-DD[THH:mm], or null");
    } else {
      patch.visit = v;
    }
  }
  if ("visitBy" in body) {
    const v = body.visitBy;
    if (v !== null && !VISITORS.includes(v)) {
      throw new HttpError(400, `visitBy must be one of ${VISITORS.join(", ")}, or null`);
    }
    patch.visitBy = v;
  }
  // A house is often seen more than once — one of us, then the other — so a
  // bien keeps every visit: [{ at: "YYYY-MM-DD[THH:mm]", by: "sam" }].
  if ("visits" in body) {
    const vs = body.visits === null ? [] : body.visits;
    if (!Array.isArray(vs) || vs.length > 20) throw new HttpError(400, "visits must be an array of at most 20, or null");
    patch.visits = vs.map((v) => {
      if (!v || typeof v.at !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v.at)) {
        throw new HttpError(400, "each visit needs at: YYYY-MM-DD[THH:mm]");
      }
      if (!VISITORS.includes(v.by)) throw new HttpError(400, `each visit needs by: ${VISITORS.join(" or ")}`);
      return { at: v.at, by: v.by };
    }).sort((a, b) => a.at.localeCompare(b.at));
  }
  // The one mark neither the listing nor a formula can give: how good the
  // spot is. Shared, not per person — either of us sets it for both — and
  // settable to the half star, so 0, 0.5, 1 … 5.
  if ("spot" in body) {
    const v = body.spot;
    if (v === null || v === "") {
      patch.spot = null;
    } else if (!isFiniteNumber(v) || v < 0 || v > 5 || v * 2 !== Math.round(v * 2)) {
      throw new HttpError(400, "spot must be a number 0..5 in half steps, or null");
    } else {
      patch.spot = v;
    }
  }
  if ("lat" in body) {
    if (!isFiniteNumber(body.lat) || body.lat < -90 || body.lat > 90) {
      throw new HttpError(400, "lat must be a plausible number");
    }
    patch.lat = body.lat;
  }
  if ("lng" in body) {
    if (!isFiniteNumber(body.lng) || body.lng < -180 || body.lng > 180) {
      throw new HttpError(400, "lng must be a plausible number");
    }
    patch.lng = body.lng;
  }
  if ("price" in body) {
    if (body.price !== null && (!isFiniteNumber(body.price) || body.price < 0 || body.price >= 100000000)) {
      throw new HttpError(400, "price must be a number 0 <= price < 100000000, or null");
    }
    patch.price = body.price;
  }
  for (const numField of ["surface", "rooms", "chambres", "terrain"]) {
    if (numField in body) {
      const v = body[numField];
      if (v !== null && !isFiniteNumber(v)) {
        throw new HttpError(400, `${numField} must be a number or null`);
      }
      patch[numField] = v;
    }
  }
  if ("type" in body) {
    if (body.type !== null && typeof body.type !== "string") throw new HttpError(400, "type must be a string or null");
    patch.type = body.type;
  }
  if ("url" in body) {
    if (body.url !== null && typeof body.url !== "string") throw new HttpError(400, "url must be a string or null");
    patch.url = body.url;
  }
  // The same house is often listed by several agencies. `url` stays the one
  // we follow; `links` holds the others, so any of them is recognised.
  if ("links" in body) {
    if (body.links !== null) {
      if (!Array.isArray(body.links)) throw new HttpError(400, "links must be an array or null");
      if (body.links.length > 10) throw new HttpError(400, "links is limited to 10");
      if (!body.links.every((u) => typeof u === "string" && /^https?:\/\//i.test(u) && u.length < 2048)) {
        throw new HttpError(400, "links entries must be http(s) URLs under 2048 chars");
      }
    }
    patch.links = body.links;
  }
  if ("photo" in body) {
    if (body.photo !== null && typeof body.photo !== "string") throw new HttpError(400, "photo must be a string or null");
    patch.photo = body.photo;
  }
  if ("listing" in body) {
    if (body.listing !== null && typeof body.listing !== "string") throw new HttpError(400, "listing must be a string or null");
    patch.listing = body.listing;
  }
  // Hiding is shared: one of us hides a dud, it leaves the list for both, and
  // either can still go and fish it back out of the hidden view.
  // how the position was arrived at — drives the "approximate" marker styling
  if ("geo" in body) {
    const ok = ["dms", "manual", "geocode", "geocode-town", "geocode-street"];
    if (body.geo !== null && ok.indexOf(body.geo) === -1) {
      throw new HttpError(400, "geo must be one of " + ok.join(", "));
    }
    patch.geo = body.geo;
  }
  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") throw new HttpError(400, "hidden must be a boolean");
    patch.hidden = body.hidden;
  }
  // Sold to someone else. Unlike hidden it does not leave the lists: what a
  // street went for is worth keeping on the map.
  if ("sold" in body) {
    if (typeof body.sold !== "boolean") throw new HttpError(400, "sold must be a boolean");
    patch.sold = body.sold;
  }
  // Every photo from the listing, in order, so the panel can be swiped through.
  if ("gallery" in body) {
    if (body.gallery !== null) {
      if (!Array.isArray(body.gallery)) throw new HttpError(400, "gallery must be an array or null");
      if (body.gallery.length > 60) throw new HttpError(400, "gallery is limited to 60 photos");
      if (!body.gallery.every((u) => typeof u === "string" && u.length < 2048)) {
        throw new HttpError(400, "gallery entries must be strings under 2048 chars");
      }
    }
    patch.gallery = body.gallery;
  }

  return patch;
}

async function handlePutProperty(event, params) {
  const { user } = requireEditor(await requireSession(event));
  const propId = params.id;
  const body = parseBody(event);
  const patch = validatePropertyPatch(body);

  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `PROP#${propId}`, sk: "META" } })
  );
  if (!existing.Item) throw new HttpError(404, "property not found");

  // An app from before the list of visits still sends one `visit` (and maybe
  // `visitBy`). Fold that into the list: cleared, it clears them all; set, it
  // joins the others as that person's visit, or whoever booked it.
  if (("visit" in patch || "visitBy" in patch) && !("visits" in patch)) {
    const had = Array.isArray(existing.Item.visits) ? existing.Item.visits
      : existing.Item.visit ? [{ at: existing.Item.visit, by: existing.Item.visitBy || "sam" }] : [];
    if (patch.visit === null) patch.visits = [];
    else if (patch.visit) {
      const by = patch.visitBy || (VISITORS.includes(user) ? user : "sam");
      patch.visits = had.filter((v) => v.at !== patch.visit).concat([{ at: patch.visit, by }])
        .sort((a, b) => a.at.localeCompare(b.at));
    }
  }
  delete patch.visit; delete patch.visitBy;

  if (patch.gallery) {
    patch.gallery = await mirrorGallery(propId, patch.gallery);
    // A real listing photo always outranks a Street View placeholder, so the
    // hero follows the gallery unless one was named explicitly in this call.
    if (patch.gallery.length && !("photo" in body)) {
      patch.photo = patch.gallery[0];
    }
  }

  const now = Date.now();
  const updated = {
    ...existing.Item,
    ...patch,
    editedBy: user,
    editedAt: now,
    updatedAt: now,
  };
  // the list replaces the single visit for good
  if ("visits" in patch) { delete updated.visit; delete updated.visitBy; }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: updated }));
  return json(200, { id: propId, ...stripKeys(updated) });
}

async function handlePostProperty(event) {
  const { user } = requireEditor(await requireSession(event));
  const body = parseBody(event);
  const patch = validatePropertyPatch(body);

  const id = genId();
  if (patch.gallery) {
    patch.gallery = await mirrorGallery(id, patch.gallery);
    if (!patch.photo) patch.photo = patch.gallery[0];
  }
  const now = Date.now();
  const item = {
    pk: `PROP#${id}`,
    sk: "META",
    ...patch,
    editedBy: user,
    editedAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  await notify(user, {
    subject: `${user === "alex" ? "Alex" : "Sam"} a ajouté ${item.name}`,
    headline: `${user === "alex" ? "Alex" : "Sam"} a ajouté un bien : ${item.name}`,
    body: [
      item.price != null ? `${item.price.toLocaleString("fr-FR")} €` : null,
      item.surface ? `${item.surface} m²` : null,
      item.town || null,
    ].filter(Boolean).join(" · ") || null,
    propertyId: id,
    cta: "Voir le bien",
  });

  return json(200, { id, ...stripKeys(item) });
}

// A browser cannot PUT to S3 without a signature, so both upload routes hand
// back a short-lived presigned URL and record the item up front: the client
// PUTs straight to S3 and never streams bytes through the Lambda.
async function presignPut(key, contentType) {
  const putCmd = new PutObjectCommand({
    Bucket: UPLOAD_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, putCmd, { expiresIn: 300 }); // 5 minutes
}

async function handleUpload(event, params) {
  const { user } = await requireSession(event);
  const propId = params.id;
  const body = parseBody(event);

  const contentType = body.contentType;
  const video = ALLOWED_VIDEO_TYPES[contentType];
  const ext = ALLOWED_IMAGE_TYPES[contentType] || video;
  if (!ext) {
    throw new HttpError(400, "contentType must be one of image/jpeg, image/png, image/webp, video/mp4, video/quicktime, video/webm");
  }
  // Only a video needs its size declared: a photo is never near any limit.
  const size = Number(body.size);
  if (video) {
    if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "size is required for a video");
    if (size > MAX_VIDEO_BYTES) {
      throw new HttpError(400, `video is larger than ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB`);
    }
  }

  const uuid = crypto.randomUUID();
  const key = `photos/${propId}/${uuid}.${ext}`;
  const publicPath = `/${key}`;

  const putUrl = await presignPut(key, contentType);

  const ts = Date.now();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `PROP#${propId}`,
        sk: `PHOTO#${ts}`,
        user,
        key,
        url: publicPath,
        contentType,
        ...(video ? { size } : {}),
        createdAt: ts,
        updatedAt: ts,
      },
    })
  );

  // ts is the row's sort key, and the client needs it to be able to delete
  // this photo later — inventing its own would not match.
  return json(200, { putUrl, url: publicPath, key, ts, contentType });
}

// POST /api/file/:id — a document (floorplan, DPE, report) rather than a photo.
// The original filename is kept in DynamoDB, never in the S3 key: keys stay
// ASCII and collision-free, and an accented French filename survives intact.
async function handleUploadFile(event, params) {
  const { user } = await requireSession(event);
  const propId = params.id;
  const body = parseBody(event);

  const contentType = String(body.contentType || "");
  const ext = ALLOWED_FILE_TYPES[contentType];
  if (!ext) throw new HttpError(400, `unsupported file type: ${contentType || "(none)"}`);

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "size is required");
  if (size > MAX_FILE_BYTES) {
    throw new HttpError(400, `file is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
  }

  const name = cleanFileName(body.name, ext);

  const uuid = crypto.randomUUID();
  const key = `files/${propId}/${uuid}.${ext}`;
  const publicPath = `/${key}`;

  const putUrl = await presignPut(key, contentType);

  const ts = Date.now();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `PROP#${propId}`,
        sk: `FILE#${ts}`,
        user,
        key,
        url: publicPath,
        name,
        size,
        contentType,
        createdAt: ts,
        updatedAt: ts,
      },
    })
  );

  return json(200, { putUrl, url: publicPath, key, name, size, contentType, ts, user });
}

// Strip any directory part and control characters a browser might pass through,
// and fall back to something readable when the name is missing or empty.
function cleanFileName(raw, ext) {
  const base = String(raw || "")
    .split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return base || `document.${ext}`;
}

// DELETE /api/file/:id/:ts — either of us can remove either's documents, the
// same trade-off the rest of this two-person app makes.
async function handleDeleteFile(event, params) {
  requireEditor(await requireSession(event));
  const propId = params.id;
  const ts = params.ts;

  const key = { pk: `PROP#${propId}`, sk: `FILE#${ts}` };
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  const item = res.Item;
  if (!item) throw new HttpError(404, "file not found");

  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));

  // The row is gone either way; a stranded object costs a fraction of a cent
  // and is far better than a row pointing at nothing.
  if (item.key) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOAD_BUCKET, Key: item.key }));
    } catch (err) {
      console.warn("file delete: S3 object remains", item.key, err?.name);
    }
  }

  return json(200, { ok: true });
}

// DELETE /api/photo/:id/:ts — remove one uploaded photo, row and object.
// The listing's own gallery is a plain array on the property and is edited
// through PUT /api/property/:id instead; this is only for what we uploaded.
async function handleDeletePhoto(event, params) {
  requireEditor(await requireSession(event));
  const propId = params.id;
  const key = { pk: `PROP#${propId}`, sk: `PHOTO#${params.ts}` };

  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  const item = res.Item;
  if (!item) throw new HttpError(404, "photo not found");

  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));

  if (item.key) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOAD_BUCKET, Key: item.key }));
    } catch (err) {
      console.warn("photo delete: S3 object remains", item.key, err?.name);
    }
  }

  return json(200, { ok: true });
}

// POST /api/notify-files/:id — one email for a whole batch of uploads.
//
// The client calls this once, after its upload queue drains. It deliberately
// takes no list of files: the handler looks up the caller's own recent rows
// that have not been announced yet and marks them as it goes. That makes the
// call idempotent (a retry from the offline queue sends nothing the second
// time), self-healing (files from a batch the browser abandoned get swept into
// the next email rather than vanishing), and impossible to use as a way to
// send arbitrary mail, since it only ever names rows that already exist.
const NOTIFY_WINDOW_MS = 15 * 60 * 1000;
// A row is written before the browser sends the bytes, so a failed or
// abandoned PUT leaves one pointing at nothing. The client takes its own
// failures back out; this is the backstop for the ones it never got to report.
// Five minutes is the presigned URL's lifetime: past that, a PUT that has not
// landed never will.
// A video is the exception: S3 checks the signature when the PUT starts, so a
// 400 MB walk-through can still be arriving long after that — give it an hour.
const STALE_ROW_MS = 5 * 60 * 1000;
const STALE_VIDEO_ROW_MS = 60 * 60 * 1000;
const isVideoRow = (i) => /^video\//.test(String(i.contentType || ""));

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: UPLOAD_BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return false;
    // Anything else — a throttle, a permissions blip — is not evidence of
    // absence, and deleting someone's file on a guess is unforgivable.
    //
    // Note the role needs s3:ListBucket for this to work at all: without it S3
    // answers 403 rather than 404 for a key that is simply not there, which is
    // indistinguishable from a real permissions failure and lands here.
    console.warn("head failed, assuming the object is there:", key,
                 err?.name, err?.$metadata?.httpStatusCode);
    return true;
  }
}

async function handleNotifyFiles(event, params) {
  const { user } = await requireSession(event);
  const propId = params.id;
  const since = Date.now() - NOTIFY_WINDOW_MS;

  const pick = async (prefix) => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": `PROP#${propId}`, ":p": prefix },
      })
    );
    return (res.Items || []).filter((i) => i.user === user && !i.notified);
  };

  // Two different windows on purpose. Announcing is limited to what just
  // happened; sweeping is not, because an orphan left by a browser that died
  // mid-upload can be any age, and one older than the announce window would
  // otherwise never be reached by anything.
  const mine = [...(await pick("FILE#")), ...(await pick("PHOTO#"))];
  if (!mine.length) return json(200, { ok: true, sent: false });

  // Never announce a file that is not actually there, and clear out the ones
  // that are past saving.
  let swept = 0;
  const verified = await Promise.all(
    mine.map(async (i) => {
      if (!i.key || (await objectExists(i.key))) return i;
      if (Date.now() - Number(i.createdAt || 0) > (isVideoRow(i) ? STALE_VIDEO_ROW_MS : STALE_ROW_MS)) {
        await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
        swept++;
        console.warn("swept a row whose upload never arrived:", i.key);
      }
      // Left unmarked when it is too young to judge, so a later batch re-checks.
      return null;
    })
  );
  // The row is stamped when the PUT starts, so a long video upload would be
  // past the window by the time it lands; it gets the hour it was allowed.
  const live = verified.filter(
    (i) => i && Number(i.createdAt || 0) >= (isVideoRow(i) ? Date.now() - STALE_VIDEO_ROW_MS : since)
  );
  const files = live.filter((i) => String(i.sk).startsWith("FILE#"));
  const media = live.filter((i) => String(i.sk).startsWith("PHOTO#"));
  const videos = media.filter(isVideoRow);
  const photos = media.filter((i) => !isVideoRow(i));
  if (!live.length) return json(200, { ok: true, sent: false, swept });

  // Mark before sending: if SES is having a bad day we would rather drop one
  // email than send the same one on every retry.
  const stamp = Date.now();
  await Promise.all(
    live.map((i) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: i.pk, sk: i.sk },
          UpdateExpression: "SET notified = :t",
          ExpressionAttributeValues: { ":t": stamp },
        })
      )
    )
  );

  const meta = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `PROP#${propId}`, sk: "META" } })
  );
  const name = (meta.Item && meta.Item.name) || "un bien";
  const who = user === "alex" ? "Alex" : "Sam";

  const parts = [];
  if (files.length) parts.push(`${files.length} document${files.length > 1 ? "s" : ""}`);
  if (photos.length) parts.push(`${photos.length} photo${photos.length > 1 ? "s" : ""}`);
  if (videos.length) parts.push(`${videos.length} vidéo${videos.length > 1 ? "s" : ""}`);
  const what = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`
    : parts[0];

  await notify(user, {
    subject: `${who} a ajouté ${what}`,
    headline: `${who} a ajouté ${what} à ${name}`,
    body: files.map((f) => f.name).filter(Boolean).join(", ") || null,
    propertyId: propId,
    cta: "Voir les fichiers",
  });

  return json(200, { ok: true, sent: true, files: files.length, photos: photos.length, videos: videos.length, swept });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

// Route table: [method, path pattern with :params, handler]. Matched in order.
// Points of interest: the school, the bakery, the office. Shared, like
// everything else, and deliberately simple — a label, an icon and a point.
const POI_ICONS = [
  "school", "shop", "bakery", "train", "bus", "park", "work",
  "health", "sport", "food", "family", "star",
];

function validatePoi(body, { requirePosition } = {}) {
  const unknown = Object.keys(body).filter(
    (k) => !["name", "icon", "lat", "lng", "note"].includes(k)
  );
  if (unknown.length) throw new HttpError(400, `unknown field(s): ${unknown.join(", ")}`);

  const patch = {};
  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new HttpError(400, "name must be a non-empty string");
    }
    if (body.name.length > 80) throw new HttpError(400, "name is limited to 80 characters");
    patch.name = body.name.trim();
  }
  if ("icon" in body) {
    if (!POI_ICONS.includes(body.icon)) {
      throw new HttpError(400, `icon must be one of ${POI_ICONS.join(", ")}`);
    }
    patch.icon = body.icon;
  }
  if ("note" in body) {
    if (body.note !== null && typeof body.note !== "string") {
      throw new HttpError(400, "note must be a string or null");
    }
    if (body.note && body.note.length > 500) throw new HttpError(400, "note is limited to 500 characters");
    patch.note = body.note;
  }
  for (const [k, lo, hi] of [["lat", -90, 90], ["lng", -180, 180]]) {
    if (k in body) {
      if (!isFiniteNumber(body[k]) || body[k] < lo || body[k] > hi) {
        throw new HttpError(400, `${k} must be a plausible number`);
      }
      patch[k] = body[k];
    }
  }
  if (requirePosition && (patch.lat === undefined || patch.lng === undefined)) {
    throw new HttpError(400, "lat and lng are required");
  }
  if (requirePosition && !patch.name) throw new HttpError(400, "name is required");
  return patch;
}

async function handlePostPoi(event) {
  const { user } = requireEditor(await requireSession(event));
  const patch = validatePoi(parseBody(event), { requirePosition: true });
  const id = genId();
  const now = Date.now();
  const item = {
    pk: `POI#${id}`, sk: "META",
    icon: "star", ...patch,
    createdBy: user, createdAt: now, updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return json(200, { id, ...stripKeys(item) });
}

async function handlePutPoi(event, params) {
  const { user } = requireEditor(await requireSession(event));
  const patch = validatePoi(parseBody(event));
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: `POI#${params.id}`, sk: "META" } })
  );
  if (!existing.Item) throw new HttpError(404, "point not found");
  const item = { ...existing.Item, ...patch, editedBy: user, updatedAt: Date.now() };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return json(200, { id: params.id, ...stripKeys(item) });
}

async function handleDeletePoi(event, params) {
  requireEditor(await requireSession(event));
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: `POI#${params.id}`, sk: "META" },
  }));
  return json(200, { ok: true });
}

const ROUTES = [
  ["POST", "/api/login", handleLogin],
  ["POST", "/api/logout", handleLogout],
  ["GET", "/api/me", handleMe],
  ["GET", "/api/data", handleData],
  ["PUT", "/api/property/:id", handlePutProperty],
  ["POST", "/api/property", handlePostProperty],
  ["PUT", "/api/score/:id", handlePutScore],
  ["POST", "/api/note/:id", handlePostNote],
  ["DELETE", "/api/note/:id/:ts", handleDeleteNote],
  ["PUT", "/api/note/:id/:ts/react", handleReactNote],
  ["POST", "/api/upload/:id", handleUpload],
  ["POST", "/api/file/:id", handleUploadFile],
  ["DELETE", "/api/file/:id/:ts", handleDeleteFile],
  ["DELETE", "/api/photo/:id/:ts", handleDeletePhoto],
  ["POST", "/api/notify-files/:id", handleNotifyFiles],
  ["POST", "/api/poi", handlePostPoi],
  ["PUT", "/api/poi/:id", handlePutPoi],
  ["DELETE", "/api/poi/:id", handleDeletePoi],
];

function matchRoute(method, path) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const params = matchPath(pattern, path);
    if (params) return { handler, params };
  }
  return null;
}

function matchPath(pattern, path) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// The Function URL is public (AuthType NONE) because CloudFront's Origin
// Access Control does NOT sign the request body, so IAM-authed POST/PUT
// requests fail SigV4 at the origin. Instead CloudFront injects a secret
// header on every origin request and we reject anything without it, which
// makes the Function URL unusable directly while letting bodies through.
function assertFromCloudFront(event) {
  const expected = process.env.ORIGIN_SECRET;
  if (!expected) return;                       // not configured: fail open for local invokes
  const got = (event?.headers || {})["x-origin-secret"];
  if (!got || got.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    throw new HttpError(403, "forbidden");
  }
}

export const handler = async (event) => {
  try {
    // direct `aws lambda invoke` calls carry no headers at all; let those through
    if (event?.headers) assertFromCloudFront(event);
    const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
    let path = event?.rawPath || event?.path || "/";
    // strip a trailing slash (except root) for forgiving matching
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    const match = matchRoute(method, path);
    if (!match) return json(404, { error: "not found" });

    return await match.handler(event, match.params);
  } catch (err) {
    if (err instanceof HttpError) {
      return json(err.status, { error: err.message });
    }
    // Never leak internals to the client; log server-side for debugging.
    console.error("unhandled error", err);
    return json(500, { error: "internal server error" });
  }
};
