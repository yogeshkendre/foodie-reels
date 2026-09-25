"use strict";

// Single-file Node.js 22+ API and CLI; no npm dependencies.
// Run --help for Render and iOS Shortcuts setup, or --self-test for offline tests.
// Instagram Login requires a Business/Creator account and permissions:
// instagram_business_basic, instagram_business_content_publish.
// https://developers.facebook.com/documentation/instagram-platform/content-publishing

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { parseArgs } = require("node:util");
const { createServer } = require("node:http");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");

const DEFAULT_VERSION = "v25.0";
const MAX_VIDEO_BYTES = 300_000_000;
const POLL_INTERVAL_MS = 60_000;
const MAX_STATUS_CHECKS = 5;
const REQUEST_TIMEOUT_MS = 60_000;
const ID_PATTERN = /^[1-9]\d*$/;

const HELP = `
Instagram Reel API (Instagram Login; Node.js 22+, recommended Node.js 24)

RENDER FREE: upload ONLY this JS file to your repository.
  Service: Web Service, runtime: Node, plan: Free
  Build command: node --check instagram-reel.js
  Start command: node instagram-reel.js --serve
  Environment: NODE_VERSION=24.18.0
               API_KEY=<a private random key, 32-256 letters/digits/_/->
  Health check path: /health
  PORT is provided by Render; the server binds to 0.0.0.0.
  No package.json, npm install, .env, database, or other file is needed.

SHORTCUT:
  1. GET https://YOUR-SERVICE.onrender.com/health; save serverId.
     Free Render cold starts can take about a minute. Wake it before submitting.
  2. Generate a UUID per video and SAVE it before submitting.
  3. POST /reels with these headers:
       Authorization: Bearer YOUR_API_KEY
       X-Server-ID: <serverId from step 1>
       Content-Type: application/json
     JSON body (use Text for IDs/tokens and Boolean for shareToFeed):
       {
         "requestId": "<saved UUID>",
         "instagramToken": "<Instagram Login token>",
         "instagramUserId": "<professional account user_id as text>",
         "videoUrl": "<public GitHub MP4 download URL>",
         "caption": "Your generated caption #food",
         "shareToFeed": false
       }
     caption and shareToFeed are optional. No AI/GitHub credentials are needed.
     A 202 response means ACCEPTED, NOT published. jobId equals requestId.
  4. Submit all selected videos first, saving each jobId AND serverId.
  5. GET /reels/<jobId> with the same Authorization and X-Server-ID headers.
     Repeat after retryAfterSeconds (10) while done=false.
       done=true, success=true  -> posted; show reelUrl or accountUsername.
       done=true, success=false -> failed; show error.message.
       done=true, success=null  -> outcome unknown/request error; inspect
                                  Instagram and error.message. DO NOT repost.
     Give the loop a time limit (e.g. 15 minutes). If exceeded, save the job IDs
     and check them later; ending a Shortcut does not cancel accepted jobs.
  If POST times out, GET the SAVED requestId, or repeat the identical POST with
  that same requestId AND serverId. Never generate a new ID for a network retry.

LIMITS AND SAFETY:
  20 unfinished jobs, 2 active jobs total, 1 active per Instagram account.
  Five videos submitted seconds apart are queued and published in arrival order
  per account. Instagram still enforces its own publishing and account limits.
  All API routes except /health require the API key. Use HTTPS outside localhost.
  Only public GitHub download hosts are accepted; video redirects are checked.
  Tokens are held only while working, never returned/logged, and then discarded.
  Jobs/deduplication last 24 hours in MEMORY only (maximum 500 retained jobs).
  Free Render sleeps/restarts/redeploys erase jobs and deduplication. Old
  X-Server-ID values return SERVER_RESTARTED; missing jobs return JOB_NOT_FOUND.
  Neither means a previously submitted Reel failed. Check Instagram manually.
  Do not automatically resubmit old jobs with a new serverId or requestId.
  Run ONE service instance. Durable recovery needs external persistent storage.
  success can be true with a warning and no reelUrl if Meta confirms publication
  but a later metadata lookup fails. This is NOT a reason to publish again.

  node instagram-reel.js --self-test
      Embedded HTTP/queue tests with fake Instagram responses; no real uploads.
  node instagram-reel.js --serve
      Start the API using API_KEY and PORT from environment variables.

EXISTING LOCAL CLI:

Set IG_ACCESS_TOKEN, IG_USER_ID, and IG_VIDEO_URL in the adjacent .env.
Optional: IG_CAPTION, IG_SHARE_TO_FEED=true|false, IG_API_VERSION.
IG_USER_ID must be the professional account's user_id, not your Meta app ID.
Use only a video you own or have permission to publish.

  node instagram-reel.js --check
      Read-only account and public MP4 checks; also the default with no flags.
      This does NOT prove publishing permission or video codec compatibility.

  node instagram-reel.js --publish
      Create a NEW container, wait for processing, and publish a real Reel.
      Every fresh invocation can create another post. Do not blindly rerun it.

  node instagram-reel.js --status CONTAINER_ID
      Read the status of an existing container without publishing.

  node instagram-reel.js --publish --container CONTAINER_ID
      Resume the SAME container; refuse to publish if already PUBLISHED.
      No source URL is required when resuming. Containers expire after 24 hours.

Processing is checked once per minute, up to five times. No POST is retried
automatically. A publish timeout can mean the post succeeded: check --status.
Progress/errors go to stderr; the final result is JSON on stdout.

Do not commit tokens, your local .env, or an API key to GitHub.
`.trim();

class ReelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReelError";
    this.code = code;
    Object.assign(this, details);
  }
}

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean" },
      publish: { type: "boolean" },
      container: { type: "string" },
      status: { type: "string" },
      serve: { type: "boolean" },
      "self-test": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) return { mode: "help" };
  if (values.serve || values["self-test"]) {
    if (Object.keys(values).filter((key) => values[key]).length !== 1) {
      throw new Error("--serve and --self-test must be used on their own.");
    }
    return { mode: values.serve ? "serve" : "self-test" };
  }
  if (values.check && values.publish) {
    throw new Error("Choose --check or --publish, not both.");
  }
  if (values.container !== undefined && !values.publish) {
    throw new Error("--container requires --publish.");
  }
  if (values.status !== undefined && (values.publish || values.check || values.container !== undefined)) {
    throw new Error("--status cannot be combined with --check, --publish, or --container.");
  }
  for (const name of ["container", "status"]) {
    if (values[name] !== undefined && !ID_PATTERN.test(values[name])) {
      throw new Error(`--${name} must be a numeric Instagram container ID.`);
    }
  }
  return {
    mode: values.status !== undefined ? "status" : values.publish ? "publish" : "check",
    containerId: values.container,
    statusId: values.status,
  };
}

function validateVideoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("IG_VIDEO_URL must be a complete public HTTPS MP4 URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("IG_VIDEO_URL must use HTTPS without embedded credentials or a URL fragment.");
  }
  return url.href;
}

function readConfig(env, options) {
  const accessToken = (env.IG_ACCESS_TOKEN || "").trim();
  if (!accessToken || /\s/.test(accessToken)) {
    throw new Error("Set IG_ACCESS_TOKEN in .env to the token only (no 'Bearer ' prefix).");
  }
  const userId = (env.IG_USER_ID || "").trim();
  if (!ID_PATTERN.test(userId)) {
    throw new Error("Set IG_USER_ID in .env to your numeric Instagram professional account ID.");
  }
  const apiVersion = (env.IG_API_VERSION || DEFAULT_VERSION).trim();
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error("IG_API_VERSION must look like v25.0.");
  }
  const shareToFeed = (env.IG_SHARE_TO_FEED ?? "false").trim().toLowerCase();
  if (!["true", "false"].includes(shareToFeed)) {
    throw new Error("IG_SHARE_TO_FEED must be true or false.");
  }
  const caption = env.IG_CAPTION ?? "";
  if (Array.from(caption).length > 2200) {
    throw new Error("IG_CAPTION exceeds Instagram's 2,200-character limit.");
  }
  const needsVideo = options.mode !== "status" && !options.containerId;
  const videoUrl = needsVideo ? validateVideoUrl((env.IG_VIDEO_URL || "").trim()) : undefined;
  return { accessToken, userId, apiVersion, shareToFeed: shareToFeed === "true", caption, videoUrl };
}

function redact(message, token) {
  let result = String(message);
  if (token) {
    result = result.split(token).join("[REDACTED]");
    result = result.split(encodeURIComponent(token)).join("[REDACTED]");
  }
  return result;
}

function createApi(config, fetchImpl = fetch) {
  return async function api(method, path, parameters = {}) {
    const url = new URL(`https://graph.instagram.com/${config.apiVersion}/${path}`);
    const options = {
      method,
      headers: { Authorization: `Bearer ${config.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (method === "GET") {
      url.search = new URLSearchParams(parameters).toString();
    } else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(parameters);
    }

    let response;
    let text;
    try {
      response = await fetchImpl(url, options);
      text = await response.text();
    } catch (error) {
      throw new ReelError("INSTAGRAM_NETWORK_ERROR", redact(
        `${method} /${path}: network/timeout failure: ${error.message}. No automatic retry was made.`,
        config.accessToken,
      ), { ambiguous: method === "POST" });
    }

    let data;
    try {
      // Some Meta responses encode 64-bit IDs as numbers; preserve their exact digits.
      data = JSON.parse(text, (key, value, context) =>
        (key === "id" || key === "user_id") && typeof value === "number" ? context.source : value);
    } catch {
      throw new ReelError("INSTAGRAM_INVALID_RESPONSE",
        `${method} /${path}: non-JSON response (HTTP ${response.status}). No automatic retry was made.`,
        { ambiguous: method === "POST" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ReelError("INSTAGRAM_INVALID_RESPONSE",
        `${method} /${path}: expected a JSON object (HTTP ${response.status}).`,
        { ambiguous: method === "POST" });
    }
    if (!response.ok || data.error) {
      const error = data.error || {};
      const details = [
        `HTTP ${response.status}`,
        error.code !== undefined ? `code ${error.code}` : "",
        error.error_subcode !== undefined ? `subcode ${error.error_subcode}` : "",
        error.fbtrace_id ? `trace ${error.fbtrace_id}` : "",
      ].filter(Boolean).join(", ");
      let hint = "";
      if (error.code === 190) hint = " The token may be invalid or expired; generate a new Instagram Login token.";
      if (error.code === 10 || error.code === 200) {
        hint = " Verify instagram_business_basic and instagram_business_content_publish permissions and app/account access.";
      }
      throw new ReelError("INSTAGRAM_API_ERROR", redact(
        `${method} /${path} (${details}): ${error.message || "Instagram request failed"}.${hint}`,
        config.accessToken,
      ), {
        ambiguous: method === "POST" && (response.status >= 500 || response.ok),
        instagramCode: error.code,
        instagramSubcode: error.error_subcode,
      });
    }
    return data;
  };
}

async function checkAccount(api, userId) {
  const response = await api("GET", "me", { fields: "user_id,username,account_type" });
  const account = Array.isArray(response.data) && response.data.length === 1 ? response.data[0] : response;
  if (!account || typeof account.user_id !== "string" || typeof account.username !== "string") {
    throw new Error("Instagram /me did not return a user_id and username. Check your Instagram Login token.");
  }
  if (account.user_id !== userId) {
    throw new Error(
      `Account mismatch: token belongs to @${account.username} (user_id ${account.user_id}), not IG_USER_ID ${userId}. Nothing was published.`,
    );
  }
  if (!["BUSINESS", "MEDIA_CREATOR"].includes(String(account.account_type).toUpperCase())) {
    throw new Error(`A Business or Creator account is required; account_type was ${account.account_type}.`);
  }
  return { id: account.user_id, username: account.username, account_type: account.account_type };
}

async function checkVideo(videoUrl, fetchImpl = fetch) {
  const response = await fetchImpl(validateVideoUrl(videoUrl), {
    headers: { Range: "bytes=0-1023" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.body) throw new Error("Video server returned no response body.");
  const reader = response.body.getReader();
  try {
    if (![200, 206].includes(response.status)) {
      throw new Error(`Public video download failed (HTTP ${response.status}). Meta must be able to download it without login.`);
    }
    const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (contentType.startsWith("text/") || /json|xml/.test(contentType)) {
      throw new Error("IG_VIDEO_URL returned a web page, not an MP4. Use a public GitHub release download or raw file URL.");
    }
    const sizeHeader = response.status === 206
      ? response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]
      : response.headers.get("content-length");
    const size = sizeHeader === undefined || sizeHeader === null ? null : Number(sizeHeader);
    if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) {
      throw new Error("Video server returned an invalid file size.");
    }
    if (size !== null && size > MAX_VIDEO_BYTES) {
      throw new Error("Video exceeds this script's 300 MB Reel upload limit.");
    }

    let prefix = Buffer.alloc(0);
    while (prefix.length < 12) {
      const { done, value } = await reader.read();
      if (done) break;
      prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 12 - prefix.length)]);
    }
    if (prefix.length < 12 || prefix.toString("ascii", 4, 8) !== "ftyp") {
      throw new Error("The URL did not return an MP4 file signature. An .mp4 filename alone is not sufficient.");
    }
    return {
      content_type: contentType || null,
      size_bytes: size,
      mp4_signature_checked: true,
      note: "Basic download checks only. Instagram still validates duration, codecs, dimensions, and publishing permissions.",
    };
  } finally {
    // A server may ignore Range; never download the entire video just to check it.
    await reader.cancel();
  }
}

async function waitForReady(api, containerId, { log = console.error, sleepImpl = sleep } = {}) {
  for (let attempt = 0; attempt < MAX_STATUS_CHECKS; attempt++) {
    const result = await api("GET", containerId, { fields: "status_code,status" });
    log(`Container ${containerId}: ${result.status_code}`);
    switch (result.status_code) {
      case "FINISHED":
        return;
      case "IN_PROGRESS":
        if (attempt < MAX_STATUS_CHECKS - 1) await sleepImpl(POLL_INTERVAL_MS);
        break;
      case "PUBLISHED":
        throw new ReelError("ALREADY_PUBLISHED",
          `Container ${containerId} is already published. No additional publish request was made.`,
          { publicationConfirmed: true });
      case "ERROR":
      case "EXPIRED":
        throw new ReelError("PROCESSING_FAILED",
          `Container ${containerId} is ${result.status_code}: ${result.status || "No further detail from Instagram"}.`);
      default:
        throw new Error(`Unexpected container status: ${JSON.stringify(result.status_code)}.`);
    }
  }
  throw new ReelError("PROCESSING_TIMEOUT", `Processing did not finish within ${MAX_STATUS_CHECKS} status checks.`);
}

function requireId(response, operation) {
  if (typeof response.id !== "string" || !ID_PATTERN.test(response.id)) {
    throw new Error(`${operation} did not return a valid ID. The request may have succeeded; do not blindly repeat it.`);
  }
  return response.id;
}

async function run(config, options, {
  fetchImpl = fetch, logger = console.error, sleepImpl = sleep, onProgress = () => {},
} = {}) {
  const api = createApi(config, fetchImpl);
  const log = (message) => logger(redact(message, config.accessToken));
  onProgress({ status: "validating" });
  const account = await checkAccount(api, config.userId);
  onProgress({ accountUsername: account.username });
  log(`Verified account: @${account.username} (${account.id}, ${account.account_type}).`);

  if (options.mode === "status") {
    return { account, container_id: options.statusId, ...await api("GET", options.statusId, { fields: "status_code,status" }) };
  }

  let containerId = options.containerId;
  if (!containerId) {
    const video = await checkVideo(config.videoUrl, fetchImpl);
    log(`Public MP4 check passed; file size: ${video.size_bytes ?? "unknown"} bytes.`);
    if (options.mode === "check") {
      return { status: "CHECKS_PASSED_NOT_PUBLISHED", account, video };
    }
    const parameters = {
      media_type: "REELS",
      video_url: config.videoUrl,
      share_to_feed: config.shareToFeed,
    };
    if (config.caption) parameters.caption = config.caption;
    onProgress({ status: "creating" });
    const created = await api("POST", `${config.userId}/media`, parameters);
    containerId = requireId(created, "Container creation");
    log(`Created container: ${containerId}. Save this ID to resume the same upload.`);
  }

  onProgress({ status: "processing", containerId });
  try {
    await waitForReady(api, containerId, { log, sleepImpl });
  } catch (error) {
    throw new ReelError(error.code || "PROCESSING_FAILED",
      `${error.message}\nInspect: node instagram-reel.js --status ${containerId}\nIf still processing or FINISHED, resume: node instagram-reel.js --publish --container ${containerId}`,
      { publicationConfirmed: error.publicationConfirmed },
    );
  }

  let mediaId;
  onProgress({ status: "publishing" });
  try {
    const published = await api("POST", `${config.userId}/media_publish`, { creation_id: containerId });
    mediaId = requireId(published, "Publishing");
  } catch (error) {
    throw new ReelError(error.code || "PUBLISH_FAILED",
      `${error.message}\nThe publish outcome may be unknown. Do NOT create another container.\nCheck: node instagram-reel.js --status ${containerId}\nIf PUBLISHED, the Reel is already posted. If FINISHED, you can resume the same container.`,
      {
        publishAttempted: true,
        ambiguous: error.ambiguous ?? true,
        instagramCode: error.instagramCode,
        instagramSubcode: error.instagramSubcode,
      },
    );
  }
  onProgress({ status: "verifying", mediaId });
  log(`Instagram accepted publication. Media ID: ${mediaId}. Do not republish.`);

  let media;
  try {
    media = await api("GET", mediaId, { fields: "id,permalink,media_product_type" });
    if (media.id !== mediaId || media.media_product_type !== "REELS" || typeof media.permalink !== "string") {
      throw new Error("Media response did not confirm a Reel ID, REELS product type, and permalink.");
    }
  } catch (error) {
    throw new Error(
      `Publication already succeeded (media ID ${mediaId}), but verification failed: ${error.message}\nDo NOT republish; check @${account.username} and container ${containerId}.`,
    );
  }
  return { status: "PUBLISHED", account, container_id: containerId, media_id: mediaId, permalink: media.permalink };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const GITHUB_VIDEO_HOSTS = new Set([
  "github.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com",
  "objects.githubusercontent.com", "user-images.githubusercontent.com",
]);

function githubVideoUrl(value) {
  const url = new URL(validateVideoUrl(value));
  if (!GITHUB_VIDEO_HOSTS.has(url.hostname) || (url.port && url.port !== "443")) {
    throw new ReelError("INVALID_VIDEO_URL", "Use a public HTTPS GitHub release, raw MP4, or uploaded attachment URL.");
  }
  if (url.hostname === "github.com" && /\/(?:blob|tree)\//.test(url.pathname)) {
    throw new ReelError("INVALID_VIDEO_URL", "A GitHub file page is not a video download. Use its raw or release download URL.");
  }
  return url;
}

async function fetchGithubVideo(value, options, fetchImpl = fetch) {
  let url = githubVideoUrl(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Range: "bytes=0-1023" },
      redirect: "manual",
      signal: options.signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new ReelError("VIDEO_DOWNLOAD_FAILED", "Video redirect has no Location header.");
    // Validate every hop before requesting it, not just the original URL.
    url = githubVideoUrl(new URL(location, url).href);
  }
  throw new ReelError("VIDEO_DOWNLOAD_FAILED", "Video download exceeded five redirects.");
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function httpError(statusCode, code, message) {
  return new ReelError(code, message, { statusCode });
}

function validateSubmission(body, apiVersion) {
  const keys = ["requestId", "instagramToken", "instagramUserId", "videoUrl", "caption", "shareToFeed"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !keys.includes(key))) {
    throw httpError(400, "INVALID_INPUT", `Send a JSON object with only: ${keys.join(", ")}.`);
  }
  if (typeof body.requestId !== "string" || !UUID_PATTERN.test(body.requestId)) {
    throw httpError(400, "INVALID_REQUEST_ID", "requestId must be a saved UUID, reused for retries of this video.");
  }
  for (const field of ["instagramToken", "instagramUserId", "videoUrl"]) {
    if (typeof body[field] !== "string" || !body[field].trim() || body[field].length > 4096) {
      throw httpError(400, "INVALID_INPUT", `${field} must be nonempty text, at most 4096 characters. Keep IDs as text.`);
    }
  }
  if (body.caption !== undefined && typeof body.caption !== "string") {
    throw httpError(400, "INVALID_INPUT", "caption must be text.");
  }
  if (body.shareToFeed !== undefined && typeof body.shareToFeed !== "boolean") {
    throw httpError(400, "INVALID_INPUT", "shareToFeed must be a JSON boolean, not quoted text.");
  }
  let config;
  try {
    config = readConfig({
      IG_ACCESS_TOKEN: body.instagramToken,
      IG_USER_ID: body.instagramUserId,
      IG_VIDEO_URL: githubVideoUrl(body.videoUrl).href,
      IG_CAPTION: body.caption ?? "",
      IG_SHARE_TO_FEED: String(body.shareToFeed ?? false),
      IG_API_VERSION: apiVersion,
    }, { mode: "publish" });
  } catch (error) {
    const message = error.message
      .replaceAll("IG_ACCESS_TOKEN", "instagramToken").replaceAll("IG_USER_ID", "instagramUserId")
      .replaceAll("IG_VIDEO_URL", "videoUrl").replaceAll("IG_CAPTION", "caption").replaceAll(" in .env", "");
    throw httpError(400, error.code || "INVALID_INPUT", redact(message, body.instagramToken));
  }
  const fingerprint = digest(JSON.stringify([
    config.userId, config.videoUrl, config.caption, config.shareToFeed,
  ])).toString("hex");
  return { requestId: body.requestId.toLowerCase(), config, fingerprint };
}

function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw httpError(415, "JSON_REQUIRED", "Use Content-Type: application/json.");
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw httpError(415, "ENCODING_UNSUPPORTED", "Send uncompressed JSON.");
  }
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    throw httpError(413, "BODY_TOO_LARGE", "JSON body must not exceed 32 KiB.");
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(httpError(413, "BODY_TOO_LARGE", "JSON body must not exceed 32 KiB."));
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "INVALID_JSON", "Request body is not valid JSON."));
      }
    });
    request.on("error", () => reject(httpError(400, "REQUEST_INTERRUPTED", "Request body was interrupted.")));
    request.on("aborted", () => reject(httpError(400, "REQUEST_INTERRUPTED", "Request body was interrupted.")));
  });
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function createReelServer({
  apiKey = process.env.API_KEY,
  apiVersion = process.env.IG_API_VERSION || DEFAULT_VERSION,
  fetchImpl = fetch,
  sleepImpl = sleep,
  logger = console.error,
  concurrency = 2,
  maxPending = 20,
  maxRetained = 500,
  now = Date.now,
} = {}) {
  if (typeof apiKey !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)) {
    throw new Error("Set API_KEY to a private random key of 32-256 letters, digits, underscores, or hyphens.");
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error("IG_API_VERSION must look like v25.0.");
  const authHash = digest(`Bearer ${apiKey}`);
  const serverId = randomUUID();
  const jobs = new Map();
  const busyAccounts = new Set();
  const tasks = new Set();
  const shutdown = new AbortController();
  let stopping = false;

  const timestamp = () => new Date(now()).toISOString();
  function update(job, fields) {
    Object.assign(job, fields, { updatedAt: timestamp() });
  }
  function finish(job, status, fields) {
    update(job, { status, done: true, success: status === "published" ? true : status === "failed" ? false : null, ...fields });
    logger(JSON.stringify({ event: "job_finished", jobId: job.jobId, status, errorCode: job.error?.code }));
  }
  function errorDetails(error, token) {
    return {
      code: error.code || "PUBLISHING_FAILED",
      message: redact(error.message.split("\n")[0], token).slice(0, 1500),
      instagramCode: error.instagramCode,
      instagramSubcode: error.instagramSubcode,
    };
  }
  function publicJob(job) {
    return {
      jobId: job.jobId, requestId: job.jobId, serverId,
      status: job.status, done: job.done, success: job.success,
      accountUsername: job.accountUsername, containerId: job.containerId,
      mediaId: job.mediaId, reelUrl: job.reelUrl,
      error: job.error, warning: job.warning,
      retryAfterSeconds: job.done ? null : 10,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    };
  }
  const safeFetch = (url, options) => {
    const signal = AbortSignal.any([shutdown.signal, options.signal]);
    return new URL(url).hostname === "graph.instagram.com"
      ? fetchImpl(url, { ...options, signal })
      : fetchGithubVideo(url, { ...options, signal }, fetchImpl);
  };
  const wait = (ms) => sleepImpl(ms, undefined, { signal: shutdown.signal });

  async function reconcile(job, originalError, config) {
    const api = createApi(config, safeFetch);
    let lastReadError;
    for (let attempt = 0; attempt < MAX_STATUS_CHECKS && !stopping; attempt++) {
      try {
        const result = await api("GET", job.containerId, { fields: "status_code,status" });
        if (result.status_code === "PUBLISHED") {
          finish(job, "published", {
            warning: {
              code: "PUBLISH_RESPONSE_LOST",
              message: "Meta confirmed publication after an interrupted response. The Reel URL is unavailable; check your account. Do not repost.",
            },
          });
          return;
        }
        if (["ERROR", "EXPIRED"].includes(result.status_code)) {
          finish(job, "failed", {
            error: { code: "PROCESSING_FAILED", message: `Instagram reports ${result.status_code}.` },
          });
          return;
        }
        if (!["FINISHED", "IN_PROGRESS"].includes(result.status_code)) {
          lastReadError = { message: "Instagram returned an unexpected container status." };
          break;
        }
      } catch (error) {
        lastReadError = errorDetails(error, config.accessToken);
      }
      if (attempt < MAX_STATUS_CHECKS - 1 && !stopping) {
        try {
          await wait(POLL_INTERVAL_MS);
        } catch (error) {
          lastReadError = errorDetails(error, config.accessToken);
          break;
        }
      }
    }
    finish(job, "unknown", {
      error: {
        code: "PUBLISH_OUTCOME_UNKNOWN",
        message: `The publish outcome could not be confirmed. Do not repost; inspect Instagram. ${originalError.message}`,
        ...(lastReadError ? { statusCheckError: lastReadError.message } : {}),
      },
    });
  }

  async function execute(job) {
    const config = job.config;
    try {
      const result = await run(config, { mode: "publish" }, {
        fetchImpl: safeFetch, sleepImpl: wait, logger: () => {},
        onProgress: (fields) => {
          if (stopping && !fields.mediaId) throw new ReelError("SERVER_STOPPING", "Server is shutting down.");
          update(job, fields);
        },
      });
      finish(job, "published", { mediaId: result.media_id, reelUrl: result.permalink });
    } catch (error) {
      const details = errorDetails(error, config.accessToken);
      if (job.mediaId || error.publicationConfirmed) {
        finish(job, "published", {
          warning: { ...details, code: "METADATA_UNAVAILABLE", message: `Publication is confirmed. Do not repost. ${details.message}` },
        });
      } else if (error.publishAttempted && error.ambiguous) {
        update(job, { status: "verifying" });
        await reconcile(job, details, config);
      } else {
        finish(job, "failed", { error: details });
      }
    } finally {
      job.config = null;
    }
  }

  function schedule() {
    while (!stopping && tasks.size < concurrency) {
      const job = [...jobs.values()].find((item) => item.status === "queued" && !busyAccounts.has(item.config.userId));
      if (!job) break;
      const userId = job.config.userId;
      busyAccounts.add(userId);
      const task = execute(job).catch(() => {
        // Only unexpected worker bugs reach this boundary; never assume a POST failed.
        finish(job, job.mediaId ? "published" : "unknown", {
          error: job.mediaId ? null : { code: "INTERNAL_ERROR", message: "Worker failed unexpectedly. Check Instagram before resubmitting." },
          warning: job.mediaId ? { code: "INTERNAL_ERROR", message: "Publication succeeded; result processing failed. Do not repost." } : null,
        });
      }).finally(() => {
        busyAccounts.delete(userId);
        tasks.delete(task);
        schedule();
      });
      tasks.add(task);
    }
  }

  function prune() {
    for (const [id, job] of jobs) {
      if (job.done && now() - Date.parse(job.updatedAt) >= JOB_TTL_MS) jobs.delete(id);
    }
  }
  const cleanup = setInterval(prune, 60_000);
  cleanup.unref();

  async function handle(request, response) {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/health" && ["GET", "HEAD"].includes(request.method)) {
      sendJson(response, stopping ? 503 : 200, { status: stopping ? "stopping" : "ok", serverId, storage: "memory" });
      return;
    }
    if (!timingSafeEqual(digest(request.headers.authorization || ""), authHash)) {
      throw httpError(401, "UNAUTHORIZED", "A valid Authorization: Bearer API_KEY header is required.");
    }
    if (stopping) throw httpError(503, "SERVER_STOPPING", "Server is shutting down; no new job was accepted.");
    if (!request.headers["x-server-id"]) {
      throw httpError(400, "SERVER_ID_REQUIRED", "Get /health and send its serverId as X-Server-ID. Save it with each job.");
    }
    if (request.headers["x-server-id"] !== serverId) {
      throw httpError(409, "SERVER_RESTARTED", "Server restarted; previous jobs may have published. Check Instagram. Do not automatically resubmit.");
    }
    prune();
    if (path === "/reels") {
      if (request.method !== "POST") throw httpError(405, "METHOD_NOT_ALLOWED", "Use POST /reels.");
      const { requestId, config, fingerprint } = validateSubmission(await readJson(request), apiVersion);
      if (stopping) throw httpError(503, "SERVER_STOPPING", "Server is shutting down; no new job was accepted.");
      const existing = jobs.get(requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw httpError(409, "REQUEST_ID_CONFLICT", "This requestId already belongs to different Reel content. The original job was not changed.");
        }
        sendJson(response, 200, publicJob(existing));
        return;
      }
      if (jobs.size >= maxRetained || [...jobs.values()].filter((job) => !job.done).length >= maxPending) {
        throw httpError(429, "QUEUE_FULL", "Job capacity reached; this request was not accepted. Retry later with the SAME requestId and serverId.");
      }
      const job = {
        jobId: requestId, fingerprint, config,
        status: "queued", done: false, success: null,
        accountUsername: null, containerId: null, mediaId: null, reelUrl: null,
        error: null, warning: null, createdAt: timestamp(), updatedAt: timestamp(),
      };
      jobs.set(requestId, job);
      sendJson(response, 202, publicJob(job), { Location: `/reels/${requestId}`, "Retry-After": "10" });
      queueMicrotask(schedule);
      return;
    }
    const match = /^\/reels\/([^/]+)$/.exec(path);
    if (match && UUID_PATTERN.test(match[1])) {
      if (request.method !== "GET") throw httpError(405, "METHOD_NOT_ALLOWED", "Use GET /reels/JOB_ID.");
      const job = jobs.get(match[1].toLowerCase());
      if (!job) throw httpError(404, "JOB_NOT_FOUND", "Job is missing, expired, or lost on restart. Its publication outcome is unknown; check Instagram before resubmitting.");
      sendJson(response, 200, publicJob(job));
      return;
    }
    throw httpError(404, "NOT_FOUND", "Use GET /health, POST /reels, or GET /reels/JOB_ID.");
  }

  const server = createServer({
    requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024,
  }, (request, response) => {
    handle(request, response).catch((error) => {
      const statusCode = error.statusCode || 500;
      const code = error.statusCode ? error.code : "INTERNAL_ERROR";
      logger(JSON.stringify({ event: "request_rejected", statusCode, code }));
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, statusCode, {
          status: ["SERVER_RESTARTED", "JOB_NOT_FOUND"].includes(code) ? "unknown" : "request_error",
          success: null, done: true,
          error: { code, message: error.statusCode ? error.message : "Unexpected server error. Check job status before retrying." },
        }, { Connection: "close", ...(statusCode === 429 ? { "Retry-After": "30" } : {}) });
      }
      request.resume();
    });
  });
  server.maxConnections = 100;
  server.on("clientError", (_error, socket) => {
    logger(JSON.stringify({ event: "request_rejected", code: "INVALID_HTTP" }));
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return {
    server,
    async close() {
      stopping = true;
      clearInterval(cleanup);
      shutdown.abort();
      for (const job of jobs.values()) {
        if (job.status === "queued") {
          finish(job, "failed", { error: { code: "SERVER_STOPPING", message: "Server stopped before this job began." } });
          job.config = null;
        }
      }
      const closed = server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      server.closeAllConnections();
      await Promise.all([...tasks]);
      await closed;
    },
  };
}

async function startServer() {
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  const app = createReelServer();
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "0.0.0.0", resolve);
  });
  console.error(`Reel API listening on port ${port}; storage=memory. Render restarts erase jobs.`);
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      app.close().catch(() => {
        console.error("Server shutdown failed; inspect Instagram before resubmitting jobs.");
        process.exitCode = 1;
      });
    });
  }
}

async function selfTest() {
  const { test } = require("node:test");
  const assert = require("node:assert/strict");
  const apiKey = "self-test-only-key-" + "a".repeat(32);
  const token = "fake-instagram-token-account-a";
  const userId = "17841400000000001";
  const secondUserId = "17841400000000002";
  const mp4 = Buffer.from("000000186674797069736f6d00000200", "hex");
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const input = (name = "success", changes = {}) => ({
    requestId: randomUUID(), instagramToken: token, instagramUserId: userId,
    videoUrl: `https://github.com/test-owner/test-repo/releases/download/test/${name}.mp4`,
    caption: "Test caption #food", shareToFeed: false, ...changes,
  });

  function fakeInstagram() {
    const calls = [];
    const containers = new Map();
    const media = new Map();
    let created = 0;
    let published = 0;
    return {
      calls,
      get created() { return created; },
      get published() { return published; },
      async fetchImpl(value, options) {
        const url = new URL(value);
        const method = options.method || "GET";
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method, headers: options.headers, body });
        if (url.hostname !== "graph.instagram.com") {
          assert.ok(GITHUB_VIDEO_HOSTS.has(url.hostname));
          assert.equal(options.headers.Authorization, undefined);
          return new Response(mp4, { status: 206, headers: {
            "content-type": "application/octet-stream", "content-range": "bytes 0-15/1094815",
          } });
        }
        assert.equal(url.searchParams.has("access_token"), false);
        const path = url.pathname.replace(`/${DEFAULT_VERSION}/`, "");
        if (path === "me") {
          if (options.headers.Authorization.endsWith("invalid-token")) {
            return json({ error: { code: 190, message: "Invalid Instagram token." } }, 400);
          }
          const second = options.headers.Authorization.endsWith("account-b");
          return json({ user_id: second ? secondUserId : userId, username: `test_creator_${second ? "b" : "a"}`, account_type: "MEDIA_CREATOR" });
        }
        if (path.endsWith("/media") && method === "POST") {
          assert.equal(body.media_type, "REELS");
          assert.equal(body.caption, "Test caption #food");
          assert.equal(body.share_to_feed, false);
          const id = String(17900000000000000n + BigInt(++created));
          const name = new URL(body.video_url).pathname.split("/").pop().replace(".mp4", "");
          containers.set(id, { name, reads: 0, published: false });
          if (name === "create-lost") throw new Error(`connection lost ${token}`);
          return json({ id });
        }
        if (path.endsWith("/media_publish") && method === "POST") {
          published++;
          const container = containers.get(body.creation_id);
          assert.ok(container);
          if (container.name === "publish-rejected") {
            return json({ error: { code: 200, message: `Permission denied ${token}` } }, 400);
          }
          if (container.name === "publish-unknown") throw new Error(`timeout ${token}`);
          container.published = true;
          if (container.name === "publish-lost") throw new Error(`connection lost ${token}`);
          const id = String(18000000000000000n + BigInt(published));
          media.set(id, container);
          return json({ id });
        }
        if (containers.has(path)) {
          const container = containers.get(path);
          container.reads++;
          const status = container.published ? "PUBLISHED"
            : container.name === "processing-error" ? "ERROR"
            : container.name === "processing-timeout" || container.reads === 1 ? "IN_PROGRESS" : "FINISHED";
          return json({ id: path, status_code: status, status: `Test ${status}` });
        }
        if (media.has(path)) {
          if (media.get(path).name === "metadata-error") return json({ error: { message: "Temporary metadata failure" } }, 503);
          return json({ id: path, media_product_type: "REELS", permalink: `https://www.instagram.com/reel/test-${path}/` });
        }
        throw new Error(`Unexpected fake API request: ${method} ${path}`);
      },
    };
  }

  async function boot(t, network, extra = {}) {
    const logs = [];
    const app = createReelServer({
      apiKey, apiVersion: DEFAULT_VERSION, fetchImpl: network.fetchImpl,
      logger: (entry) => logs.push(entry),
      sleepImpl: async (ms, value, options) => {
        assert.equal(ms, 60_000);
        await sleep(1, value, options);
      },
      ...extra,
    });
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => app.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.storage, "memory");
    const call = async (method, path, body, headers = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`, "X-Server-ID": health.serverId,
          "Content-Type": "application/json", ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      return { httpStatus: response.status, data: await response.json() };
    };
    return { call, serverId: health.serverId, logs };
  }

  async function completed(client, ids) {
    const deadline = Date.now() + 5000;
    do {
      const results = await Promise.all(ids.map(async (id) => {
        const result = await client.call("GET", `/reels/${id}`);
        assert.equal(result.httpStatus, 200);
        return result.data;
      }));
      if (results.every((result) => result.done)) return results;
      await sleep(5);
    } while (Date.now() < deadline);
    assert.fail("Mock jobs did not finish within five seconds.");
  }

  await test("five rapid HTTP submissions, queue limits, idempotency and exact publish payloads", async (t) => {
    const network = fakeInstagram();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = await boot(t, network, { maxPending: 5, sleepImpl: async () => gate });
    const inputs = Array.from({ length: 5 }, (_, index) => input(`success-${index}`));
    try {
      const started = Date.now();
      const responses = await Promise.all(inputs.map((body) => client.call("POST", "/reels", body)));
      assert.ok(Date.now() - started < 4000, "Five submissions should be accepted without waiting for Instagram processing.");
      for (const result of responses) {
        assert.equal(result.httpStatus, 202);
        assert.equal(result.data.success, null);
        assert.equal(result.data.done, false);
        assert.equal(result.data.retryAfterSeconds, 10);
      }
      const duplicate = await client.call("POST", "/reels", inputs[0]);
      assert.equal(duplicate.httpStatus, 200);
      assert.equal(duplicate.data.jobId, inputs[0].requestId);
      const conflict = await client.call("POST", "/reels", { ...inputs[0], caption: "Different caption" });
      assert.equal(conflict.httpStatus, 409);
      assert.equal(conflict.data.error.code, "REQUEST_ID_CONFLICT");
      const full = await client.call("POST", "/reels", input("extra"));
      assert.equal(full.httpStatus, 429);
      assert.equal(full.data.error.code, "QUEUE_FULL");
      assert.ok(network.created <= 1, "Only one job per Instagram account may be active.");
    } finally {
      release();
    }
    const results = await completed(client, inputs.map((body) => body.requestId));
    assert.equal(network.created, 5);
    assert.equal(network.published, 5);
    for (const result of results) {
      assert.equal(result.status, "published");
      assert.equal(result.success, true);
      assert.equal(result.error, null);
      assert.match(result.reelUrl, /^https:\/\/www\.instagram\.com\/reel\//);
      assert.equal(result.serverId, client.serverId);
    }
    await client.call("POST", "/reels", inputs[0]);
    assert.equal(network.published, 5, "Repeating a completed request must not repost.");
    const creates = network.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/media"));
    assert.deepEqual(creates.map((call) => call.body.video_url), inputs.map((body) => body.videoUrl));
    assert.ok(!JSON.stringify(results).includes(token));
    assert.ok(!client.logs.join("").includes(token));
  });

  await test("two accounts can work concurrently while one account remains serialized", async (t) => {
    const network = fakeInstagram();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = await boot(t, network, { sleepImpl: async () => gate });
    const inputs = [input("account-a-1"), input("account-a-2"), input("account-b-1", {
      instagramToken: "fake-instagram-token-account-b", instagramUserId: secondUserId,
    })];
    try {
      await Promise.all(inputs.map((body) => client.call("POST", "/reels", body)));
      const deadline = Date.now() + 2000;
      while (network.created < 2 && Date.now() < deadline) await sleep(5);
      assert.equal(network.created, 2);
    } finally {
      release();
    }
    await completed(client, inputs.map((body) => body.requestId));
    assert.equal(network.published, 3);
  });

  await test("request validation, authentication, body limit and missing-job semantics", async (t) => {
    const network = fakeInstagram();
    const client = await boot(t, network);
    const cases = [
      [input(), { Authorization: "" }, 401, "UNAUTHORIZED"],
      [input(), { "X-Server-ID": "" }, 400, "SERVER_ID_REQUIRED"],
      [input(), { "Content-Type": "text/plain" }, 415, "JSON_REQUIRED"],
      ["{", {}, 400, "INVALID_JSON"],
      ["x".repeat(MAX_BODY_BYTES + 1), {}, 413, "BODY_TOO_LARGE"],
      [input("x", { instagramUserId: 123 }), {}, 400, "INVALID_INPUT"],
      [input("x", { instagramToken: "Bearer fake" }), {}, 400, "INVALID_INPUT"],
      [input("x", { requestId: "bad" }), {}, 400, "INVALID_REQUEST_ID"],
      [input("x", { caption: "x".repeat(2201) }), {}, 400, "INVALID_INPUT"],
      [input("x", { shareToFeed: "false" }), {}, 400, "INVALID_INPUT"],
      [input("x", { unexpected: true }), {}, 400, "INVALID_INPUT"],
      [input("x", { videoUrl: "https://127.0.0.1/video.mp4" }), {}, 400, "INVALID_VIDEO_URL"],
      [input("x", { videoUrl: "https://github.com.evil.example/video.mp4" }), {}, 400, "INVALID_VIDEO_URL"],
      [input("x", { videoUrl: "https://github.com/owner/repo/blob/main/video.mp4" }), {}, 400, "INVALID_VIDEO_URL"],
    ];
    for (const [body, headers, expectedStatus, expectedCode] of cases) {
      const result = await client.call("POST", "/reels", body, headers);
      assert.equal(result.httpStatus, expectedStatus, expectedCode);
      assert.equal(result.data.error.code, expectedCode);
      assert.equal(result.data.success, null);
    }
    const missing = await client.call("GET", `/reels/${randomUUID()}`);
    assert.equal(missing.httpStatus, 404);
    assert.equal(missing.data.status, "unknown");
    assert.equal(missing.data.success, null);
    assert.equal((await client.call("GET", "/reels")).httpStatus, 405);
    assert.equal(network.calls.length, 0);
  });

  await test("confirmed failures, ambiguous POSTs and metadata failures have distinct outcomes", async (t) => {
    const network = fakeInstagram();
    const client = await boot(t, network);
    const scenarios = [
      ["processing-error", "failed", false, "PROCESSING_FAILED"],
      ["processing-timeout", "failed", false, "PROCESSING_TIMEOUT"],
      ["create-lost", "failed", false, "INSTAGRAM_NETWORK_ERROR"],
      ["publish-rejected", "failed", false, "INSTAGRAM_API_ERROR"],
      ["publish-lost", "published", true, null],
      ["publish-unknown", "unknown", null, "PUBLISH_OUTCOME_UNKNOWN"],
      ["metadata-error", "published", true, null],
      ["bad-token", "failed", false, "INSTAGRAM_API_ERROR"],
      ["wrong-account", "failed", false, "PUBLISHING_FAILED"],
    ];
    for (const [name, status, success, code] of scenarios) {
      const body = input(name, name === "bad-token" ? { instagramToken: "invalid-token" }
        : name === "wrong-account" ? { instagramUserId: secondUserId } : {});
      assert.equal((await client.call("POST", "/reels", body)).httpStatus, 202);
      const [result] = await completed(client, [body.requestId]);
      assert.equal(result.status, status, name);
      assert.equal(result.success, success, name);
      assert.equal(result.error?.code ?? null, code, name);
      assert.ok(!JSON.stringify(result).includes(token));
      if (name === "publish-lost" || name === "metadata-error") {
        assert.ok(result.warning);
        assert.equal(result.reelUrl, null);
      }
    }
    assert.equal(network.created, 7);
    assert.equal(network.published, 4, "Never retry an ambiguous POST.");
    assert.ok(!client.logs.join("").includes(token));
  });

  await test("a server restart rejects an old submission instead of silently creating a duplicate", async (t) => {
    const first = await boot(t, fakeInstagram());
    const network = fakeInstagram();
    const second = await boot(t, network);
    assert.notEqual(first.serverId, second.serverId);
    const result = await second.call("POST", "/reels", input(), { "X-Server-ID": first.serverId });
    assert.equal(result.httpStatus, 409);
    assert.equal(result.data.error.code, "SERVER_RESTARTED");
    assert.equal(result.data.success, null);
    assert.equal(network.calls.length, 0);
  });

  await test("completed jobs have bounded retention without silently evicting duplicate protection", async (t) => {
    let clock = Date.now();
    const client = await boot(t, fakeInstagram(), { maxRetained: 1, now: () => clock });
    const body = input();
    await client.call("POST", "/reels", body);
    await completed(client, [body.requestId]);
    assert.equal((await client.call("POST", "/reels", body)).httpStatus, 200);
    assert.equal((await client.call("POST", "/reels", input())).httpStatus, 429);
    clock += JOB_TTL_MS;
    const expired = await client.call("GET", `/reels/${body.requestId}`);
    assert.equal(expired.httpStatus, 404);
    assert.equal(expired.data.success, null);
  });

  await test("video redirects are allowlisted at every hop and never receive credentials", async () => {
    let calls = 0;
    await assert.rejects(fetchGithubVideo(input().videoUrl, {}, async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private" } });
    }), /public HTTPS GitHub/);
    assert.equal(calls, 1);
    calls = 0;
    await fetchGithubVideo(input().videoUrl, {}, async (url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "manual");
      return calls === 1
        ? new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/test/video.mp4" } })
        : new Response(mp4);
    });
    assert.equal(calls, 2);
  });

  await test("server startup fails closed without a strong API key", () => {
    assert.throws(() => createReelServer({ apiKey: "" }), /API_KEY/);
    assert.throws(() => createReelServer({ apiKey: "short" }), /API_KEY/);
    assert.equal(parseOptions(["--serve"]).mode, "serve");
    assert.equal(parseOptions(["--self-test"]).mode, "self-test");
    assert.throws(() => parseOptions(["--serve", "--publish"]), /on their own/);
  });
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("This script requires Node.js 22 or newer.");
  }
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === "help") {
    console.log(HELP);
    return;
  }
  if (options.mode === "self-test") {
    await selfTest();
    return;
  }
  if (options.mode === "serve") {
    await startServer();
    return;
  }
  const envFile = join(__dirname, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = readConfig(process.env, options);
  const result = await run(config, options);
  console.log(redact(JSON.stringify(result, null, 2), config.accessToken));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(redact(`ERROR: ${error.message}`, process.env.IG_ACCESS_TOKEN?.trim()));
    process.exitCode = 1;
  });
}

module.exports = {
  parseOptions, readConfig, redact, createApi, checkAccount, checkVideo, waitForReady, run,
  createReelServer, fetchGithubVideo,
};
