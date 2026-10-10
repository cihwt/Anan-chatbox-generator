/*
 * Template + image storage with no dependencies.
 * Prefers IndexedDB (stores image Blobs). Falls back to localStorage with
 * data-URL images when IndexedDB is unavailable (e.g. file:// in Firefox).
 *
 * Images are stored once, keyed by a content hash, and shared by templates that
 * use the same image (content-addressed store).
 */
(function (global) {
  "use strict";

  var STORE = "templates";
  var IMG_STORE = "images";
  var DB_NAME = "templates-db";
  var DB_VERSION = 2;
  var LS_KEY = "templates";
  var LS_IMG = "images";

  // previous (renamed) identifiers, migrated on first run
  var LEGACY_DB = "quad-templates";
  var LEGACY_LS_KEY = "quad-templates";
  var LEGACY_LS_IMG = "quad-images";

  var mode = null;          // "idb" | "local"
  var dbPromise = null;
  var migratePromise = null;

  function createStores(db) {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains(IMG_STORE)) {
      db.createObjectStore(IMG_STORE, { keyPath: "hash" });
    }
  }

  function detect() {
    if (mode) { return Promise.resolve(mode); }
    return new Promise(function (resolve) {
      var settled = false;
      function done(m) { if (!settled) { settled = true; mode = m; resolve(m); } }
      if (!global.indexedDB) { done("local"); return; }
      var req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (_) { done("local"); return; }
      req.onupgradeneeded = function (e) { createStores(e.target.result); };
      req.onsuccess = function () { done("idb"); };
      req.onerror = function () { done("local"); };
      req.onblocked = function () { done("local"); };
      setTimeout(function () { done("local"); }, 1500);
    });
  }

  // ---------- IndexedDB ----------
  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = global.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (e) { createStores(e.target.result); };
        req.onsuccess = function () {
          var db = req.result;
          migrateLegacy(db).then(function () { resolve(db); }, function () { resolve(db); });
        };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbPromise;
  }

  // one-time copy from the previously named database, then drop it
  function migrateLegacy(db) {
    if (migratePromise) { return migratePromise; }
    migratePromise = new Promise(function (resolve) {
      if (!global.indexedDB.databases) { resolve(); return; }
      global.indexedDB.databases().then(function (list) {
        var has = list && list.some(function (d) { return d.name === LEGACY_DB; });
        if (!has) { resolve(); return; }
        var req = global.indexedDB.open(LEGACY_DB);
        req.onsuccess = function () {
          var old = req.result;
          var names = ["templates", "images"].filter(function (n) {
            return old.objectStoreNames.contains(n);
          });
          if (!names.length) { old.close(); dropLegacy(); resolve(); return; }
          var tx = old.transaction(names, "readonly");
          var data = {};
          var pending = names.length;
          names.forEach(function (n) {
            var r = tx.objectStore(n).getAll();
            r.onsuccess = function () { data[n] = r.result || []; if (--pending === 0) { copy(); } };
            r.onerror = function () { data[n] = data[n] || []; if (--pending === 0) { copy(); } };
          });
          function copy() {
            old.close();
            var stores = names.filter(function (n) { return db.objectStoreNames.contains(n); });
            var tx2 = db.transaction(stores, "readwrite");
            stores.forEach(function (n) {
              (data[n] || []).forEach(function (rec) { tx2.objectStore(n).put(rec); });
            });
            tx2.oncomplete = function () { dropLegacy(); resolve(); };
            tx2.onerror = function () { resolve(); };
            tx2.onabort = function () { resolve(); };
          }
        };
        req.onerror = function () { resolve(); };
        req.onblocked = function () { resolve(); };
      }).catch(function () { resolve(); });
    });
    return migratePromise;
  }

  function dropLegacy() {
    try { global.indexedDB.deleteDatabase(LEGACY_DB); } catch (_) {}
  }

  function idbRun(storeName, m, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, m);
        var out;
        try { out = fn(tx.objectStore(storeName)); }
        catch (err) { reject(err); return; }
        tx.oncomplete = function () {
          resolve(out && typeof out === "object" && "result" in out ? out.result : out);
        };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  // ---------- localStorage ----------
  function lsRead() {
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      if (raw === null) { raw = global.localStorage.getItem(LEGACY_LS_KEY); }
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }
  function lsWrite(rows) {
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(rows));
    } catch (_) {
      throw new Error("浏览器存储已满 —— 删掉一些模板或换张更小的图片。");
    }
  }
  function lsImages() {
    try {
      var raw = global.localStorage.getItem(LS_IMG);
      if (raw === null) { raw = global.localStorage.getItem(LEGACY_LS_IMG); }
      return JSON.parse(raw || "{}") || {};
    } catch (_) { return {}; }
  }
  function lsImagesWrite(map) {
    try {
      global.localStorage.setItem(LS_IMG, JSON.stringify(map));
    } catch (_) {
      throw new Error("浏览器存储已满 —— 删掉一些模板或换张更小的图片。");
    }
  }

  // ---------- helpers ----------
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function toHex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) { s += (b[i] < 16 ? "0" : "") + b[i].toString(16); }
    return s;
  }
  function hashFallback(blob) {
    if (!blob.arrayBuffer) { return Promise.resolve("len-" + blob.size + "-" + Date.now()); }
    return blob.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf), h = 2166136261;
      for (var i = 0; i < b.length; i++) { h ^= b[i]; h = (h * 16777619) >>> 0; }
      return "fnv-" + b.length + "-" + h.toString(16);
    });
  }
  function hashBlob(blob) {
    if (global.crypto && global.crypto.subtle && global.crypto.subtle.digest && blob.arrayBuffer) {
      return blob.arrayBuffer()
        .then(function (buf) { return global.crypto.subtle.digest("SHA-256", buf); })
        .then(toHex)
        .catch(function () { return hashFallback(blob); });
    }
    return hashFallback(blob);
  }

  function storeImage(hash, blob) {
    return detect().then(function (m) {
      if (m === "idb") {
        return idbRun(IMG_STORE, "readonly", function (s) { return s.get(hash); })
          .then(function (existing) {
            if (existing) { return; }
            return idbRun(IMG_STORE, "readwrite", function (s) { s.put({ hash: hash, blob: blob }); });
          });
      }
      return blobToDataUrl(blob).then(function (url) {
        var map = lsImages();
        if (map[hash]) { return; }
        map[hash] = url;
        lsImagesWrite(map);
      });
    });
  }

  function getImageBlob(hash) {
    return detect().then(function (m) {
      if (m === "idb") {
        return idbRun(IMG_STORE, "readonly", function (s) { return s.get(hash); })
          .then(function (r) { return r ? r.blob : null; });
      }
      var url = lsImages()[hash];
      if (!url) { return null; }
      return fetch(url).then(function (r) { return r.blob(); });
    });
  }

  function getImageDataUrl(hash) {
    return detect().then(function (m) {
      if (m === "idb") {
        return idbRun(IMG_STORE, "readonly", function (s) { return s.get(hash); })
          .then(function (r) { return r && r.blob ? blobToDataUrl(r.blob) : null; });
      }
      return lsImages()[hash] || null;
    });
  }

  // oldest first, so newly created templates append to the bottom
  function sortRows(rows) {
    return rows.sort(function (a, b) {
      var ta = a.createdAt || a.updatedAt || 0;
      var tb = b.createdAt || b.updatedAt || 0;
      if (ta !== tb) { return ta - tb; }
      return (a.updatedAt || 0) - (b.updatedAt || 0);
    });
  }

  global.Store = {
    // Resolve the display source for a template's image.
    imageURL: function (record) {
      if (record.imageHash) {
        return getImageBlob(record.imageHash).then(function (blob) {
          return blob ? URL.createObjectURL(blob) : (record.imageSrc || "");
        });
      }
      if (record.imageBlob) { return Promise.resolve(URL.createObjectURL(record.imageBlob)); }
      if (record.imageDataUrl) { return Promise.resolve(record.imageDataUrl); }
      return Promise.resolve(record.imageSrc || "");
    },

    // Resolve a data URL (for SVG/PNG export).
    imageDataUrl: function (record) {
      if (record.imageHash) {
        return getImageDataUrl(record.imageHash).then(function (url) {
          if (url) { return url; }
          if (!record.imageSrc) { return Promise.reject(new Error("x")); }
          return fetch(record.imageSrc).then(function (r) {
            if (!r.ok) { throw new Error("x"); }
            return r.blob();
          }).then(blobToDataUrl);
        });
      }
      if (record.imageDataUrl) { return Promise.resolve(record.imageDataUrl); }
      if (record.imageBlob) { return blobToDataUrl(record.imageBlob); }
      if (!record.imageSrc) {
        return Promise.reject(new Error("该模板没有可导出的图片，请先上传图片。"));
      }
      return fetch(record.imageSrc).then(function (r) {
        if (!r.ok) { throw new Error("x"); }
        return r.blob();
      }).then(blobToDataUrl).catch(function () {
        throw new Error("该模板没有可导出的图片，请先上传图片。");
      });
    },

    // Resolve a template's image as a Blob (for export).
    imageBlob: function (record) {
      if (record.imageHash) { return getImageBlob(record.imageHash); }
      if (record.imageBlob) { return Promise.resolve(record.imageBlob); }
      if (record.imageDataUrl) {
        return fetch(record.imageDataUrl).then(function (r) { return r.blob(); });
      }
      if (!record.imageSrc) { return Promise.resolve(null); }
      return fetch(record.imageSrc)
        .then(function (r) { return r.ok ? r.blob() : null; })
        .catch(function () { return null; });
    },

    list: function () {
      return detect().then(function (m) {
        if (m === "idb") { return idbRun(STORE, "readonly", function (s) { return s.getAll(); }); }
        return lsRead();
      }).then(sortRows);
    },

    get: function (id) {
      return detect().then(function (m) {
        if (m === "idb") { return idbRun(STORE, "readonly", function (s) { return s.get(id); }); }
        var found = lsRead().filter(function (r) { return r.id === id; });
        return found[0] || undefined;
      });
    },

    // put(record, newBlob?, overlayBlob?) - each image is hashed + stored once.
    // Also migrates legacy records that still carry imageBlob / imageDataUrl.
    put: function (record, newBlob, overlayBlob) {
      var blob = newBlob || record.imageBlob || null;
      var prep;
      if (blob) {
        prep = hashBlob(blob).then(function (hash) {
          record.imageHash = hash;
          record.imageBlob = null;
          record.imageDataUrl = null;
          return storeImage(hash, blob);
        });
      } else if (!record.imageHash && record.imageDataUrl) {
        prep = fetch(record.imageDataUrl).then(function (r) { return r.blob(); })
          .then(function (b) {
            return hashBlob(b).then(function (hash) {
              record.imageHash = hash;
              record.imageDataUrl = null;
              return storeImage(hash, b);
            });
          });
      } else {
        prep = Promise.resolve();
      }
      var overlayPrep = overlayBlob
        ? hashBlob(overlayBlob).then(function (hash) {
            record.overlay = record.overlay || {};
            record.overlay.hash = hash;
            record.overlay.imageSrc = null;
            return storeImage(hash, overlayBlob);
          })
        : Promise.resolve();
      return Promise.all([prep, overlayPrep]).then(function () {
        return detect().then(function (m) {
          if (m === "idb") {
            return idbRun(STORE, "readwrite", function (s) { s.put(record); return record; });
          }
          var rows = lsRead().filter(function (r) { return r.id !== record.id; });
          rows.push(record);
          lsWrite(rows);
          return record;
        });
      });
    },

    remove: function (id) {
      return detect().then(function (m) {
        var getRec = m === "idb"
          ? idbRun(STORE, "readonly", function (s) { return s.get(id); })
          : Promise.resolve(lsRead().filter(function (r) { return r.id === id; })[0]);
        return getRec.then(function (rec) {
          var hashes = [];
          if (rec && rec.imageHash) { hashes.push(rec.imageHash); }
          if (rec && rec.overlay && rec.overlay.hash) { hashes.push(rec.overlay.hash); }
          var del = m === "idb"
            ? idbRun(STORE, "readwrite", function (s) { s.delete(id); })
            : (lsWrite(lsRead().filter(function (r) { return r.id !== id; })), Promise.resolve());
          return del.then(function () {
            if (!hashes.length) { return; }
            var all = m === "idb"
              ? idbRun(STORE, "readonly", function (s) { return s.getAll(); })
              : Promise.resolve(lsRead());
            return all.then(function (rows) {
              var unused = hashes.filter(function (hash) {
                return !rows.some(function (r) {
                  return r.imageHash === hash || (r.overlay && r.overlay.hash === hash);
                });
              });
              if (!unused.length) { return; }
              if (m === "idb") {
                return idbRun(IMG_STORE, "readwrite", function (s) {
                  unused.forEach(function (h) { s.delete(h); });
                });
              }
              var map = lsImages();
              unused.forEach(function (h) { delete map[h]; });
              lsImagesWrite(map);
            });
          });
        });
      });
    },

    newId: function () {
      if (global.crypto && global.crypto.randomUUID) { return global.crypto.randomUUID(); }
      return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    }
  };
})(window);
