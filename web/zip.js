/*
 * Minimal ZIP reader/writer, no dependencies.
 * Writes with the "store" method (no compression - image bytes are already
 * compressed). Reads both stored and deflate entries when the browser exposes
 * DecompressionStream.
 */
(function (global) {
  "use strict";

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function create(entries) {
    var chunks = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (entry) {
      var nameBytes = enc.encode(entry.name);
      var data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      var crc = crc32(data);
      var size = data.length;

      var header = new Uint8Array(30 + nameBytes.length);
      var hv = new DataView(header.buffer);
      hv.setUint32(0, 0x04034b50, true);
      hv.setUint16(4, 20, true);
      hv.setUint16(6, 0, true);
      hv.setUint16(8, 0, true);
      hv.setUint16(10, 0, true);
      hv.setUint16(12, 0, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, size, true);
      hv.setUint32(22, size, true);
      hv.setUint16(26, nameBytes.length, true);
      hv.setUint16(28, 0, true);
      header.set(nameBytes, 30);
      chunks.push(header, data);

      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += header.length + size;
    });

    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(chunks.concat(central, [eocd]), { type: "application/zip" });
  }

  function inflateRaw(bytes) {
    if (typeof global.DecompressionStream === "undefined") {
      return Promise.reject(new Error("此浏览器无法读取压缩的 zip 内容"));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function extract(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { return Promise.reject(new Error("不是有效的 zip 文件")); }

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    var entries = [];
    var p = cdOffset;
    for (var n = 0; n < count; n++) {
      if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) { break; }
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOffset = dv.getUint32(p + 42, true);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

      var lnameLen = dv.getUint16(localOffset + 26, true);
      var lextraLen = dv.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + lnameLen + lextraLen;

      entries.push({ name: name, method: method, compSize: compSize, dataStart: dataStart });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return Promise.all(entries.map(function (e) {
      var data = bytes.subarray(e.dataStart, e.dataStart + e.compSize);
      if (e.method === 0) { return Promise.resolve({ name: e.name, data: data }); }
      if (e.method === 8) {
        return inflateRaw(data).then(function (d) { return { name: e.name, data: d }; });
      }
      return Promise.reject(new Error("不支持的 zip 压缩方式：" + e.name));
    }));
  }

  global.Zip = { create: create, extract: extract };
})(window);
