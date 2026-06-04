// scripts/copy-assets.js
// Copy Bootstrap CSS/JS from node_modules to public/ so the app works fully offline
// and so pkg can embed the assets in the final .exe.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const NODE_MODULES = path.join(ROOT, 'node_modules');

const COPIES = [
  {
    from: path.join(NODE_MODULES, 'bootstrap', 'dist', 'css', 'bootstrap.min.css'),
    to: path.join(PUBLIC_DIR, 'css', 'bootstrap.min.css'),
  },
  {
    from: path.join(NODE_MODULES, 'bootstrap', 'dist', 'js', 'bootstrap.bundle.min.js'),
    to: path.join(PUBLIC_DIR, 'js', 'bootstrap.bundle.min.js'),
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyOne(item) {
  if (!fs.existsSync(item.from)) {
    // Bootstrap is not installed (e.g. user only installed prod deps). Skip silently.
    return false;
  }
  ensureDir(path.dirname(item.to));
  fs.copyFileSync(item.from, item.to);
  return true;
}

function main() {
  let copied = 0;
  for (const item of COPIES) {
    if (copyOne(item)) copied += 1;
  }
  if (copied > 0) {
    console.log('[copy-assets] Copied ' + copied + ' file(s) from node_modules to public/.');
  } else {
    console.log('[copy-assets] Bootstrap not found in node_modules, skipping.');
  }
}

main();
