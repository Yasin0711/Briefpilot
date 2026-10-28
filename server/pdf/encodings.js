// Zeichentabellen für PDF-Schriften (WinAnsi, MacRoman) und Glyphennamen.

const WIN_ANSI_SPECIAL = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
  0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

export const WIN_ANSI = Array.from({ length: 256 }, (_, code) => {
  if (WIN_ANSI_SPECIAL[code]) return WIN_ANSI_SPECIAL[code];
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  if (code >= 0xa0) return String.fromCharCode(code);
  if (code === 0x09 || code === 0x0a || code === 0x0d) return ' ';
  return '';
});

const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

export const MAC_ROMAN = Array.from({ length: 256 }, (_, code) => {
  if (code >= 0x80) return MAC_ROMAN_HIGH[code - 0x80] || '';
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  return '';
});

export const STANDARD = WIN_ANSI.map((ch, code) => {
  if (code === 0x27) return '’';
  if (code === 0x60) return '‘';
  return ch;
});

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+',
  comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3',
  four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü', adieresis: 'ä', odieresis: 'ö', udieresis: 'ü',
  germandbls: 'ß', Euro: '€', endash: '–', emdash: '—', quotedblbase: '„', quotedblleft: '“',
  quotedblright: '”', quotesinglbase: '‚', guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹',
  guilsinglright: '›', bullet: '•', ellipsis: '…', section: '§', degree: '°', eacute: 'é', egrave: 'è',
  ecircumflex: 'ê', agrave: 'à', aacute: 'á', acircumflex: 'â', ccedilla: 'ç', Eacute: 'É', ntilde: 'ñ',
  oacute: 'ó', ograve: 'ò', iacute: 'í', uacute: 'ú', copyright: '©', registered: '®', trademark: '™',
  paragraph: '¶', periodcentered: '·', multiply: '×', divide: '÷', sterling: '£', yen: '¥', cent: '¢',
  nbspace: ' ', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', onehalf: '½', onequarter: '¼',
  threequarters: '¾', twosuperior: '²', threesuperior: '³', mu: 'µ', plusminus: '±', dagger: '†',
};

export function glyphToUnicode(name) {
  if (!name) return '';
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  const base = name.split(/[._]/)[0];
  if (base !== name) return glyphToUnicode(base);
  return '';
}

/** Kodiert Text für die PDF-Standardschrift (WinAnsi). Nicht darstellbare Zeichen werden zu „?“. */
export function encodeWinAnsi(text) {
  const bytes = [];
  for (const ch of String(text)) {
    let code = WIN_ANSI.indexOf(ch);
    if (ch === ' ') code = 0x20;
    if (code < 0x20) code = 0x3f;
    bytes.push(code);
  }
  return Buffer.from(bytes);
}
