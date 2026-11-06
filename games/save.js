/* save.js —— 原生 JS 存档模块，无依赖 */
(function (global) {
  'use strict';

  var PREFIX = 'ncg:';   // 命名空间，避免和其他站点/项目冲突

  // —— 存储后端：localStorage 优先，不可用时降级为内存 ——
  var backend;
  try {
    var probe = PREFIX + '__probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    backend = localStorage;
  } catch (e) {
    console.warn('[save] localStorage 不可用，已降级为内存存储（关闭页面即丢失）');
    var mem = new Map();
    backend = {
      getItem: function (k) { return mem.has(k) ? mem.get(k) : null; },
      setItem: function (k, v) { mem.set(k, v); },
      removeItem: function (k) { mem.delete(k); }
    };
  }

  function create(opts) {
    var name     = opts.name;                       // 例：'魔塔'
    var version  = (opts.version | 0) || 1;         // 存档结构版本号
    var defaults = opts.defaults || function () { return {}; };
    var migrate  = opts.migrate  || null;           // 旧版本迁移函数
    var key      = PREFIX + name;

    var autoTimer = null;
    var autoGetter = null;

    function readRaw() {
      try { return backend.getItem(key); } catch (e) { return null; }
    }

    function load() {
      var raw = readRaw();
      if (!raw) return null;
      var data;
      try { data = JSON.parse(raw); }
      catch (e) { console.warn('[save] 存档损坏：' + name); return null; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

      var from = data.__v | 0;
      if (from !== version) {
        if (from > version) {
          console.warn('[save] 存档版本高于当前游戏版本，已忽略：' + name);
          return null;
        }
        if (typeof migrate === 'function') {
          try { data = migrate(data, from) || data; }
          catch (e) { console.error('[save] 迁移失败', e); return null; }
        }
      }
      // 补齐新增字段，老存档也能安全读
      return Object.assign(defaults(), data, { __v: version });
    }

    function save(state) {
      var payload = Object.assign({}, state, { __v: version, __t: Date.now() });
      var str;
      try { str = JSON.stringify(payload); }
      catch (e) { console.error('[save] 状态无法序列化（含函数/循环引用？）', e); return false; }
      try { backend.setItem(key, str); return true; }
      catch (e) { console.error('[save] 写入失败（配额已满？）', e); return false; }
    }

    function clear() { try { backend.removeItem(key); } catch (e) {} }
    function exists() { return readRaw() != null; }

    function meta() {
      var raw = readRaw();
      if (!raw) return null;
      try {
        var d = JSON.parse(raw);
        return { version: d.__v, time: d.__t || 0, size: raw.length };
      } catch (e) { return null; }
    }

    // —— 自动存档：定时 + 切后台/关页面时兜底 ——
    function flush() {
      if (!autoGetter) return;
      var s;
      try { s = autoGetter(); } catch (e) { return; }
      if (s) save(s);
    }
    function onVisibility() { if (document.hidden) flush(); }

    function startAutoSave(getState, intervalMs) {
      stopAutoSave();
      autoGetter = getState;
      if (intervalMs > 0) autoTimer = setInterval(flush, intervalMs);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', flush);
    }
    function stopAutoSave() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      autoGetter = null;
    }

    // —— 导出 / 导入 ——
    function exportFile(filename) {
      var raw = readRaw() || '{}';
      var blob = new Blob([raw], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (filename || name) + '.save.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function importFile(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var data;
          try { data = JSON.parse(reader.result); }
          catch (e) { return reject(new Error('不是合法的 JSON')); }
          if (!data || typeof data !== 'object') return reject(new Error('存档格式错误'));
          try { backend.setItem(key, JSON.stringify(data)); resolve(true); }
          catch (e) { reject(e); }
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsText(file);
      });
    }

    return {
      key: key, load: load, save: save, clear: clear,
      exists: exists, meta: meta,
      startAutoSave: startAutoSave, stopAutoSave: stopAutoSave, flush: flush,
      exportFile: exportFile, importFile: importFile
    };
  }

  global.NcgSave = { create: create };
})(window);