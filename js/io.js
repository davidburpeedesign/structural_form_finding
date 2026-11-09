// File parsers. Everything returns plain typed arrays so results can cross the worker boundary.
//
// Mesh:   { positions: Float64Array(3n), triangles: Uint32Array(3t), scalars: Float64Array(n)|null }
// Points: Float64Array(3k)

const num = (s) => parseFloat(s.replace(/[dD]/, 'e'));

/** Convert an RGB triple to a single 0..1 scalar (mean of channels; inputs may be 0..1 or 0..255). */
function colourToScalar(r, g, b, is255) {
  const k = is255 ? 1 / 255 : 1;
  return Math.min(1, Math.max(0, ((r + g + b) / 3) * k));
}

export function parseOBJ(text) {
  const pos = [], col = [], tris = [], pointIdx = [];
  let anyColour = false, maxCol = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0), c1 = line.charCodeAt(1);
    if (c0 === 118 /* v */ && (c1 === 32 || c1 === 9)) {
      const p = line.trim().split(/\s+/);
      pos.push(num(p[1]), num(p[2]), num(p[3]));
      if (p.length >= 7) {
        const r = num(p[4]), g = num(p[5]), b = num(p[6]);
        col.push(r, g, b); anyColour = true;
        maxCol = Math.max(maxCol, r, g, b);
      } else col.push(NaN, NaN, NaN);
    } else if (c0 === 102 /* f */ && (c1 === 32 || c1 === 9)) {
      const p = line.trim().split(/\s+/);
      const n = pos.length / 3;
      const idx = [];
      for (let i = 1; i < p.length; i++) {
        let k = parseInt(p[i], 10);          // "12/3/4" -> 12
        if (Number.isNaN(k)) continue;
        idx.push(k < 0 ? n + k : k - 1);
      }
      for (let i = 1; i + 1 < idx.length; i++) tris.push(idx[0], idx[i], idx[i + 1]);
    } else if (c0 === 112 /* p */ && (c1 === 32 || c1 === 9)) {
      const p = line.trim().split(/\s+/);
      const n = pos.length / 3;
      for (let i = 1; i < p.length; i++) { const k = parseInt(p[i], 10); pointIdx.push(k < 0 ? n + k : k - 1); }
    }
  }
  const n = pos.length / 3;
  let scalars = null;
  if (anyColour) {
    const is255 = maxCol > 1.0001;
    scalars = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = col[3 * i];
      scalars[i] = Number.isNaN(r) ? 1 : colourToScalar(r, col[3 * i + 1], col[3 * i + 2], is255);
    }
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris), scalars, pointIdx };
}

export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  // header is ASCII up to "end_header\n"
  let headerEnd = -1;
  const marker = 'end_header';
  outer: for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker.charCodeAt(j)) continue outer;
    headerEnd = i + marker.length;
    while (bytes[headerEnd] !== 10 && headerEnd < bytes.length) headerEnd++;
    headerEnd++;
    break;
  }
  if (headerEnd < 0) throw new Error('PLY: no end_header found');
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)).split(/\r?\n/);
  let format = 'ascii';
  const elements = [];
  for (const l of header) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'format') format = p[1];
    else if (p[0] === 'element') elements.push({ name: p[1], count: parseInt(p[2], 10), props: [] });
    else if (p[0] === 'property') {
      const el = elements[elements.length - 1];
      if (p[1] === 'list') el.props.push({ list: true, countType: p[2], type: p[3], name: p[4] });
      else el.props.push({ list: false, type: p[1], name: p[2] });
    }
  }
  if (format === 'binary_big_endian') throw new Error('PLY: big-endian files are not supported');
  const sizes = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const dv = new DataView(buffer);
  let off = headerEnd;
  const readBin = (t) => {
    let v;
    switch (t) {
      case 'char': case 'int8': v = dv.getInt8(off); break;
      case 'uchar': case 'uint8': v = dv.getUint8(off); break;
      case 'short': case 'int16': v = dv.getInt16(off, true); break;
      case 'ushort': case 'uint16': v = dv.getUint16(off, true); break;
      case 'int': case 'int32': v = dv.getInt32(off, true); break;
      case 'uint': case 'uint32': v = dv.getUint32(off, true); break;
      case 'float': case 'float32': v = dv.getFloat32(off, true); break;
      case 'double': case 'float64': v = dv.getFloat64(off, true); break;
      default: throw new Error('PLY: unknown type ' + t);
    }
    off += sizes[t];
    return v;
  };
  let tokens = null, ti = 0;
  if (format === 'ascii') tokens = new TextDecoder().decode(bytes.subarray(headerEnd)).split(/\s+/).filter(Boolean);
  const read = (t) => (tokens ? parseFloat(tokens[ti++]) : readBin(t));

  let positions = null, scalars = null;
  const tris = [];
  for (const el of elements) {
    if (el.name === 'vertex') {
      positions = new Float64Array(3 * el.count);
      const names = el.props.map((p) => p.name);
      const has = (n) => names.includes(n);
      const rN = has('red') ? 'red' : has('r') ? 'r' : null;
      const hasCol = !!rN;
      const colType = hasCol ? el.props[names.indexOf(rN)].type : null;
      const is255 = hasCol && !/float|double/.test(colType);
      const scalarName = ['quality', 'scalar', 'value', 'load'].find(has);
      if (hasCol || scalarName) scalars = new Float64Array(el.count);
      for (let i = 0; i < el.count; i++) {
        let r = 0, g = 0, b = 0, s = null;
        for (const p of el.props) {
          if (p.list) { const c = read(p.countType); for (let k = 0; k < c; k++) read(p.type); continue; }
          const v = read(p.type);
          switch (p.name) {
            case 'x': positions[3 * i] = v; break;
            case 'y': positions[3 * i + 1] = v; break;
            case 'z': positions[3 * i + 2] = v; break;
            case 'red': case 'r': r = v; break;
            case 'green': case 'g': g = v; break;
            case 'blue': case 'b': b = v; break;
            default: if (p.name === scalarName) s = v;
          }
        }
        if (scalars) scalars[i] = s !== null ? Math.min(1, Math.max(0, s)) : colourToScalar(r, g, b, is255);
      }
    } else if (el.name === 'face') {
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (p.list) {
            const c = read(p.countType);
            const idx = [];
            for (let k = 0; k < c; k++) idx.push(read(p.type));
            if (p.name === 'vertex_indices' || p.name === 'vertex_index')
              for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]);
          } else read(p.type);
        }
      }
    } else {
      for (let i = 0; i < el.count; i++)
        for (const p of el.props) {
          if (p.list) { const c = read(p.countType); for (let k = 0; k < c; k++) read(p.type); } else read(p.type);
        }
    }
  }
  if (!positions) throw new Error('PLY: no vertex element');
  return { positions, triangles: Uint32Array.from(tris), scalars, pointIdx: [] };
}

/** Point entities (type 116) from an IGES file. Transformation matrices are ignored. */
export function parseIGESPoints(text) {
  const lines = text.split(/\r?\n/);
  const dirType = new Map();   // DE sequence number -> entity type
  const pdata = new Map();     // DE sequence number -> concatenated parameter text
  for (const raw of lines) {
    if (raw.length < 73) continue;
    const sec = raw[72];
    if (sec === 'D') {
      const seq = parseInt(raw.slice(73, 80), 10);
      if (seq % 2 === 1) dirType.set(seq, parseInt(raw.slice(0, 8), 10));
    } else if (sec === 'P') {
      const de = parseInt(raw.slice(64, 72), 10);
      pdata.set(de, (pdata.get(de) || '') + raw.slice(0, 64).trimEnd());
    }
  }
  const out = [];
  for (const [de, s] of pdata) {
    const body = s.replace(/;.*$/, '');
    const p = body.split(',');
    const type = parseInt(p[0], 10);
    if (type === 116 && (dirType.get(de) ?? 116) === 116) out.push(num(p[1] || '0'), num(p[2] || '0'), num(p[3] || '0'));
  }
  return Float64Array.from(out);
}

/** Plain point lists: one "x y z" / "x,y,z" / "x;y;z" per line (Rhino "Points file" export). */
export function parsePointText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === '#' || t.startsWith('//')) continue;
    const p = t.split(/[\s,;]+/).map(num);
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) out.push(p[0], p[1], p[2]);
  }
  return Float64Array.from(out);
}

const ext = (name) => (name.split('.').pop() || '').toLowerCase();

/** file-name + ArrayBuffer -> mesh */
export function loadMesh(name, buffer) {
  const e = ext(name);
  let m;
  if (e === 'ply') m = parsePLY(buffer);
  else if (e === 'obj') m = parseOBJ(new TextDecoder().decode(buffer));
  else throw new Error(`Unsupported mesh format ".${e}" - use .obj or .ply`);
  if (m.triangles.length === 0) throw new Error('The file contains no faces.');
  return m;
}

/** file-name + ArrayBuffer -> Float64Array of xyz support points */
export function loadPoints(name, buffer) {
  const e = ext(name);
  const text = e === 'ply' ? null : new TextDecoder().decode(buffer);
  let pts;
  if (e === 'igs' || e === 'iges') pts = parseIGESPoints(text);
  else if (e === 'obj') {
    const m = parseOBJ(text);
    // Use explicit point elements when present, otherwise every vertex in the file.
    if (m.pointIdx.length) {
      pts = new Float64Array(3 * m.pointIdx.length);
      m.pointIdx.forEach((k, i) => pts.set(m.positions.subarray(3 * k, 3 * k + 3), 3 * i));
    } else pts = m.positions;
  } else if (e === 'ply') pts = parsePLY(buffer).positions;
  else pts = parsePointText(text);
  if (pts.length === 0) throw new Error('No points found in the file.');
  return pts;
}
