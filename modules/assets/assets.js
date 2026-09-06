'use strict';
/**
 * assets.js — what an image IS decides how it may be used.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DISTINCTION THIS FILE EXISTS TO ENFORCE
 *
 * A folder of images looks homogeneous and is not. Three different things
 * arrive by the same route and carry completely different evidentiary weight:
 *
 *   PHOTOGRAPH  The operator stood somewhere and pressed a shutter. He holds
 *               the original. It is a primary artifact -- GREEN -- and it is
 *               also the only category that leaks his location.
 *
 *   SCREENSHOT  A picture OF a source. It is NOT the source. The source is a
 *               URL, and until that URL has been fetched and hashed, a
 *               screenshot proves only that someone's screen once showed
 *               these pixels. It can be scrolled, cropped, zoomed, or
 *               assembled. It files as SOURCE_NEEDED and stays there until
 *               `doc get` has been run against the page it depicts.
 *
 *   GRAPHIC     Something the desk made: a title card, a chart, a layout.
 *               It is GENERATED. It may quote evidence but it is never
 *               evidence, and the single worst outcome in this whole system
 *               is a designed graphic being filed as a source and then cited
 *               back by the desk that drew it.
 *
 * The classifier GUESSES, from bytes, and says so. The operator overrides it
 * with --as. A guess that presents itself as a determination is the failure
 * this whole repository is built against.
 */

const path = require('path');
const IMG = require('./image.js');

const KINDS = {
  PHOTOGRAPH: {
    tier: 'GREEN',
    what: 'shot on a camera. A primary artifact you hold.',
    care: 'carries GPS and a timestamp — publish only the stripped copy.',
  },
  SCREENSHOT: {
    tier: 'SOURCE_NEEDED',
    what: 'a picture OF a source, which is not the source.',
    care: 'needs the URL fetched with `doc get` before it supports anything.',
  },
  GRAPHIC: {
    tier: 'GENERATED',
    what: 'made by this desk. Never evidence, whatever it depicts.',
    care: 'every claim printed on it needs its own source, separately.',
  },
  UNKNOWN: {
    tier: 'SOURCE_NEEDED',
    what: 'could not be told apart from the bytes.',
    care: 'set it yourself with --as before using it for anything.',
  },
};

/**
 * Phone and tablet screen shapes, as ASPECT RATIOS rather than pixel sizes.
 *
 * Pixel size is the obvious tell and it is destroyed in transit: an image sent
 * by text message and saved to the camera roll has been re-encoded and often
 * downscaled, so an exact match against 1179x2556 finds nothing. The RATIO
 * survives that, because the pipeline scales rather than crops.
 */
const SCREEN_ASPECTS = [
  { r: 19.5 / 9, label: 'modern iPhone' },
  { r: 16 / 9, label: '16:9 phone' },
  { r: 18 / 9, label: '18:9 phone' },
  { r: 4 / 3, label: 'iPad' },
];

function looksLikeAScreen(size) {
  if (!size || !size.width || !size.height) return null;
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  const ratio = long / short;
  for (const s of SCREEN_ASPECTS) {
    if (Math.abs(ratio - s.r) / s.r < 0.02) return s.label;
  }
  return null;
}

/**
 * Classify one image.
 *
 * Returns { kind, confidence, why }. `why` is the actual reason, printed to
 * the operator, so a wrong guess is arguable rather than mysterious.
 */
function classify(meta, filename) {
  const e = (meta && meta.exif) || {};
  const base = path.basename(filename || '').toLowerCase();

  // A camera wrote its own name into the file. Nothing else does this, and it
  // is the only high-confidence signal available.
  if (e.make && e.model && (e.dateTimeOriginal || e.dateTime)) {
    return {
      kind: 'PHOTOGRAPH',
      confidence: 'high',
      why: `EXIF names the camera (${e.make} ${e.model}) and when the shutter fired`,
    };
  }

  // The filename, where the operating system left one intact.
  if (/^screen ?shot|^screenshot|^simulator screen/.test(base)) {
    return { kind: 'SCREENSHOT', confidence: 'high', why: 'the filename says so' };
  }

  const screen = looksLikeAScreen(meta && meta.size);
  if (screen && !e.make) {
    return {
      kind: 'SCREENSHOT',
      confidence: 'medium',
      why: `no camera in the EXIF and the proportions are a ${screen} screen`,
    };
  }

  if (meta && meta.size && !e.make) {
    return {
      kind: 'GRAPHIC',
      confidence: 'low',
      why: 'no camera in the EXIF and the proportions are not a phone screen',
    };
  }

  return { kind: 'UNKNOWN', confidence: 'none', why: 'nothing in the file settles it' };
}

/** The sourcing tier a kind files under. */
function tierFor(kind) {
  return (KINDS[kind] || KINDS.UNKNOWN).tier;
}

/**
 * Does this file need a stripped copy before it can be published?
 *
 * Only when there is something to strip. Answering "yes" for every file would
 * fill the store with identical duplicates and teach the operator to ignore
 * the flag, which is how a real warning stops working.
 */
function needsStripping(meta) {
  const e = (meta && meta.exif) || {};
  return Boolean(e.hasGps || e.make || e.dateTimeOriginal || e.dateTime);
}

/** A filename that says what the thing is, for a folder someone will scroll. */
function assetName(kind, label, sha, ext, when) {
  const day = (when || new Date().toISOString()).slice(0, 10);
  const slug = String(label || 'untitled')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
  return `${day}_${kind.toLowerCase()}_${slug}_${String(sha).slice(0, 8)}${ext}`;
}

const EXT = { jpeg: '.jpg', png: '.png', heic: '.heic', webp: '.webp', gif: '.gif' };
function extFor(format, original) {
  return EXT[format] || path.extname(original || '').toLowerCase() || '.bin';
}

/** Is this a file we should even look at? */
function isImageFile(name) {
  return /\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i.test(name);
}

module.exports = {
  KINDS, SCREEN_ASPECTS, looksLikeAScreen, classify, tierFor,
  needsStripping, assetName, extFor, isImageFile,
};
