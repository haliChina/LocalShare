/* turbo.js — 超级下载器（LocalShare v1.2.0）
 * 流程：HEAD 元数据 → N 路并发 Range 分块 → 浏览器本地拼装 →
 *       SHA-256 完整性核验（对照 /sha256/<rel>）→ Blob 保存
 * - crypto.subtle 优先（https/localhost 安全上下文）；
 *   明文 HTTP 局域网下自动回退到下方纯 JS SHA-256（与原生实现逐位一致，已测）。
 * - 所有动效/资源均为本地实现，无任何外部依赖。
 */
(function () {
  'use strict';

  function qs(sel) { return document.querySelector(sel); }
  function qsa(root, sel) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  }); }
  function fmtBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    var v = n / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)) + ' ' + u[i];
  }
  function fmtSpeed(mbs) { return (mbs >= 1024 ? (mbs / 1024).toFixed(2) + ' GB/s' : mbs.toFixed(1) + ' MB/s'); }

  /* ---------- 纯 JS SHA-256（非安全上下文兜底；实现已对齐 Node crypto） ---------- */
  var Sha256 = (function () {
    var K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    function Sha256() {
      this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
      this.len = 0; this.buf = new Uint8Array(64); this.bufLen = 0;
      this.w = new Uint32Array(64);
    }
    Sha256.prototype._block = function (b) {
      var w = this.w, h = this.h, i, j;
      for (i = 0; i < 16; i++) w[i] = (b[i*4]<<24) | (b[i*4+1]<<16) | (b[i*4+2]<<8) | b[i*4+3];
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
        var s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      var a=h[0],bb=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        var maj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + maj) | 0;
        hh=g; g=f; f=e; e=(d + t1)|0; d=c; c=bb; bb=a; a=(t1 + t2)|0;
      }
      h[0]=(h[0]+a)|0; h[1]=(h[1]+bb)|0; h[2]=(h[2]+c)|0; h[3]=(h[3]+d)|0;
      h[4]=(h[4]+e)|0; h[5]=(h[5]+f)|0; h[6]=(h[6]+g)|0; h[7]=(h[7]+hh)|0;
    };
    Sha256.prototype.update = function (data) {
      if (this.bufLen) {
        var take = Math.min(64 - this.bufLen, data.length);
        this.buf.set(data.subarray(0, take), this.bufLen);
        this.bufLen += take;
        if (this.bufLen < 64) return this;
        this._block(this.buf); this.len += 64; this.bufLen = 0;
        data = data.subarray(take);
      }
      var off = 0;
      while (off + 64 <= data.length) { this._block(data.subarray(off, off + 64)); off += 64; }
      this.len += off;
      if (off < data.length) { this.buf.set(data.subarray(off)); this.bufLen = data.length - off; }
      return this;
    };
    Sha256.prototype.digest = function () {
      var bitLen = (this.len + this.bufLen) * 8;
      var pad = new Uint8Array(((this.bufLen < 56) ? 56 : 120) - this.bufLen);
      pad[0] = 0x80;
      this.update(pad);
      var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
      var tail = new Uint8Array(8);
      tail[0] = hi >>> 24; tail[1] = (hi >>> 16) & 255; tail[2] = (hi >>> 8) & 255; tail[3] = hi & 255;
      tail[4] = lo >>> 24; tail[5] = (lo >>> 16) & 255; tail[6] = (lo >>> 8) & 255; tail[7] = lo & 255;
      this.buf.set(tail, this.bufLen); this._block(this.buf);
      var out = new Uint8Array(32), h = this.h;
      for (var i = 0; i < 8; i++) {
        out[i*4] = h[i] >>> 24; out[i*4+1] = (h[i] >>> 16) & 255;
        out[i*4+2] = (h[i] >>> 8) & 255; out[i*4+3] = h[i] & 255;
      }
      var hex = '';
      for (i = 0; i < 32; i++) hex += ('0' + out[i].toString(16)).slice(-2);
      return hex;
    };
    return Sha256;
  })();

  function hashBuffer(buf) {
    if (window.crypto && crypto.subtle && window.isSecureContext) {
      return crypto.subtle.digest('SHA-256', buf).then(function (d) {
        var b = new Uint8Array(d), hex = '';
        for (var i = 0; i < b.length; i++) hex += ('0' + b[i].toString(16)).slice(-2);
        return hex;
      });
    }
    return new Promise(function (resolve) {
      // 大文件分批喂入，避免阻塞 UI
      var h = new Sha256(), view = new Uint8Array(buf), CH = 1 << 20;
      function step(off) {
        var end = Math.min(off + CH, view.length);
        h.update(view.subarray(off, end));
        if (end < view.length) setTimeout(function () { step(end); }, 0);
        else resolve(h.digest());
      }
      step(0);
    });
  }

  /* ---------- 下载会话状态 ---------- */
  var S = null; // active session

  /* ---------- UI 面板 ---------- */
  var panel, pName, pMeta, pChunks, pBar, pPct, pSpeed, pStage, pVerify, pActions, btnCancel, btnSave, btnFallback;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'turbo-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '超级下载');
    panel.hidden = true;
    panel.innerHTML =
      '<div class="turbo-head">' +
      '  <div class="turbo-title"><span class="turbo-bolt" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>超级下载<small>Turbo · 分块并发 → 本地拼装 → SHA-256 核验</small></div>' +
      '  <button type="button" class="turbo-close" data-turbo="close" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="turbo-name" id="turbo-name"></div>' +
      '<div class="turbo-meta" id="turbo-meta"></div>' +
      '<div class="turbo-bar"><div class="turbo-bar-fill" id="turbo-bar"></div></div>' +
      '<div class="turbo-row"><span class="turbo-pct" id="turbo-pct">0%</span><span class="turbo-speed" id="turbo-speed"></span></div>' +
      '<div class="turbo-chunks" id="turbo-chunks"></div>' +
      '<div class="turbo-stage" id="turbo-stage">等待开始…</div>' +
      '<div class="turbo-verify" id="turbo-verify" hidden></div>' +
      '<div class="turbo-actions" id="turbo-actions" hidden>' +
      '  <button type="button" class="btn btn-primary btn-sm" id="turbo-save" disabled>保存文件</button>' +
      '  <button type="button" class="btn btn-ghost btn-sm" id="turbo-fallback">改用普通下载</button>' +
      '</div>' +
      '<div class="turbo-actions" id="turbo-cancel-row"><button type="button" class="btn btn-ghost btn-sm" id="turbo-cancel">取消下载</button></div>';
    document.body.appendChild(panel);
    panel.addEventListener('click', function (e) {
      if (e.target.closest('[data-turbo="close"]')) hidePanel();
    });
    pName = qs('#turbo-name'); pMeta = qs('#turbo-meta'); pChunks = qs('#turbo-chunks');
    pBar = qs('#turbo-bar'); pPct = qs('#turbo-pct'); pSpeed = qs('#turbo-speed');
    pStage = qs('#turbo-stage'); pVerify = qs('#turbo-verify');
    btnFallback = qs('#turbo-fallback');
    qs('#turbo-cancel').addEventListener('click', function () { cancel(); });
    qs('#turbo-save').addEventListener('click', function () { save(); });
    btnFallback.addEventListener('click', function () {
      if (!S) return;
      var a = document.createElement('a');
      a.href = '/raw/' + encodeURI(S.rel) + '?dl=1';
      a.download = S.name;
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  function showPanel() { ensurePanel(); panel.hidden = false; }
  function hidePanel() { cancel(); if (panel) panel.hidden = true; }

  function setStage(text, cls) {
    pStage.textContent = text;
    pStage.className = 'turbo-stage' + (cls ? ' ' + cls : '');
  }

  function renderChunks(ranges, states) {
    pChunks.innerHTML = ranges.map(function (r, i) {
      var st = states ? states[i] : 'wait';
      var pct = 0;
      if (st === 'done') pct = 100; else if (st === 'run') pct = 50;
      return '<div class="turbo-chunk" data-state="' + st + '">' +
        '<span class="tc-idx">#' + (i + 1) + '</span>' +
        '<span class="tc-range">' + fmtBytes(r.end - r.start + 1) + '</span>' +
        '<span class="tc-bar"><i style="width:' + pct + '%"></i></span>' +
        '</div>';
    }).join('');
  }

  /* ---------- 引擎 ---------- */
  function pickChunks(size) {
    // 每块目标 ≥ 1MB；1–8 路并发
    var n = Math.max(1, Math.min(8, Math.ceil(size / (1024 * 1024))));
    if (size <= 512 * 1024) n = 1; // 小文件没必要分块
    return n;
  }

  function start(rel, name, sizeBytes) {
    ensurePanel();
    cancel();
    S = { rel: rel, name: name, size: sizeBytes || 0, parts: [], abort: new AbortController(), blobs: [], done: false };
    showPanel();
    pName.textContent = name;
    pMeta.textContent = '…';
    pBar.style.width = '0%'; pPct.textContent = '0%'; pSpeed.textContent = '';
    pVerify.hidden = true;
    qs('#turbo-actions').hidden = true;
    qs('#turbo-cancel-row').hidden = false;
    qs('#turbo-save').disabled = true;
    renderChunks([]);
    setStage('① HEAD 探测元数据…', 'run');

    // 1) 元数据 + 服务端哈希 并行获取
    var headP = fetch('/raw/' + encodeURI(rel), { method: 'HEAD', credentials: 'same-origin', signal: S.abort.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HEAD 失败: HTTP ' + r.status);
        var len = parseInt(r.headers.get('content-length') || '0', 10);
        if (!S.size && len) S.size = len;
        var ar = r.headers.get('accept-ranges');
        if (!ar || ar.indexOf('bytes') === -1) throw new Error('服务端不支持 Range，请使用普通下载');
      });
    var hashP = fetch('/sha256/' + encodeURI(rel), { credentials: 'same-origin', signal: S.abort.signal })
      .then(function (r) { if (!r.ok) throw new Error('哈希接口失败'); return r.json(); })
      .then(function (j) {
        S.size = j.size || S.size;
        return j.sha256;
      })
      .catch(function () { return null; }); // 哈希拿不到时仍可下载，只是跳过核验

    Promise.all([headP, hashP]).then(function (rs) {
      if (!S || S.aborted) return;
      S.expectedHash = rs[1];
      var size = S.size;
      if (!size) throw new Error('无法获取文件大小');
      pMeta.textContent = fmtBytes(size) + ' · SHA-256 ' + (S.expectedHash ? '已就绪' : '不可用（跳过核验）');

      // 2) 拆解分块
      var N = pickChunks(size);
      var per = Math.ceil(size / N);
      var ranges = [];
      for (var i = 0; i < N; i++) {
        var st = i * per;
        if (st >= size) break;
        ranges.push({ start: st, end: Math.min(st + per, size) - 1 });
      }
      S.ranges = ranges;
      renderChunks(ranges);
      setStage('② ' + ranges.length + ' 路并发分块下载中…', 'run');

      // 3) 并发下载
      var states = ranges.map(function () { return 'wait'; });
      var loaded = new Array(ranges.length).fill(0);
      var t0 = performance.now();
      var totalLoaded = 0;
      var doneCnt = 0;

      function uiTick() {
        if (!S) return;
        var pct = Math.min(100, Math.round(totalLoaded / size * 100));
        pBar.style.width = pct + '%';
        pPct.textContent = pct + '%';
        var secs = (performance.now() - t0) / 1000;
        if (secs > 0.15) pSpeed.textContent = fmtSpeed((totalLoaded / 1048576) / secs);
        renderChunks(ranges, states);
      }
      var uiTimer = setInterval(uiTick, 120);

      function fetchChunk(i) {
        states[i] = 'run';
        return fetch('/raw/' + encodeURI(rel), {
          credentials: 'same-origin',
          signal: S.abort.signal,
          headers: { 'Range': 'bytes=' + ranges[i].start + '-' + ranges[i].end }
        }).then(function (r) {
          if (r.status !== 206) throw new Error('分块 #' + (i + 1) + ' 未返回 206（HTTP ' + r.status + '）');
          return r.arrayBuffer();
        }).then(function (buf) {
          S.parts[i] = new Uint8Array(buf);
          states[i] = 'done';
          doneCnt++;
          uiTick();
        });
      }

      var jobs = ranges.map(function (_, i) { return fetchChunk(i); });
      return Promise.all(jobs).then(function () {
        clearInterval(uiTimer);
        if (!S || S.aborted) return;
        // 4) 本地拼装
        pBar.style.width = '100%'; pPct.textContent = '100%';
        setStage('③ 本地拼装 ' + fmtBytes(size) + ' …', 'run');
        return new Promise(function (resolve) { setTimeout(resolve, 30); }).then(function () {
          var asm = new Uint8Array(size);
          var off = 0;
          for (var i = 0; i < S.parts.length; i++) {
            if (!S.parts[i]) throw new Error('分块缺失 #' + (i + 1));
            asm.set(S.parts[i], off);
            off += S.parts[i].length;
          }
          S.assembled = asm;
          if (off !== size) throw new Error('拼装大小不符: ' + off + ' ≠ ' + size);
          setStage('④ SHA-256 完整性核验…', 'run');
          return hashBuffer(asm.buffer);
        }).then(function (hex) {
          if (!S || S.aborted) return;
          var line;
          // 完成态：以总耗时 + 平均速度代替瞬时速度（避免停留在 0.0）
          var elapsedSec = Math.max(0.05, (performance.now() - t0) / 1000);
          pSpeed.textContent = fmtSpeed((size / 1048576) / elapsedSec) + ' avg · ' + elapsedSec.toFixed(1) + 's';
          if (!S.expectedHash) {
            line = '本地哈希: <code>' + hex + '</code><br>服务端哈希不可用，已跳过核验';
            setStage('完成（未核验）', '');
          } else if (hex === S.expectedHash) {
            line = '本地拼装: <code>' + hex + '</code><br>服务端: <code>' + S.expectedHash + '</code><b class="turbo-ok">✓ 完整性核验通过 — 逐位一致</b>';
            setStage('✓ 下载完成 · 核验通过', 'ok');
          } else {
            line = '本地拼装: <code>' + hex + '</code><br>服务端: <code>' + S.expectedHash + '</code><b class="turbo-bad">✗ 校验不一致，请重试</b>';
            setStage('✗ 核验失败', 'bad');
          }
          pVerify.innerHTML = line;
          pVerify.hidden = false;
          qs('#turbo-actions').hidden = false;
          qs('#turbo-cancel-row').hidden = true;
          qs('#turbo-save').disabled = (S.expectedHash && hex !== S.expectedHash);
          S.blobs = [new Blob([S.assembled])];
          S.done = true;
          // 核验通过后自动保存
          if (S.expectedHash && hex === S.expectedHash) setTimeout(save, 350);
        });
      });
    }).catch(function (err) {
      if (!S || S.aborted) return;
      if (String(err).indexOf('AbortError') === -1) {
        setStage('✗ ' + (err && err.message ? err.message : err), 'bad');
      }
    });
  }

  function cancel() {
    if (S) { S.aborted = true; try { S.abort.abort(); } catch (e) {} S = null; }
  }

  function save() {
    if (!S || !S.blobs || !S.blobs.length) return;
    var url = URL.createObjectURL(S.blobs[0]);
    var a = document.createElement('a');
    a.href = url; a.download = S.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- 对外 API ---------- */
  window.TurboDL = {
    start: function (rel, name, size) { start(rel, name, size); },
    cancel: cancel,
    close: hidePanel
  };

  /* ---------- 挂接条目下载按钮 ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="turbo"]');
    if (!btn) return;
    var entry = btn.closest('.entry-file');
    if (!entry) return;
    e.preventDefault();
    var nameEl = entry.querySelector('.entry-name');
    TurboDL.start(entry.getAttribute('data-rel') || '',
      nameEl ? nameEl.textContent : '',
      parseInt(entry.getAttribute('data-size') || '0', 10));
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel && !panel.hidden) hidePanel();
  });
})();
