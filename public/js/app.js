/* 典藏室 / Archives — client-side interactions
   - Search filter (with / shortcut, ESC to clear)
   - View toggle (grid/list) with localStorage persistence
   - Drag & drop / click upload with XHR progress
   - Preview drawer (images, video, audio, text, code, PDF, unsupported fallback)
   - ESC to close drawer
*/

(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  function humanSize(bytes) {
    if (bytes === 0 || bytes == null) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    var v = bytes / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)) + ' ' + units[i];
  }

  function qs(root, sel) { return (root || document).querySelector(sel); }
  function qsa(root, sel) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // --------------------------------------------------------- search filter
  var searchInput = qs(document, '#search');
  var entries = qs(document, '#entries');

  function applyFilter(value) {
    if (!entries) return;
    var q = String(value || '').trim().toLowerCase();
    qsa(entries, '.entry').forEach(function (el) {
      var name = el.getAttribute('data-name') || '';
      el.classList.toggle('is-hidden', q && name.indexOf(q) === -1);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () { applyFilter(searchInput.value); });
  }

  // keyboard shortcut: "/" to focus the search box (skip when typing)
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (searchInput) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  });

  // ESC to close drawer or clear search
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (drawer && !drawer.hidden) { closeDrawer(); return; }
    if (searchInput && document.activeElement === searchInput && searchInput.value) {
      searchInput.value = '';
      applyFilter('');
    }
  });

  // -------------------------------------------------------- view toggle
  var viewButtons = qsa(document, '.view-btn');
  var VIEW_KEY = 'fileshare.view';

  function setView(view) {
    if (!entries) return;
    view = view === 'list' ? 'list' : 'grid';
    entries.classList.toggle('view-grid', view === 'grid');
    entries.classList.toggle('view-list', view === 'list');
    entries.setAttribute('data-view', view);
    viewButtons.forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === view);
    });
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
  }

  viewButtons.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
  });

  try {
    var saved = localStorage.getItem(VIEW_KEY);
    if (saved) setView(saved);
  } catch (e) {}

  // -------------------------------------------------------- theme toggle
  var themeToggle = qs(document, '#theme-toggle');

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      var nextTheme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', nextTheme);
      try { localStorage.setItem('fileshare.theme', nextTheme); } catch (e) {}
    });
  }

  // ---------------------------------------------------------------- upload
  var dropzone = qs(document, '#dropzone');
  var fileInputFiles = qs(document, '#file-input-files');
  var fileInputFolders = qs(document, '#file-input-folders');
  var btnSelectFiles = qs(document, '#btn-select-files');
  var btnSelectFolders = qs(document, '#btn-select-folders');
  var uploadForm = qs(document, '#upload-form');
  var progressBox = qs(document, '#upload-progress');
  var progressFill = qs(document, '.upload-progress-fill');
  var progressText = qs(document, '.upload-progress-text');

  function walkEntry(entry, out) {
    if (!entry) return;
    if (entry.isFile) {
      entry.file(function (f) { out.push(f); });
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var readBatch = function () {
        reader.readEntries(function (ents) {
          if (!ents || !ents.length) return;
          ents.forEach(function (e) { walkEntry(e, out); });
          readBatch();
        });
      };
      readBatch();
    }
  }

  function filesFromDataTransfer(dt) {
    var out = [];
    var items = dt.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      for (var i = 0; i < items.length; i++) {
        var ent = items[i].webkitGetAsEntry();
        if (ent) walkEntry(ent, out);
      }
    }
    return out;
  }

  function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    var data = new FormData();
    var count = fileList.length;
    var totalBytes = 0;
    // Send relPath fields FIRST so the server's busboy handler has them
    // by the time each file part arrives in the multipart stream.
    for (var i = 0; i < count; i++) {
      var f = fileList[i];
      var rel = f.webkitRelativePath || f.name;
      if (rel) data.append('relPath_files', rel);
    }
    for (var j = 0; j < count; j++) {
      var fj = fileList[j];
      data.append('files', fj, fj.name);
      totalBytes += fj.size || 0;
    }
    if (progressBox) {
      progressBox.hidden = false;
      progressFill.style.width = '0%';
      progressText.textContent = '准备上传 ' + count + ' 项 · ' + humanSize(totalBytes);
    }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', (uploadForm && uploadForm.getAttribute('action')) || '/upload', true);
    xhr.withCredentials = true;
    xhr.upload.addEventListener('progress', function (ev) {
      if (!progressFill || !progressText) return;
      if (ev.lengthComputable) {
        var pct = Math.round((ev.loaded / ev.total) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent = '上传中 ' + pct + '% · ' + humanSize(ev.loaded) + ' / ' + humanSize(ev.total);
      } else {
        progressText.textContent = '上传中 ' + humanSize(ev.loaded) + ' ...';
      }
    });
    xhr.addEventListener('load', function () {
      if (xhr.status >= 200 && xhr.status < 400) {
        if (progressText) progressText.textContent = '上传完成 · 正在刷新...';
        setTimeout(function () { window.location.reload(); }, 350);
      } else if (xhr.status === 401) {
        if (progressText) progressText.textContent = '需要登录';
        window.location.reload();
      } else {
        if (progressText) progressText.textContent = '上传失败 (' + xhr.status + ')';
      }
    });
    xhr.addEventListener('error', function () {
      if (progressText) progressText.textContent = '网络错误';
    });
    xhr.send(data);
  }

  if (btnSelectFiles && fileInputFiles) {
    btnSelectFiles.addEventListener('click', function (e) {
      e.stopPropagation();
      fileInputFiles.click();
    });
  }
  if (btnSelectFolders && fileInputFolders) {
    btnSelectFolders.addEventListener('click', function (e) {
      e.stopPropagation();
      fileInputFolders.click();
    });
  }

  if (fileInputFiles) {
    fileInputFiles.addEventListener('change', function () {
      uploadFiles(Array.prototype.slice.call(fileInputFiles.files));
      fileInputFiles.value = '';
    });
  }
  if (fileInputFolders) {
    fileInputFolders.addEventListener('change', function () {
      uploadFiles(Array.prototype.slice.call(fileInputFolders.files));
      fileInputFolders.value = '';
    });
  }

  if (dropzone) {
    dropzone.addEventListener('click', function (e) {
      if (!e.target.closest('.upload-buttons') && fileInputFiles) {
        fileInputFiles.click();
      }
    });

    var dragCounter = 0;
    dropzone.addEventListener('dragenter', function (e) {
      e.preventDefault(); e.stopPropagation();
      dragCounter++;
      dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragover', function (e) {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    dropzone.addEventListener('dragleave', function (e) {
      e.preventDefault(); e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropzone.classList.remove('is-dragover');
      }
    });
    dropzone.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      dragCounter = 0;
      dropzone.classList.remove('is-dragover');
      var files = filesFromDataTransfer(e.dataTransfer);
      if (files.length === 0 && e.dataTransfer.files) {
        files = Array.prototype.slice.call(e.dataTransfer.files);
      }
      uploadFiles(files);
    });
  }

  // --------------------------------------------------- global drag overlay
  var dragOverlay = qs(document, '#drag-overlay');
  if (dragOverlay) {
    var windowDragCounter = 0;
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      windowDragCounter++;
      dragOverlay.hidden = false;
    });
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      windowDragCounter--;
      if (windowDragCounter <= 0) {
        windowDragCounter = 0;
        dragOverlay.hidden = true;
      }
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      windowDragCounter = 0;
      dragOverlay.hidden = true;
      var files = filesFromDataTransfer(e.dataTransfer);
      if (files.length === 0 && e.dataTransfer.files) {
        files = Array.prototype.slice.call(e.dataTransfer.files);
      }
      uploadFiles(files);
    });
  }

  // ------------------------------------------------------------- preview
  var drawer = qs(document, '#drawer');
  var drawerTitle = qs(document, '#drawer-title');
  var drawerMeta = qs(document, '.drawer-meta');
  var drawerBody = qs(document, '#drawer-body');
  var drawerDownload = qs(document, '#drawer-download');
  var drawerNum = qs(document, '#drawer-eyebrow-num');
  var lastTriggerEl = null;

  function openDrawer(entryEl) {
    if (!drawer || !entryEl) return;
    var rel = entryEl.getAttribute('data-rel') || '';
    var name = qs(entryEl, '.entry-name').textContent;
    var kind = entryEl.getAttribute('data-kind') || 'file';
    var size = parseInt(entryEl.getAttribute('data-size') || '0', 10);
    var num = entryEl.getAttribute('data-idx');
    if (num != null) num = 'N' + String(parseInt(num, 10) + 1).padStart(3, '0');

    drawerTitle.textContent = name;
    drawerMeta.textContent = kind + ' · ' + humanSize(size) + ' · 实时预览';
    if (drawerNum) drawerNum.textContent = num || '—';
    // Use encodeURI (NOT encodeURIComponent) to preserve / separators in the path
    if (drawerDownload) drawerDownload.setAttribute('href', '/raw/' + encodeURI(rel));
    drawerBody.innerHTML = '<div class="drawer-loading"><span class="drawer-spinner"></span><span>正在打开…</span></div>';

    drawer.hidden = false;
    document.body.style.overflow = 'hidden';
    lastTriggerEl = entryEl;

    // Use encodeURI for the preview URL to preserve / in relPath
    var previewUrl = '/preview/' + encodeURI(rel);

    fetch(previewUrl, { credentials: 'same-origin' })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok) {
          if (r.status === 401) { window.location.reload(); return; }
          return r.text().then(function (t) { throw new Error(t || r.statusText); });
        }
        if (ct.indexOf('application/json') === 0) {
          return r.json().then(function (j) { return { kind: 'json', data: j }; });
        }
        // Raw stream — use the preview URL as the source
        return { kind: 'raw', ct: ct, url: previewUrl };
      })
      .then(function (res) {
        if (!res) return;
        renderPreview(name, kind, res);
      })
      .catch(function (err) {
        drawerBody.innerHTML =
          '<div class="preview-unsupported">' +
          '<h3>无法打开</h3>' +
          '<p>' + escapeHtml(err.message || '预览失败') + '</p>' +
          '<a class="btn btn-primary" href="/raw/' + encodeURI(rel) + '" download>下载文件</a>' +
          '</div>';
      });
  }

  function renderPreview(name, kind, res) {
    // JSON responses from the preview endpoint
    if (res.kind === 'json') {
      var data = res.data;

      // File too large to preview
      if (data.tooLarge) {
        drawerBody.innerHTML =
          '<div class="preview-unsupported">' +
          '<h3>文件过大</h3>' +
          '<p>超过 1 MB 的文本不会在预览窗中显示，请直接下载。</p>' +
          '<a class="btn btn-primary" href="/raw/' + encodeURI(data.relPath || '') + '" download>下载</a>' +
          '</div>';
        return;
      }

      // Text preview
      if (data.kind === 'text') {
        drawerBody.innerHTML = '<pre class="preview-text">' + escapeHtml(data.text || '') + '</pre>';
        return;
      }

      // Code preview
      if (data.kind === 'code') {
        drawerBody.innerHTML = '<pre class="preview-code">' + escapeHtml(data.text || '') + '</pre>';
        return;
      }

      // Unsupported — use rawUrl from server (already properly encoded per-segment)
      if (data.kind === 'unsupported') {
        drawerBody.innerHTML =
          '<div class="preview-unsupported">' +
          '<svg viewBox="0 0 96 96" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 32v44a4 4 0 0 0 4 4h56a4 4 0 0 0 4-4V40a4 4 0 0 0-4-4H46l-6-8H20a4 4 0 0 0-4 4z"/><line x1="28" y1="56" x2="68" y2="56"/><line x1="28" y1="64" x2="58" y2="64"/></svg>' +
          '<h3>此类型无法预览</h3>' +
          '<p>文件已就绪，可以直接下载。</p>' +
          '<a class="btn btn-primary" href="' + escapeHtml(data.rawUrl) + '" download>下载文件</a>' +
          '</div>';
        return;
      }

      // Image — use rawUrl from server (already properly encoded per-segment)
      if (data.kind === 'image') {
        drawerBody.innerHTML = '<div class="preview-image"><img alt="" src="' + escapeHtml(data.rawUrl) + '"></div>';
        return;
      }

      // Video — use rawUrl from server
      if (data.kind === 'video') {
        drawerBody.innerHTML = '<div class="preview-video"><video controls src="' + escapeHtml(data.rawUrl) + '"></video></div>';
        return;
      }

      // Audio — use rawUrl from server
      if (data.kind === 'audio') {
        drawerBody.innerHTML =
          '<div class="preview-audio">' +
          '<div class="preview-audio-icon">' +
          '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>' +
          '</div>' +
          '<audio controls src="' + escapeHtml(data.rawUrl) + '"></audio>' +
          '</div>';
        return;
      }

      // PDF — use iframe with rawUrl from server
      if (data.kind === 'pdf') {
        drawerBody.innerHTML =
          '<div class="preview-image" style="width:100%;height:100%;">' +
          '<iframe src="' + escapeHtml(data.rawUrl) + '" style="width:100%;height:100%;min-height:calc(100vh - 240px);border:0;background:#fff;border-radius:6px;box-shadow:0 8px 32px rgba(31,28,23,0.18);" title="' + escapeHtml(name) + '"></iframe>' +
          '</div>';
        return;
      }
    }

    // Raw stream responses (non-JSON content-type)
    if (res.kind === 'raw') {
      var ct = res.ct || '';
      var url = res.url;

      if (ct.indexOf('image/') === 0 || kind === 'image') {
        drawerBody.innerHTML = '<div class="preview-image"><img alt="" src="' + escapeHtml(url) + '"></div>';
      } else if (ct.indexOf('video/') === 0 || kind === 'video') {
        drawerBody.innerHTML = '<div class="preview-video"><video controls src="' + escapeHtml(url) + '"></video></div>';
      } else if (ct.indexOf('audio/') === 0 || kind === 'audio') {
        drawerBody.innerHTML =
          '<div class="preview-audio">' +
          '<div class="preview-audio-icon">' +
          '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>' +
          '</div>' +
          '<audio controls src="' + escapeHtml(url) + '"></audio>' +
          '</div>';
      } else if (ct.indexOf('application/pdf') === 0 || kind === 'pdf') {
        drawerBody.innerHTML =
          '<div class="preview-image" style="width:100%;height:100%;">' +
          '<iframe src="' + escapeHtml(url) + '" style="width:100%;height:100%;min-height:calc(100vh - 240px);border:0;background:#fff;border-radius:6px;box-shadow:0 8px 32px rgba(31,28,23,0.18);" title="' + escapeHtml(name) + '"></iframe>' +
          '</div>';
      } else {
        // Generic stream — fallback with download link
        drawerBody.innerHTML =
          '<div class="preview-unsupported">' +
          '<h3>未知格式</h3>' +
          '<p>不能直接预览，可以下载到本地查看。</p>' +
          '<a class="btn btn-primary" href="' + escapeHtml(url) + '" download>下载文件</a>' +
          '</div>';
      }
    }
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    document.body.style.overflow = '';
    drawerBody.innerHTML = '';
    if (lastTriggerEl && lastTriggerEl.focus) lastTriggerEl.focus();
  }

  if (drawer) {
    qsa(drawer, '[data-action="close"]').forEach(function (el) {
      el.addEventListener('click', closeDrawer);
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="preview"]');
    if (!btn) return;
    var entry = btn.closest('.entry-file');
    if (!entry) return;
    e.preventDefault();
    openDrawer(entry);
  });

})();
