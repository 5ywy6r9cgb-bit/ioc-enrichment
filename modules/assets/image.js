'use strict';
/**
 * image.js — read what an image file will tell you, without a dependency.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * Three facts about an image decide how it may be used, and none of them are
 * visible by looking at it:
 *
 *   1. WAS A CAMERA INVOLVED. A photograph the operator took is a primary
 *      artifact he holds. A screenshot of a web page is a picture OF a source
 *      and is not the source; the source is the URL, and a screenshot can be
 *      cropped, scrolled, or composed. Filing one as evidence is how a desk
 *      ends up citing itself.
 *
 *   2. DOES IT CARRY GPS. An iPhone writes the exact coordinates and the
 *      second the shutter fired into every photo. That is excellent
 *      provenance and a serious publication hazard: posting the file tells
 *      every reader precisely where the photographer was standing and when.
 *      Both things are true at once, so the ledger keeps the coordinates and
 *      the publishable copy does not.
 *
 *   3. WHAT ITS REAL PIXEL SIZE IS. It is the only reliable tell separating
 *      a phone screenshot from a photograph when the filename has been
 *      destroyed -- which is exactly what happens when an image arrives by
 *      text message and is saved to the camera roll.
 *
 * Everything here is a byte-level read of the container format. No library,
 * no network, no shell-out, and it never modifies the file it is reading.
 */

const fs = require('fs');

/** Container signatures, by their first bytes. */
function detectFormat(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // HEIC/HEIF: an ISO-BMFF file whose `ftyp` brand says heic/heix/mif1.
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(brand)) return 'heic';
    return 'isobmff';
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF'
      && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'gif';
  return 'unknown';
}

/** PNG: width and height live in the IHDR chunk, which is always first. */
function pngSize(buf) {
  // 8-byte signature, 4-byte length, 4-byte type, then width/height.
  if (buf.length < 24) return null;
  if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: walk the marker segments to the Start Of Frame.
 *
 * SOF0 is the common one, but a progressive JPEG uses SOF2 and an iPhone
 * writes SOF0 -- reading only SOF0 would silently return null for a whole
 * class of files, so every non-differential SOF marker counts. C4, C8 and CC
 * are DHT, JPG and DAC: they sit in the same numeric range and are NOT frame
 * headers, which is the mistake that makes a hand-rolled JPEG reader return
 * garbage dimensions.
 */
function jpegSize(buf) {
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;          // EOI, or start of scan
    const len = buf.readUInt16BE(i + 2);
    const isFrame = (marker >= 0xc0 && marker <= 0xcf)
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && i + 9 < buf.length) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function size(buf, format) {
  if (format === 'png') return pngSize(buf);
  if (format === 'jpeg') return jpegSize(buf);
  return null;                                    // heic/webp need a real decoder
}

// ── EXIF ──────────────────────────────────────────────────────────────
//
// Only the handful of tags that change how a file may be handled. This is
// deliberately not a general EXIF parser: a general parser has to be right
// about a hundred tags, and this has to be right about four.

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;

/** Read the TIFF header inside an EXIF blob and return its entries. */
function readTiff(buf, start) {
  if (start + 8 > buf.length) return null;
  const order = buf.slice(start, start + 2).toString('latin1');
  let le;
  if (order === 'II') le = true;
  else if (order === 'MM') le = false;
  else return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(start + 2) !== 42) return null;
  return { le, u16, u32, ifd0: start + u32(start + 4), base: start };
}

function readIfd(t, buf, offset, out, depth) {
  if (depth > 2 || offset + 2 > buf.length) return;
  const n = t.u16(offset);
  // A corrupt or truncated blob can claim tens of thousands of entries and
  // send this into a long walk over unrelated bytes. Real IFDs are small.
  if (n > 512) return;
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > buf.length) return;
    const tag = t.u16(e);
    const type = t.u16(e + 2);
    const count = t.u32(e + 4);
    const valOff = e + 8;

    if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD) {
      const sub = t.base + t.u32(valOff);
      if (tag === TAG_GPS_IFD) out.hasGps = true;
      if (sub > t.base && sub < buf.length) readIfd(t, buf, sub, out, depth + 1);
      continue;
    }
    // ASCII strings only; that covers Make, Model and both date fields.
    if (type !== 2 || count === 0 || count > 256) continue;
    const at = count <= 4 ? valOff : t.base + t.u32(valOff);
    if (at < 0 || at + count > buf.length) continue;
    const s = buf.slice(at, at + count).toString('latin1').replace(/\0.*$/, '').trim();
    if (!s) continue;
    if (tag === TAG_MAKE) out.make = s;
    else if (tag === TAG_MODEL) out.model = s;
    else if (tag === TAG_DATETIME_ORIGINAL) out.dateTimeOriginal = s;
    else if (tag === TAG_DATETIME && !out.dateTimeOriginal) out.dateTime = s;
  }
}

/** Find EXIF in a JPEG (APP1) or a PNG (an eXIf chunk) and read it. */
function exif(buf, format) {
  const out = { present: false, hasGps: false, make: '', model: '', dateTimeOriginal: '', dateTime: '' };
  let blobStart = -1;

  if (format === 'jpeg') {
    let i = 2;
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.slice(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
        blobStart = i + 10;
        break;
      }
      i += 2 + len;
    }
  } else if (format === 'png') {
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.slice(i + 4, i + 8).toString('latin1');
      if (type === 'eXIf') { blobStart = i + 8; break; }
      if (type === 'IDAT' || type === 'IEND') break;
      i += 12 + len;
    }
  }

  if (blobStart < 0) return out;
  const t = readTiff(buf, blobStart);
  if (!t) return out;
  out.present = true;
  readIfd(t, buf, t.ifd0, out, 0);
  return out;
}

// ── STRIPPING ─────────────────────────────────────────────────────────
//
// Producing a copy that is safe to publish. This REWRITES the container and
// drops metadata segments; it never touches the compressed image data, so the
// picture is bit-identical and only the baggage is gone.

/** JPEG: drop APP1..APP15. APP0 (JFIF) stays; it carries no personal data. */
function stripJpeg(buf) {
  const out = [buf.slice(0, 2)];
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { out.push(buf.slice(i)); break; }
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.slice(i)); break; }   // scan: copy the rest verbatim
    if (marker === 0xd9) { out.push(buf.slice(i)); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(buf.slice(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const drop = marker >= 0xe1 && marker <= 0xef;            // APP1..APP15
    if (!drop) out.push(buf.slice(i, i + 2 + len));
    i += 2 + len;
  }
  return Buffer.concat(out);
}

/** PNG: keep only the chunks a decoder needs; drop text, EXIF and timestamps. */
const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
function stripPng(buf) {
  const out = [buf.slice(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (!PNG_DROP.has(type)) out.push(buf.slice(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

function strip(buf, format) {
  if (format === 'jpeg') return stripJpeg(buf);
  if (format === 'png') return stripPng(buf);
  return null;                     // unknown container: refuse rather than guess
}

/** Everything readable about one file, in one object. */
function read(filePath) {
  const buf = fs.readFileSync(filePath);
  const format = detectFormat(buf);
  return { bytes: buf.length, format, size: size(buf, format), exif: exif(buf, format) };
}

module.exports = {
  detectFormat, pngSize, jpegSize, size, exif, strip, stripJpeg, stripPng, read,
};
