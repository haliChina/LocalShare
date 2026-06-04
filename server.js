// server.js
// Windows intranet file sharing service.
// - When run via `node server.js`: serves the source-tree views/ and public/ directly.
// - When run as a pkg-packed .exe: views/ and public/ are loaded from the embedded
//   snapshot, while the shared directory lives next to the .exe so users can
//   drop files in/out of it.
//
// Features:
//   - Recursive folder browsing via path segments in the URL.
//   - Breadcrumb navigation.
//   - In-browser preview for images, text, code, markdown, JSON, audio, video.
//   - One-click folder download as a streamed zip archive.
//   - Path-preserving uploads: relative directory structure is kept.
//   - HTTP Basic Auth (--auth user:pass or AUTH env).
//
// CLI options:
//   --port <n>          Listen on port n (overrides PORT env var). Default 3000.
//   --auth <user>:<pw>  Enable HTTP Basic Auth with the given credentials.
//                       Overrides AUTH env var. Disables auth if set to "off"/"none".
//   --help              Show usage information.

'use strict';

const express = require('express');
const archiver = require('archiver');
const Busboy = require('busboy');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Runtime environment helpers
// ---------------------------------------------------------------------------
const IS_PKG = typeof process.pkg !== 'undefined';

// In a pkg snapshot, __dirname points inside the virtual filesystem.
// Resources (views, public) must be read from the snapshot; the shared
// directory, however, must be on the real filesystem next to the .exe so
// that user-uploaded files persist across runs.
const RESOURCE_DIR = IS_PKG ? __dirname : path.resolve(__dirname);
const EXE_DIR = IS_PKG ? path.dirname(process.execPath) : path.resolve(__dirname);

const SHARED_DIR = path.join(EXE_DIR, 'shared');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function printHelpAndExit(code) {
  const exeName = IS_PKG ? 'fileshare.exe' : 'node server.js';
  console.log('');
  console.log('  内网文件共享服务 - 用法');
  console.log('');
  console.log('  ' + exeName + ' [options]');
  console.log('');
  console.log('  Options:');
  console.log('    --port <n>          监听端口 (默认 3000, 也可用环境变量 PORT)');
  console.log('    --auth <user>:<pw>  启用 HTTP Basic Auth (也可用环境变量 AUTH)');
  console.log('    --title <name>      自定义服务名称 (也可用环境变量 TITLE / NAME)');
  console.log('                        传 "off" 或 "none" 关闭鉴权');
  console.log('    --help, -h          显示本帮助');
  console.log('');
  console.log('  Examples:');
  console.log('    ' + exeName + ' --port 8080');
  console.log('    ' + exeName + ' --port 8080 --auth admin:secret123');
  console.log('    ' + exeName + ' --title "我的共享"');
  console.log('    set PORT=8080&& ' + exeName + ' --auth admin:secret123');
  console.log('');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { port: null, auth: null, title: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) {
        console.error('[error] --port expects a number between 1 and 65535, got: ' + v);
        process.exit(2);
      }
      opts.port = n;
    } else if (a === '--auth' || a === '-a') {
      opts.auth = argv[++i];
      if (opts.auth === undefined) {
        console.error('[error] --auth expects a value like user:password');
        process.exit(2);
      }
    } else if (a === '--title' || a === '--name' || a === '-t') {
      opts.title = argv[++i];
      if (opts.title === undefined) {
        console.error('[error] --title expects a custom app name string');
        process.exit(2);
      }
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a && a.indexOf('--') === 0) {
      console.error('[error] unknown option: ' + a);
      printHelpAndExit(2);
    }
  }
  return opts;
}

const cliOpts = parseArgs(process.argv.slice(2));
if (cliOpts.help) printHelpAndExit(0);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function resolvePort() {
  if (cliOpts.port !== null) return cliOpts.port;
  const envPort = parseInt(process.env.PORT, 10);
  if (Number.isFinite(envPort) && envPort > 0 && envPort < 65536) return envPort;
  return 3000;
}

function resolveAuth() {
  // Priority: CLI --auth > env AUTH > none
  let raw = null;
  if (cliOpts.auth !== null) raw = cliOpts.auth;
  else if (process.env.AUTH) raw = process.env.AUTH;

  if (raw === null) return { enabled: false, user: '', pass: '' };
  if (raw === 'off' || raw === 'none' || raw === 'disabled' || raw === '') {
    return { enabled: false, user: '', pass: '' };
  }
  const idx = raw.indexOf(':');
  if (idx < 0) {
    console.error('[error] --auth / AUTH must be in the form user:password');
    process.exit(2);
  }
  const user = raw.slice(0, idx);
  const pass = raw.slice(idx + 1);
  if (!user || !pass) {
    console.error('[error] --auth / AUTH requires both user and password to be non-empty');
    process.exit(2);
  }
  return { enabled: true, user: user, pass: pass };
}

function resolveTitle() {
  if (cliOpts.title !== null && cliOpts.title !== undefined) return cliOpts.title;
  if (process.env.TITLE) return process.env.TITLE;
  if (process.env.NAME) return process.env.NAME;
  return '典藏室';
}

const PORT = resolvePort();
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB
const AUTH = resolveAuth();
const TITLE = resolveTitle();
// HTTP header values must be ASCII, so the realm is in English.
const AUTH_REALM = 'Intranet File Share';
// 1 MB preview cap (server-side). Larger files fall back to download.
const PREVIEW_MAX_BYTES = 1 * 1024 * 1024;

// Ensure shared directory exists.
try {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
} catch (err) {
  console.error('[fatal] cannot create shared directory:', SHARED_DIR, err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = iface.family || (typeof iface.family === 'number' && iface.family === 4 ? 'IPv4' : null);
      const isIPv4 = family === 'IPv4' || iface.family === 4;
      if (isIPv4 && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

function getPrimaryIPv4() {
  const addrs = getLocalIPv4Addresses();
  return addrs.length > 0 ? addrs[0] : '127.0.0.1';
}

// ---------------------------------------------------------------------------
// File / path helpers
// ---------------------------------------------------------------------------
// A helper to recover UTF-8 encoding from strings decoded as latin1 by busboy
function decodeUTF8(str) {
  if (!str) return str;
  try {
    const buf = Buffer.from(str, 'latin1');
    const decoded = buf.toString('utf8');
    if (decoded.indexOf('\uFFFD') === -1) {
      return decoded;
    }
  } catch (e) {
    // Fall back to original
  }
  return str;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return value.toFixed(value < 10 ? 2 : 1) + ' ' + units[unitIndex];
}

function formatTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// File-type classification used by both the listing UI and the preview handler.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.xml', '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.py', '.rb', '.php', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.h', '.hpp', '.cpp', '.cc', '.cs', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.cmd', '.sql', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.lua', '.r']);
const TEXT_EXT = new Set(['.txt', '.log', '.md', '.markdown', '.csv', '.tsv']);
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.lzma']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.ogv']);
const DOC_EXT = new Set(['.pdf']);

function classifyFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (DOC_EXT.has(ext)) return 'pdf';
  if (CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

// Path safety: turn an arbitrary user-supplied relative path into an
// absolute path that we know is inside SHARED_DIR. Returns null on attack.
function resolveSafePath(relPath) {
  if (relPath === undefined || relPath === null) return null;
  // Reject NUL bytes and backslashes (we are path-joining on POSIX, but the
  // .exe runs on Windows where \ is a separator too).
  if (typeof relPath !== 'string' || relPath.indexOf('\0') !== -1) return null;
  // Normalise: trim, replace backslashes with forward slashes for splitting,
  // but keep the original separators when joining.
  const parts = relPath.split(/[/\\]+/).filter(function (p) { return p.length > 0; });
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
  }
  let full = SHARED_DIR;
  for (const p of parts) {
    full = path.join(full, p);
  }
  const resolved = path.resolve(full);
  const resolvedShared = path.resolve(SHARED_DIR);
  if (resolved !== resolvedShared && resolved.indexOf(resolvedShared + path.sep) !== 0) {
    return null;
  }
  return resolved;
}

// Convert a URL-style relative path (forward slashes) into the form used
// in HTML hrefs (URI-encoded segments joined by '/').
function urlJoin(parts) {
  return parts.map(function (p) { return encodeURIComponent(p); }).join('/');
}

// Recursively collect every file path under `dir` (relative to SHARED_DIR).
// Returns { totalBytes, fileCount, errors }.
function collectAllFiles(dir, baseRel) {
  const result = { totalBytes: 0, fileCount: 0, errors: [] };
  function walk(absDir, relSoFar) {
    let names;
    try {
      names = fs.readdirSync(absDir);
    } catch (err) {
      result.errors.push({ path: relSoFar, message: err.message });
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const abs = path.join(absDir, name);
      const rel = relSoFar ? relSoFar + '/' + name : name;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (err) {
        result.errors.push({ path: rel, message: err.message });
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, rel);
      } else if (st.isFile()) {
        result.totalBytes += st.size;
        result.fileCount += 1;
      }
    }
  }
  walk(dir, baseRel);
  return result;
}

function listDirectory(dirAbs, relDir) {
  // relDir is the directory's path relative to SHARED_DIR ('' for root).
  let names;
  try {
    names = fs.readdirSync(dirAbs);
  } catch (err) {
    return { entries: [], breadcrumb: [], parent: null, relDir: relDir, total: 0, folderCount: 0, fileCount: 0 };
  }
  const entries = [];
  let folderCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dirAbs, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (err) {
      continue;
    }
    const rel = relDir ? relDir + '/' + name : name;
    if (stat.isDirectory()) {
      folderCount += 1;
      // Count files inside for badge.
      const sub = collectAllFiles(full, rel);
      entries.push({
        type: 'folder',
        name: name,
        relPath: rel,
        sizeBytes: sub.totalBytes,
        sizeText: sub.fileCount + ' 项' + (sub.fileCount > 0 ? ' · ' + formatSize(sub.totalBytes) : ''),
        mtime: stat.mtimeMs,
        mtimeText: formatTime(stat.mtimeMs),
        childCount: sub.fileCount,
      });
    } else if (stat.isFile()) {
      fileCount += 1;
      totalBytes += stat.size;
      entries.push({
        type: 'file',
        kind: classifyFile(name),
        name: name,
        relPath: rel,
        sizeBytes: stat.size,
        sizeText: formatSize(stat.size),
        mtime: stat.mtimeMs,
        mtimeText: formatTime(stat.mtimeMs),
      });
    }
  }
  // Folders first (alpha), then files (newest first).
  entries.sort(function (a, b) {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (a.type === 'folder') return a.name.localeCompare(b.name, 'zh-Hans-CN');
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  const breadcrumb = [{ name: '根目录', relPath: '' }];
  if (relDir) {
    const segs = relDir.split('/');
    let acc = '';
    for (const seg of segs) {
      acc = acc ? acc + '/' + seg : seg;
      breadcrumb.push({ name: seg, relPath: acc });
    }
  }
  return {
    entries: entries,
    breadcrumb: breadcrumb,
    parent: relDir ? relDir.split('/').slice(0, -1).join('/') : null,
    relDir: relDir,
    total: entries.length,
    folderCount: folderCount,
    fileCount: fileCount,
    totalBytes: totalBytes,
    totalBytesText: formatSize(totalBytes),
  };
}

// ---------------------------------------------------------------------------
// Multipart upload handler (busboy-based, supports per-file relPath fields)
// ---------------------------------------------------------------------------
// We use busboy directly so we can:
//   - Resolve the per-file relPath from a sibling form field at write time
//     (multer's storage.destination runs before all body fields are parsed).
//   - Stream large files to disk without buffering in memory.
//   - Enforce a single overall file-count and per-file size cap.
function handleUpload(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('multipart/form-data') !== 0) {
    return res.status(400).send('Expected multipart/form-data.');
  }
  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { files: 200, fileSize: MAX_FILE_SIZE },
    });
  } catch (err) {
    return res.status(400).send('Cannot parse multipart body: ' + err.message);
  }

  // form fields may arrive in any order; we accumulate them in a per-field
  // queue so each file can pop the relPath that was sent for it.
  // The browser JS sends relPath_<field> immediately before each file, so
  // the queues keep them aligned 1:1.
  const fields = Object.create(null);
  const result = { files: [], errors: [] };
  let aborted = false;

  function abort(status, msg) {
    if (aborted) return;
    aborted = true;
    try { req.unpipe(busboy); } catch (e) { /* ignore */ }
    try { busboy.destroy(); } catch (e) { /* ignore */ }
    res.status(status).send(msg);
  }

  busboy.on('field', function (name, val) {
    if (aborted) return;
    let sval = String(val);
    sval = decodeUTF8(sval);
    if (!fields[name]) fields[name] = [];
    fields[name].push(sval);
  });

  // In busboy 1.x the file event is emitted as
  //   (fieldname, fileStream, info)
  // where info is { filename, encoding, mimeType }.
  busboy.on('file', function (fieldname, fileStream, info) {
    if (aborted) {
      fileStream.resume();
      return;
    }
    let filename = info && typeof info.filename === 'string' ? info.filename : '';
    filename = decodeUTF8(filename);
    if (!filename) filename = 'untitled';
    // The matching form field is "relPath_" + fieldname, sent by the client.
    // Pop the next queued value so multiple files with the same fieldname
    // each get their own relPath. If the queue is empty, fall back to a
    // single shared "relPath" field, then to the file's own name.
    const queueKey = 'relPath_' + fieldname;
    const queue = fields[queueKey] || [];
    let rel = '';
    if (queue.length > 0) {
      rel = queue.shift();
    } else if (fields.relPath && fields.relPath.length > 0) {
      rel = fields.relPath.shift();
    } else {
      rel = filename;
    }
    if (typeof rel !== 'string') rel = String(rel || '');
    rel = rel.split(/[/\\]+/).filter(function (p) { return p.length > 0; }).join('/');
    if (rel.endsWith('/' + filename) || rel === filename) {
      rel = rel.slice(0, rel.length - filename.length).replace(/[/]+$/, '');
    }
    let targetDir = SHARED_DIR;
    if (rel) {
      const safe = resolveSafePath(rel);
      if (!safe) {
        fileStream.resume(); // drain
        result.errors.push({ field: fieldname, name: filename, message: 'Invalid upload path: ' + rel });
        return;
      }
      targetDir = safe;
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      fileStream.resume();
      result.errors.push({ field: fieldname, name: filename, message: err.message });
      return;
    }
    // Pick a non-colliding filename.
    let target = path.basename(filename);
    let counter = 1;
    const ext = path.extname(target);
    const stem = ext ? target.slice(0, -ext.length) : target;
    while (fs.existsSync(path.join(targetDir, target))) {
      target = stem + ' (' + counter + ')' + ext;
      counter += 1;
    }
    const absTarget = path.join(targetDir, target);
    const writeStream = fs.createWriteStream(absTarget);
    let truncated = false;
    fileStream.on('limit', function () {
      truncated = true;
    });
    fileStream.pipe(writeStream);
    writeStream.on('error', function (err) {
      result.errors.push({ field: fieldname, name: filename, message: 'Write error: ' + err.message });
    });
    writeStream.on('finish', function () {
      if (truncated) {
        try { fs.unlinkSync(absTarget); } catch (e) { /* ignore */ }
        result.errors.push({ field: fieldname, name: filename, message: 'File exceeds size limit (' + formatSize(MAX_FILE_SIZE) + ')' });
        return;
      }
      const stat = fs.statSync(absTarget);
      result.files.push({
        field: fieldname,
        name: target,
        relPath: rel ? rel + '/' + target : target,
        size: stat.size,
      });
    });
  });

  busboy.on('error', function (err) {
    abort(400, 'Upload error: ' + err.message);
  });
  busboy.on('finish', function () {
    if (aborted) return;
    req.uploadResult = result;
    next();
  });

  req.pipe(busboy);
}

// ---------------------------------------------------------------------------
// HTTP Basic Auth helpers
// ---------------------------------------------------------------------------
function checkBasicAuth(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return false;
  if (headerValue.indexOf('Basic ') !== 0) return false;
  let decoded;
  try {
    decoded = Buffer.from(headerValue.slice(6).trim(), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  return decoded === AUTH.user + ':' + AUTH.pass;
}

function requireBasicAuth(req, res, next) {
  if (!AUTH.enabled) return next();
  if (checkBasicAuth(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="' + AUTH_REALM + '", charset="UTF-8"');
  res.status(401).send('Unauthorized');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(RESOURCE_DIR, 'views'));
app.set('trust proxy', false);

// Static assets: protect with auth so styles/scripts/icons don't bypass it.
app.use('/static', requireBasicAuth, express.static(path.join(RESOURCE_DIR, 'public'), {
  etag: true,
  maxAge: 0,
}));

// Multipart body parser for /upload. We don't need urlencoded parsing for the
// UI, but it's harmless to enable.
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Routes --------------------------------------------------------------------

// Catch-all "/" + "/browse/...". We route by URL-decoded path segments.
function handleIndex(req, res) {
  const rawSub = req.params[0] || '';
  const sub = decodeURIComponent(rawSub);
  const target = resolveSafePath(sub);
  if (!target) {
    res.status(400).send('Invalid path.');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    res.status(404).render('error', {
      title: TITLE,
      appName: TITLE,
      message: '路径不存在',
      detail: sub || '/',
      backHref: '/',
    });
    return;
  }
  if (!stat.isDirectory()) {
    res.status(400).render('error', {
      title: TITLE,
      appName: TITLE,
      message: '不是一个文件夹',
      detail: sub,
      backHref: '/',
    });
    return;
  }
  const view = listDirectory(target, sub);
  const host = req.hostname && req.hostname !== '::1' && req.hostname !== '127.0.0.1'
    ? req.hostname
    : getPrimaryIPv4();
  res.render('index', {
    title: TITLE,
    appName: TITLE,
    currentDir: view,
    host: host,
    port: PORT,
    sharedDir: SHARED_DIR,
    authEnabled: AUTH.enabled,
    authUser: AUTH.user,
    href: function (sub) {
      if (!sub) return '/';
      return '/browse/' + sub.split('/').map(encodeURIComponent).join('/');
    },
  });
}

app.get('/', requireBasicAuth, function (req, res) { handleIndex(req, res); });
app.get(/^\/browse\/(.*)$/, requireBasicAuth, function (req, res) { handleIndex(req, res); });

// Upload (preserves relative paths from folder picking).
// The route regex captures the optional sub-path with a leading slash (e.g.
// "/foo/bar" or ""), which we strip before treating it as a relative path.
app.post(/\/upload(\/.*)?$/, requireBasicAuth, handleUpload, function (req, res) {
  // If any file had a per-file error (invalid path, write error, etc.),
  // surface a 400 with the first error message. We only redirect on a clean
  // upload, so the client never thinks a traversal attempt succeeded.
  const result = req.uploadResult;
  if (result && result.errors && result.errors.length > 0) {
    res.status(400).send('Upload error: ' + result.errors[0].message);
    return;
  }
  // Redirect back to the directory we uploaded into, if known.
  let rawSub = (req.params && req.params[0]) || '';
  if (rawSub.startsWith('/')) rawSub = rawSub.slice(1);
  const sub = decodeURIComponent(rawSub);
  if (sub) {
    res.redirect('/browse/' + urlJoin(sub.split('/')));
  } else {
    res.redirect('/');
  }
});

// Upload errors (busboy emits them on the request stream). Most are caught
// inside handleUpload; this is a final safety net.
app.use(function (err, req, res, next) {
  if (err && err.message && err.message.indexOf('Invalid upload path') === 0) {
    res.status(400).send(err.message);
    return;
  }
  next(err);
});

// File download (single file). /raw/<encoded path...>
app.get(/^\/raw\/(.*)$/, requireBasicAuth, function (req, res) {
  const sub = decodeURIComponent(req.params[0] || '');
  const filePath = resolveSafePath(sub);
  if (!filePath) {
    res.status(400).send('Invalid path.');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    res.status(404).send('Not found.');
    return;
  }
  if (!stat.isFile()) {
    res.status(400).send('Not a file.');
    return;
  }
  res.download(filePath, path.basename(filePath), function (err) {
    if (err && !res.headersSent) {
      res.status(500).send('Download error: ' + err.message);
    }
  });
});

// Folder zip download. /zip/<encoded path...>
app.get(/^\/zip\/(.*)$/, requireBasicAuth, function (req, res) {
  const sub = decodeURIComponent(req.params[0] || '');
  const dirAbs = resolveSafePath(sub);
  if (!dirAbs) {
    res.status(400).send('Invalid path.');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(dirAbs);
  } catch (err) {
    res.status(404).send('Not found.');
    return;
  }
  if (!stat.isDirectory()) {
    res.status(400).send('Not a folder.');
    return;
  }
  // Decide a safe zip name.
  const baseName = sub ? sub.split('/').filter(Boolean).pop() : 'shared';
  const zipName = baseName + '.zip';

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(zipName) + '"');

  const archive = archiver('zip', { zlib: { level: 0 } }); // store-only for speed
  archive.on('warning', function (err) {
    if (err.code === 'ENOENT') {
      console.warn('[zip] warning:', err.message);
    } else {
      throw err;
    }
  });
  archive.on('error', function (err) {
    console.error('[zip] error:', err.message);
    if (!res.headersSent) res.status(500).send('Zip error: ' + err.message);
  });
  archive.pipe(res);

  const rootLabel = sub ? sub.split('/').filter(Boolean).pop() : 'shared';
  // Add the directory itself, then its contents.
  archive.directory(dirAbs, rootLabel, function (entry) {
    if (entry.name.startsWith('.')) return false; // skip dotfiles
    return entry;
  });
  archive.finalize();
});

// Preview API. /preview/<encoded path...>  (returns JSON for files <= 1 MB).
app.get(/^\/preview\/(.*)$/, requireBasicAuth, function (req, res) {
  const sub = decodeURIComponent(req.params[0] || '');
  const filePath = resolveSafePath(sub);
  if (!filePath) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(400).json({ error: 'Not a file' });
    return;
  }
  const kind = classifyFile(path.basename(filePath));
  if (kind === 'image' || kind === 'audio' || kind === 'video') {
    // The browser can stream these directly via the raw endpoint.
    res.json({
      kind: kind,
      name: path.basename(filePath),
      size: stat.size,
      sizeText: formatSize(stat.size),
      mtimeText: formatTime(stat.mtimeMs),
      rawUrl: '/raw/' + urlJoin(sub.split('/')),
    });
    return;
  }
  if (kind !== 'text' && kind !== 'code') {
    res.json({ kind: 'unsupported', name: path.basename(filePath), size: stat.size, sizeText: formatSize(stat.size), mtimeText: formatTime(stat.mtimeMs), rawUrl: '/raw/' + urlJoin(sub.split('/')) });
    return;
  }
  if (stat.size > PREVIEW_MAX_BYTES) {
    res.json({ kind: kind, name: path.basename(filePath), tooLarge: true, size: stat.size, sizeText: formatSize(stat.size), mtimeText: formatTime(stat.mtimeMs), rawUrl: '/raw/' + urlJoin(sub.split('/')) });
    return;
  }
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Read error: ' + err.message });
    return;
  }
  let text;
  // Best-effort UTF-8 decode with a fallback to binary.
  try {
    text = content.toString('utf8');
    if (text.indexOf('\uFFFD') !== -1 && Buffer.byteLength(text, 'utf8') !== stat.size) {
      // Likely a binary file mislabelled as text. Show first 200 bytes as latin1.
      text = content.toString('latin1');
    }
  } catch (e) {
    text = content.toString('latin1');
  }
  res.json({
    kind: kind,
    name: path.basename(filePath),
    size: stat.size,
    sizeText: formatSize(stat.size),
    mtimeText: formatTime(stat.mtimeMs),
    text: text,
    rawUrl: '/raw/' + urlJoin(sub.split('/')),
  });
});

// Health check (always public)
app.get('/healthz', function (req, res) {
  res.json({ ok: true, sharedDir: SHARED_DIR, authEnabled: AUTH.enabled });
});

// 404 handler
app.use(function (req, res) {
  res.status(404).send('Not found.');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, function () {
  const banner = '==================================================';
  console.log(banner);
  console.log('  内网文件共享服务 [' + TITLE + '] 已启动');
  console.log('  共享根目录: ' + SHARED_DIR);
  if (AUTH.enabled) {
    console.log('  鉴权:     已启用 (用户名: ' + AUTH.user + ')');
  } else {
    console.log('  鉴权:     未启用 (所有人可访问)');
  }
  const primary = getPrimaryIPv4();
  console.log('  本机内网 IP: ' + primary);
  console.log('  访问地址:');
  console.log('    http://127.0.0.1:' + PORT);
  console.log('    http://' + primary + ':' + PORT);
  const addrs = getLocalIPv4Addresses();
  if (addrs.length > 1) {
    console.log('  其他内网地址:');
    addrs.slice(1).forEach(function (a) {
      console.log('    http://' + a + ':' + PORT);
    });
  }
  console.log('  按 Ctrl+C 停止服务');
  console.log(banner);
});

function shutdown(signal) {
  console.log('\n[shutdown] received ' + signal + ', closing server...');
  server.close(function () {
    process.exit(0);
  });
  setTimeout(function () { process.exit(0); }, 5000).unref();
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
