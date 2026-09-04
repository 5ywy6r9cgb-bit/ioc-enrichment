'use strict';
/**
 * msg.js — read an Outlook .msg without a library, a network call, or a shell.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS IN THE REPO AT ALL
 *
 * The largest body of primary evidence on a public-works investigation is
 * almost never a docket. It is the project email: who was told what, on what
 * date, and who was copied. A records request returns it as .msg by the
 * thousand, and until now this desk could not read a single one — so a
 * folder of them was an inert 2GB that had to be opened by hand, one at a
 * time, in Outlook.
 *
 * Every off-the-shelf reader is a dependency, and this repo takes none. So
 * this parses the container itself. A .msg is a Compound File Binary (CFB)
 * document — the same container as a legacy .doc — holding one stream per
 * MAPI property.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT READS, AND WHY THOSE PROPERTIES
 *
 * The prize is 0x007D, the transport message headers: the RFC-822 header
 * block exactly as it arrived. From, To, Cc, Date, Message-ID and the
 * Received chain, in the sender's own infrastructure's words rather than in
 * Outlook's re-rendering of them. On a disputed timeline, "when did this
 * actually arrive" is answered there and nowhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 *
 * It is not a mail client and it never fetches anything. It reads bytes off
 * disk that someone already has. An email is a statement by its sender — the
 * strongest kind of contemporaneous record, and still a statement. That a
 * project manager wrote "the power was cut on Tuesday" establishes that they
 * said it on the date the headers carry, not that it happened.
 */

const fs = require('fs');

const SIG = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
const FREESECT = 0xFFFFFFFF;
const ENDOFCHAIN = 0xFFFFFFFE;
const MAXREGSECT = 0xFFFFFFFA;

/** The MAPI properties worth naming. Everything else stays a hex tag. */
const PROPS = {
  '0037': 'subject',
  '007D': 'headers',          // the RFC-822 block, as received
  '0C1A': 'sender_name',
  '0C1F': 'sender_email',
  '0042': 'sent_on_behalf_of',
  '0E04': 'to',
  '0E03': 'cc',
  '0E1D': 'subject_normalized',
  '1000': 'body',
  '1013': 'body_html',
  '0039': 'client_submit_time',
  '3007': 'creation_time',
  '5D01': 'sender_smtp',
  '5D02': 'sent_representing_smtp',
  '0070': 'topic',
  '3703': 'attach_extension',
  '3707': 'attach_long_filename',
};

class Cfb {
  constructor(buf) {
    if (buf.length < 512 || !buf.subarray(0, 8).equals(SIG)) {
      throw new Error('not a compound file (bad signature)');
    }
    this.buf = buf;
    this.sectorSize = 1 << buf.readUInt16LE(30);
    this.miniSectorSize = 1 << buf.readUInt16LE(32);
    this.miniCutoff = buf.readUInt32LE(56);
    this.dirStart = buf.readUInt32LE(48);
    this.miniFatStart = buf.readUInt32LE(60);
    this.difatStart = buf.readUInt32LE(68);
    this.difatCount = buf.readUInt32LE(72);
    this.fat = this._readFat();
    this.miniFat = this._chainToArray(this.miniFatStart);
    this.dir = this._readDir();
    this.miniStream = this.dir.length
      ? this._readChain(this.dir[0].start, this.dir[0].size, false)
      : Buffer.alloc(0);
  }

  _sector(n) {
    const off = 512 + n * this.sectorSize;
    return this.buf.subarray(off, off + this.sectorSize);
  }

  /** FAT sector numbers come from the DIFAT: 109 inline, the rest chained. */
  _readFat() {
    const sectors = [];
    for (let i = 0; i < 109; i++) {
      const s = this.buf.readUInt32LE(76 + i * 4);
      if (s === FREESECT || s > MAXREGSECT) break;
      sectors.push(s);
    }
    let next = this.difatStart;
    let guard = 0;
    while (next !== ENDOFCHAIN && next <= MAXREGSECT && guard++ < 10000) {
      const sec = this._sector(next);
      const per = this.sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const s = sec.readUInt32LE(i * 4);
        if (s !== FREESECT && s <= MAXREGSECT) sectors.push(s);
      }
      next = sec.readUInt32LE(this.sectorSize - 4);
    }
    const fat = [];
    for (const s of sectors) {
      const sec = this._sector(s);
      for (let i = 0; i < this.sectorSize / 4; i++) fat.push(sec.readUInt32LE(i * 4));
    }
    return fat;
  }

  _chainToArray(start) {
    const out = [];
    let n = start;
    let guard = 0;
    while (n !== ENDOFCHAIN && n <= MAXREGSECT && guard++ < 200000) {
      const sec = this._sector(n);
      for (let i = 0; i < this.sectorSize / 4; i++) out.push(sec.readUInt32LE(i * 4));
      n = this.fat[n];
      if (n === undefined) break;
    }
    return out;
  }

  /** Follow a chain and return `size` bytes. Mini streams live in the root. */
  _readChain(start, size, mini) {
    const unit = mini ? this.miniSectorSize : this.sectorSize;
    const parts = [];
    let n = start;
    let got = 0;
    let guard = 0;
    while (n !== ENDOFCHAIN && n <= MAXREGSECT && got < size && guard++ < 200000) {
      let chunk;
      if (mini) {
        const off = n * this.miniSectorSize;
        chunk = this.miniStream.subarray(off, off + this.miniSectorSize);
      } else {
        chunk = this._sector(n);
      }
      parts.push(chunk);
      got += unit;
      n = mini ? this.miniFat[n] : this.fat[n];
      if (n === undefined) break;
    }
    return Buffer.concat(parts).subarray(0, size);
  }

  _readDir() {
    const raw = this._readChainRawDir();
    const entries = [];
    for (let off = 0; off + 128 <= raw.length; off += 128) {
      const nameLen = raw.readUInt16LE(off + 64);
      if (nameLen === 0 || nameLen > 64) { entries.push(null); continue; }
      const name = raw.subarray(off, off + Math.max(0, nameLen - 2)).toString('utf16le');
      const type = raw.readUInt8(off + 66);
      if (type === 0) { entries.push(null); continue; }
      entries.push({
        name,
        type,                                   // 1 storage, 2 stream, 5 root
        start: raw.readUInt32LE(off + 116),
        size: Number(raw.readBigUInt64LE(off + 120)),
      });
    }
    return entries.filter(Boolean);
  }

  _readChainRawDir() {
    const parts = [];
    let n = this.dirStart;
    let guard = 0;
    while (n !== ENDOFCHAIN && n <= MAXREGSECT && guard++ < 200000) {
      parts.push(this._sector(n));
      n = this.fat[n];
      if (n === undefined) break;
    }
    return Buffer.concat(parts);
  }

  stream(entry) {
    const mini = entry.size < this.miniCutoff && entry.type !== 5;
    return this._readChain(entry.start, entry.size, mini);
  }
}

/** Parse one .msg into named fields plus every other property it carried. */
function readMsg(file) {
  const cfb = new Cfb(fs.readFileSync(file));
  const out = { file, props: {}, attachments: [] };

  for (const e of cfb.dir) {
    if (e.type !== 2) continue;
    const m = /^__substg1\.0_([0-9A-F]{4})([0-9A-F]{4})$/.exec(e.name);
    if (!m) continue;
    const [, tag, type] = m;
    let val;
    const bytes = cfb.stream(e);
    if (type === '001F') val = bytes.toString('utf16le');
    else if (type === '001E') val = bytes.toString('latin1');
    else continue;                     // binary properties are not text
    val = val.replace(/\0+$/, '');
    const key = PROPS[tag] || `x${tag}`;
    // Attachment filenames repeat across attachment storages; keep them all.
    if (key === 'attach_long_filename') out.attachments.push(val);
    else if (out.props[key] === undefined) out.props[key] = val;
  }
  return out;
}

/**
 * Pull the fields that matter out of the RFC-822 header block.
 *
 * Preferred over Outlook's own From/To properties because these are what the
 * mail systems actually exchanged. Outlook rewrites display names against the
 * local address book, so its rendering of a sender can differ from the address
 * that really sent the message — which is exactly the kind of discrepancy an
 * investigation cares about.
 */
function parseHeaders(raw) {
  if (!raw) return {};
  const unfolded = String(raw).replace(/\r?\n[ \t]+/g, ' ');
  const get = (name) => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
    const m = re.exec(unfolded);
    return m ? m[1].trim() : '';
  };
  const received = (unfolded.match(/^Received:.*$/gim) || []).map((l) => l.trim());
  return {
    from: get('From'),
    to: get('To'),
    cc: get('Cc'),
    date: get('Date'),
    subject: get('Subject'),
    messageId: get('Message-ID'),
    replyTo: get('Reply-To'),
    // Oldest last: the chain is prepended at each hop, so the bottom entry is
    // the first machine that touched it.
    received,
    hops: received.length,
  };
}

/** Everything one file yields, in one shape. */
function read(file) {
  const m = readMsg(file);
  const h = parseHeaders(m.props.headers);
  return {
    file,
    subject: h.subject || m.props.subject || '',
    from: h.from || m.props.sender_email || m.props.sender_name || '',
    to: h.to || m.props.to || '',
    cc: h.cc || m.props.cc || '',
    date: h.date || m.props.client_submit_time || '',
    messageId: h.messageId || '',
    hops: h.hops || 0,
    body: m.props.body || '',
    attachments: m.attachments,
    props: m.props,
  };
}

module.exports = { read, readMsg, parseHeaders, Cfb, PROPS };
