'use strict';
/**
 * Multi-frame zstd JSONL reader for DSH session logs.
 *
 * DSH appends each batch of session events as its own complete zstd frame, so a
 * session file is a concatenation of many independent frames. Node's
 * zlib.zstdDecompressSync() throws on trailing data, so we locate frame
 * boundaries ourselves.
 *
 * Boundary detection: scan for the zstd magic number (0x28 0xB5 0x2F 0xFD), then
 * validate each candidate by attempting decompression. A magic sequence that
 * merely appears inside a frame payload will not decompress as a valid frame, so
 * validation rejects it and we fall through to the next candidate.
 */

const zlib = require('zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Offsets of every zstd magic number in buf at or after `from`. */
function findMagicOffsets(buf, from) {
  const out = [];
  let i = from;
  for (;;) {
    i = buf.indexOf(MAGIC, i);
    if (i < 0) break;
    out.push(i);
    i += 1;
  }
  return out;
}

/**
 * Decompress as many complete zstd frames as possible from buf.
 *
 * @param {Buffer} buf
 * @returns {{text: string, consumed: number}} `consumed` is the byte offset just
 *   past the last frame that decompressed successfully. A partially written
 *   trailing frame is left unconsumed so the caller can retry it later.
 */
function decompressFrames(buf) {
  if (!buf.length) return { text: '', consumed: 0 };

  const candidates = findMagicOffsets(buf, 0);
  if (!candidates.length) return { text: '', consumed: 0 };

  let text = '';
  let consumed = 0;
  let ci = 0;

  while (ci < candidates.length) {
    const start = candidates[ci];
    if (start !== consumed) {
      // Bytes before this candidate could not be decoded as a frame. Rather than
      // silently skipping data, stop and let the caller decide (this only
      // happens for a truncated frame at the head of the buffer).
      break;
    }

    let decoded = null;
    let endOffset = -1;
    // Try the next candidate boundary first (the common case: frames are
    // contiguous), then progressively later boundaries.
    for (let cj = ci + 1; cj <= candidates.length; cj++) {
      const end = cj < candidates.length ? candidates[cj] : buf.length;
      if (end <= start) continue;
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(start, end));
        endOffset = end;
        ci = cj;
        break;
      } catch {
        // Boundary guess was wrong (false magic inside payload, or a truncated
        // trailing frame). Widen and retry.
      }
    }

    if (decoded === null) break; // incomplete trailing frame; retry next poll

    text += decoded.toString('utf8');
    consumed = endOffset;
  }

  return { text, consumed };
}

/**
 * Incrementally decode a DSH session log file.
 *
 * Keeps per-path decode state so repeated polls only read newly appended bytes.
 * If the file shrank or was rewritten, state resets and the whole file is
 * re-read.
 */
class SessionLogReader {
  constructor() {
    /** @type {Map<string, {offset: number, text: string}>} */
    this.state = new Map();
  }

  /**
   * @param {string} filePath
   * @param {Buffer} buf entire current file contents
   * @returns {string} newly decoded text since the previous call
   */
  update(filePath, buf) {
    let st = this.state.get(filePath);
    if (!st || st.offset > buf.length) {
      st = { offset: 0, text: '' };
      this.state.set(filePath, st);
    }

    if (buf.length <= st.offset) return '';

    const { text, consumed } = decompressFrames(buf.subarray(st.offset));
    st.offset += consumed;
    return text;
  }

  forget(filePath) {
    this.state.delete(filePath);
  }

  reset() {
    this.state.clear();
  }
}

/** Parse JSONL text into objects, skipping blank and malformed lines. */
function parseJsonl(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let nl = text.indexOf('\n', i);
    if (nl < 0) nl = text.length;
    const line = text.slice(i, nl).trim();
    i = nl + 1;
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line split across two frames, or genuinely malformed: skip it.
    }
  }
  return out;
}

module.exports = { decompressFrames, SessionLogReader, parseJsonl, findMagicOffsets };
