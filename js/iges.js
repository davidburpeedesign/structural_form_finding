// Minimal IGES 5.3 writer: rational B-spline curves (entity 126) and points (entity 116).
// Fixed 80-column records; see the IGES 5.3 specification, sections 2.2 and 4.23.

const H = (s) => `${s.length}H${s}`;

function fmt(v) {
  if (!Number.isFinite(v)) v = 0;
  if (v === 0) return '0.0';
  let s = Number(v.toPrecision(12)).toString();
  if (s.includes('e')) { const [mant, exp] = s.split('e'); s = (mant.includes('.') ? mant : mant + '.0') + 'E' + parseInt(exp, 10); }
  else if (!s.includes('.')) s += '.0';
  return s;
}

/** Break comma-separated tokens into lines no longer than width, never splitting a token. */
function wrap(tokens, width) {
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    if (cur.length + t.length > width) { lines.push(cur); cur = ''; }
    cur += t;
  }
  if (cur) lines.push(cur);
  return lines;
}

const COLOURS = { black: 1, red: 2, green: 3, blue: 4, yellow: 5, magenta: 6, cyan: 7, white: 8 };

/**
 * @param entities [{ type:'curve', degree, knots, control, level, colour, label } | { type:'point', xyz, level, colour, label }]
 * @param meta { units:'MM'|'M'|'IN', name, maxCoord }
 */
export function writeIGES(entities, meta = {}) {
  const unitFlag = { IN: 1, MM: 2, FT: 4, M: 6, CM: 10 }[meta.units || 'MM'] ?? 2;
  const now = new Date();
  const pad = (v, k = 2) => String(v).padStart(k, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}.${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const name = meta.name || 'form-finding';

  const S = ['Structural form-finding export: funicular member centrelines.'];
  const gTokens = [
    H(','), H(';'), H(name), H(name + '.igs'), H('structural_form_finding'), H('0.1'),
    '32', '38', '6', '308', '15', H(name), '1.0', String(unitFlag), H(meta.units || 'MM'),
    '1', '0.01', H(stamp), '1.0E-6', fmt(meta.maxCoord || 1000), H(''), H(''), '11', '0', H(stamp),
  ].map((t, i, a) => t + (i === a.length - 1 ? ';' : ','));
  // an empty Hollerith string is written as nothing between delimiters
  const G = wrap(gTokens.map((t) => t.replace(/^0H/, '')), 72);

  const D = [], P = [];
  const f8 = (v) => String(v).padStart(8, ' ');
  for (const ent of entities) {
    const deSeq = D.length + 1;
    let type, tokens;
    if (ent.type === 'curve') {
      type = 126;
      const K = ent.control.length / 3 - 1, M = ent.degree;
      tokens = ['126', K, M, 0, 0, 1, 0, ...Array.from(ent.knots, fmt), ...Array(K + 1).fill('1.0'), ...Array.from(ent.control, fmt),
                fmt(ent.knots[0]), fmt(ent.knots[ent.knots.length - 1]), '0.0', '0.0', '0.0'];
    } else {
      type = 116;
      tokens = ['116', fmt(ent.xyz[0]), fmt(ent.xyz[1]), fmt(ent.xyz[2]), 0];
    }
    const toks = tokens.map((t, i) => String(t) + (i === tokens.length - 1 ? ';' : ','));
    const pLines = wrap(toks, 64);
    const pStart = P.length + 1;
    for (const l of pLines) P.push(l.padEnd(64, ' ') + ' ' + String(deSeq).padStart(7, ' '));
    const colour = COLOURS[ent.colour] || 0;
    const label = (ent.label || '').slice(0, 8).padStart(8, ' ');
    D.push(f8(type) + f8(pStart) + f8(0) + f8(0) + f8(ent.level || 0) + f8(0) + f8(0) + f8(0) + '00000000');
    D.push(f8(type) + f8(0) + f8(colour) + f8(pLines.length) + f8(0) + f8('') + f8('') + label + f8(0));
  }
  const out = [];
  const emit = (lines, letter) => lines.forEach((l, i) => out.push(l.padEnd(72, ' ') + letter + String(i + 1).padStart(7, ' ')));
  emit(S, 'S'); emit(G, 'G'); emit(D, 'D'); emit(P, 'P');
  const T = `S${pad(S.length, 7)}G${pad(G.length, 7)}D${pad(D.length, 7)}P${pad(P.length, 7)}`;
  out.push(T.padEnd(72, ' ') + 'T' + '1'.padStart(7, ' '));
  return out.join('\n') + '\n';
}
