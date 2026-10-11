'use strict';
/**
 * Minimal terminal UI toolkit: ANSI escape sequences, a double-buffered screen
 * and a box/bar drawing layer.
 *
 * Written by hand rather than pulled from npm because this project must run with
 * zero installed dependencies on a low-power machine, and because the rendering
 * needs are small (text, boxes, bars).
 *
 * The screen is double-buffered: frames are composed into a string and written
 * in a single write() call, which avoids the tearing and flicker that per-line
 * writes cause on a slow console.
 */

const ESC = '\u001b[';

const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  reverse: `${ESC}7m`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  clear: `${ESC}2J`,
  home: `${ESC}H`,
  altScreenOn: `${ESC}?1049h`,
  altScreenOff: `${ESC}?1049l`,
};

/** 256-colour foreground / background helpers. */
const fg = (n) => `${ESC}38;5;${n}m`;
const bg = (n) => `${ESC}48;5;${n}m`;

/**
 * A palette of 256-colour codes chosen to match the web dashboard's dark theme
 * so both front ends read the same way.
 */
const C = {
  reset: ansi.reset,
  bold: ansi.bold,
  dim: ansi.dim,
  text: fg(253),
  dimText: fg(245),
  faint: fg(240),
  accent: fg(84),    // green
  accent2: fg(75),   // blue
  accent3: fg(212),  // pink
  warn: fg(221),     // yellow
  danger: fg(203),   // red
  border: fg(238),
  borderFocus: fg(75),
  head: fg(111),
  bar: fg(75),
  barWarn: fg(221),
  barDanger: fg(203),
  barOk: fg(84),
};

/**
 * Visible width of a string, ignoring ANSI escapes and counting East Asian wide
 * characters as two columns. Without the wide-character handling, Chinese text
 * would misalign every box border.
 */
function visibleWidth(str) {
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.codePointAt(i);
    if (code === 0x1b) {
      // Skip a CSI sequence.
      const m = /^\u001b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
      if (m) { i += m[0].length; continue; }
      i += 1;
      continue;
    }
    if (isWide(code)) w += 2;
    else w += 1;
    i += code > 0xffff ? 2 : 1;
  }
  return w;
}

/**
 * Whether a codepoint occupies two terminal columns.
 * Covers CJK, full-width forms, and common emoji ranges.
 */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) ||   // CJK radicals, punctuation
    (code >= 0x3041 && code <= 0x33ff) ||   // Kana, CJK symbols
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) ||   // Yi
    (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK compat
    (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK compat forms
    (code >= 0xff00 && code <= 0xff60) ||   // Full-width forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) || // Emoji
    (code >= 0x20000 && code <= 0x3fffd)    // CJK ext B+
  );
}

/** Truncate to a visible width, appending an ellipsis when cut. */
function truncate(str, width) {
  if (visibleWidth(str) <= width) return str;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.codePointAt(i);
    if (code === 0x1b) {
      const m = /^\u001b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cw = isWide(code) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += String.fromCodePoint(code);
    w += cw;
    i += code > 0xffff ? 2 : 1;
  }
  return out + '…';
}

/** Pad to a visible width (right-pad by default). */
function pad(str, width, align = 'left') {
  const vis = visibleWidth(str);
  const gap = Math.max(0, width - vis);
  if (align === 'right') return ' '.repeat(gap) + str;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + str + ' '.repeat(gap - left);
  }
  return str + ' '.repeat(gap);
}

/** A horizontal bar, e.g. [████████░░░░░░] */
function bar(fraction, width, color) {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  const col = color || C.bar;
  return `${col}${'█'.repeat(filled)}${C.faint}${'░'.repeat(width - filled)}${C.reset}`;
}

/** Colour for a percentage, matching the web dashboard's thresholds. */
function loadColor(pct) {
  if (pct >= 90) return C.barDanger;
  if (pct >= 75) return C.barWarn;
  return C.barOk;
}

/**
 * Screen: double-buffered renderer for the alternate screen buffer.
 *
 * Usage:
 *   const screen = new Screen();
 *   screen.enter();
 *   screen.render(lines);   // lines: array of strings (already styled)
 *   screen.exit();
 */
class Screen {
  constructor(out = process.stdout) {
    this.out = out;
    this.width = out.columns || 80;
    this.height = out.rows || 24;
    this.entered = false;
    this.lastFrame = null;
  }

  enter() {
    if (this.entered) return;
    this.out.write(ansi.altScreenOn + ansi.hideCursor + ansi.clear + ansi.home);
    this.entered = true;
    this.lastFrame = null;
  }

  exit() {
    if (!this.entered) return;
    this.out.write(ansi.reset + ansi.showCursor + ansi.altScreenOff);
    this.entered = false;
  }

  resize() {
    this.width = this.out.columns || 80;
    this.height = this.out.rows || 24;
  }

  /**
   * Render a frame. Each line is padded to the full width and the whole frame is
   * written once, positioned at the home cursor, so the console never shows a
   * partially drawn screen.
   *
   * @param {string[]} lines
   */
  render(lines) {
    this.resize();
    const rows = [];
    for (let i = 0; i < this.height; i++) {
      const line = lines[i] === undefined ? '' : lines[i];
      // Pad to width, then clear any residue with an explicit erase-to-end.
      rows.push(pad(line, this.width) + `${ESC}K`);
    }
    const frame = ansi.home + rows.join('\n');
    // Skip identical frames to avoid pointless console writes (this matters on a
    // slow console, and it also makes idle CPU usage effectively zero).
    if (frame === this.lastFrame) return false;
    this.lastFrame = frame;
    this.out.write(frame);
    return true;
  }
}

/** Draw a titled box around pre-rendered content lines. */
function box(title, contentLines, width, opts = {}) {
  const borderColor = opts.focus ? C.borderFocus : C.border;
  const inner = width - 2;
  const out = [];

  // Top border with an inset title.
  let head = '';
  if (title) {
    const t = ` ${title} `;
    const tWidth = visibleWidth(t);
    const left = 2;
    const right = Math.max(0, inner - left - tWidth);
    head = `${borderColor}┌${'─'.repeat(left)}${C.reset}${C.head}${C.bold}${t}${C.reset}${borderColor}${'─'.repeat(right)}┐${C.reset}`;
  } else {
    head = `${borderColor}┌${'─'.repeat(inner)}┐${C.reset}`;
  }
  out.push(head);

  for (const line of contentLines) {
    out.push(`${borderColor}│${C.reset}${pad(line, inner)}${borderColor}│${C.reset}`);
  }

  out.push(`${borderColor}└${'─'.repeat(inner)}┘${C.reset}`);
  return out;
}

/**
 * Join two arrays of rendered lines side by side, padding the shorter one.
 * Widths are taken as fixed column widths supplied by the caller.
 */
function columns(cols) {
  const height = Math.max(...cols.map((c) => c.lines.length), 0);
  const out = [];
  for (let i = 0; i < height; i++) {
    let line = '';
    for (const c of cols) {
      const cell = c.lines[i] === undefined ? '' : c.lines[i];
      line += pad(cell, c.width);
    }
    out.push(line);
  }
  return out;
}

module.exports = {
  ansi, C, fg, bg,
  visibleWidth, truncate, pad, bar, loadColor, isWide,
  Screen, box, columns,
};
