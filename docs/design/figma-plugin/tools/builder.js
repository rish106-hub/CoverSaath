// Body of an async function(figma, P). P = { jobs:[{id,title,w,h,tree}], page, x, y, gap, vars }
const pageName = P.page;
let page = figma.root.children.find(p => p.name === pageName);
if (!page) { page = figma.createPage(); page.name = pageName; }
await figma.setCurrentPageAsync(page);

// fonts
const need = new Map();
const scan = n => { if (n.t === 'T') for (const s of n.segs) need.set(s[2][0] + '|' + s[2][1], { family: s[2][0], style: s[2][1] }); if (n.k) n.k.forEach(scan); };
P.jobs.forEach(j => scan(j.tree));
const okFonts = new Set();
for (const [k, f] of need) { try { await figma.loadFontAsync(f); okFonts.add(k); } catch (e) { } }
const fallback = f => okFonts.has(f.family + '|' + f.style) ? f : (okFonts.has(f.family + '|Regular') ? { family: f.family, style: 'Regular' } : { family: 'Source Sans 3', style: 'Regular' });
await figma.loadFontAsync({ family: 'Source Sans 3', style: 'Regular' });

// colour variables (optional binding)
const varByHex = {};
if (P.vars) {
  const all = await figma.variables.getLocalVariablesAsync('COLOR');
  for (const v of all) {
    const col = Object.values(v.valuesByMode)[0];
    if (col && typeof col === 'object' && 'r' in col) varByHex[hex(col)] = v;
  }
}
function hex(c) { const h = x => Math.round(x * 255).toString(16).padStart(2, '0'); return (h(c.r) + h(c.g) + h(c.b)).toUpperCase(); }

const inv = m => { const [[a, b, c], [d, e, f]] = m; const det = a * e - b * d; return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]]; };
function paint(f, w, h) {
  if (f.k === 'S') {
    let p = { type: 'SOLID', color: { r: f.c[0], g: f.c[1], b: f.c[2] }, opacity: f.c[3] };
    const v = f.c[3] >= 0.999 ? varByHex[hex(p.color)] : null;
    if (v) p = figma.variables.setBoundVariableForPaint(p, 'color', v);
    return p;
  }
  if (f.k === 'IMG') return { type: 'IMAGE', imageHash: f.hash, scaleMode: 'FILL' };
  const stops = f.stops.map(s => ({ position: s.p, color: { r: s.c[0], g: s.c[1], b: s.c[2], a: s.c[3] } }));
  if (f.k === 'L') {
    const th = f.ang * Math.PI / 180, W = Math.max(w, 0.01), H = Math.max(h, 0.01);
    const L = Math.abs(W * Math.sin(th)) + Math.abs(H * Math.cos(th));
    const dx = Math.sin(th), dy = -Math.cos(th);
    const sx = (W / 2 - dx * L / 2) / W, sy = (H / 2 - dy * L / 2) / H, ex = (W / 2 + dx * L / 2) / W, ey = (H / 2 + dy * L / 2) / H;
    const ax = ex - sx, ay = ey - sy; const ppx = -ay * H, ppy = ax * W; const px_ = ppx / W, py_ = ppy / H;
    const M = [[ax, px_, sx - 0.5 * px_], [ay, py_, sy - 0.5 * py_]];
    return { type: 'GRADIENT_LINEAR', gradientStops: stops, gradientTransform: inv(M) };
  }
  const M = [[2 * f.rx, 0, f.cx - f.rx], [0, 2 * f.ry, f.cy - f.ry]];
  return { type: 'GRADIENT_RADIAL', gradientStops: stops, gradientTransform: inv(M) };
}
function decorate(node, n) {
  node.name = n.n || node.name;
  node.fills = (n.f || []).map(f => paint(f, n.w, n.h));
  if (n.st) {
    const c = n.st.c; node.strokes = [{ type: 'SOLID', color: { r: c[0], g: c[1], b: c[2] }, opacity: c[3] }];
    node.strokeAlign = 'INSIDE';
    const [t, r, b, l] = n.st.w;
    if (t === r && r === b && b === l) node.strokeWeight = t;
    else { node.strokeTopWeight = t; node.strokeRightWeight = r; node.strokeBottomWeight = b; node.strokeLeftWeight = l; }
    if (n.st.d === 1) node.dashPattern = [Math.max(3, t * 3), Math.max(3, t * 3)];
    if (n.st.d === 2) node.dashPattern = [Math.max(1, t), Math.max(1, t)];
  }
  if (n.r) { node.topLeftRadius = n.r[0]; node.topRightRadius = n.r[1]; node.bottomRightRadius = n.r[2]; node.bottomLeftRadius = n.r[3]; }
  const fx = [];
  if (n.e) for (const s of n.e) fx.push({ type: s.i ? 'INNER_SHADOW' : 'DROP_SHADOW', color: { r: s.c[0], g: s.c[1], b: s.c[2], a: s.c[3] }, offset: { x: s.x, y: s.y }, radius: s.b, spread: s.s, visible: true, blendMode: 'NORMAL' });
  if (n.bb) fx.push({ type: 'BACKGROUND_BLUR', radius: n.bb, visible: true });
  if (fx.length) node.effects = fx;
  if (n.o != null) node.opacity = n.o;
}
function place(node, n) {
  if (n.rot) {
    const th = n.rot * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    node.relativeTransform = [[c, -s, cx - (c * n.w / 2 - s * n.h / 2)], [s, c, cy - (s * n.w / 2 + c * n.h / 2)]];
  } else { node.x = n.x; node.y = n.y; }
}
let count = 0; const errors = [];
function build(n, parent) {
  let node;
  try {
    if (n.t === 'F' || n.t === 'R' || n.t === 'I') {
      node = n.t === 'F' ? figma.createFrame() : figma.createRectangle();
      node.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
      if (n.t === 'I') { n.f = []; decorate(node, n); node.fills = n.hash ? [{ type: 'IMAGE', imageHash: n.hash, scaleMode: n.fit || 'FILL' }] : [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }]; }
      else decorate(node, n);
      if (n.t === 'F') node.clipsContent = !!n.clip;
      parent.appendChild(node); place(node, n);
    } else if (n.t === 'V') {
      node = figma.createNodeFromSvg(n.svg);
      node.name = n.n; node.fills = [];
      parent.appendChild(node);
      if (Math.abs(node.width - n.w) > 0.5 || Math.abs(node.height - n.h) > 0.5) node.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
      if (n.o != null) node.opacity = n.o;
      place(node, n);
    } else if (n.t === 'T') {
      node = figma.createText();
      const f0 = fallback({ family: n.segs[0][2][0], style: n.segs[0][2][1] });
      node.fontName = f0;
      node.characters = n.s;
      for (const [a, b, st] of n.segs) {
        if (b <= a) continue;
        node.setRangeFontName(a, b, fallback({ family: st[0], style: st[1] }));
        node.setRangeFontSize(a, b, st[2]);
        const col = { r: st[3][0], g: st[3][1], b: st[3][2] };
        let p = { type: 'SOLID', color: col, opacity: st[3][3] };
        const v = st[3][3] >= 0.999 ? varByHex[hex(col)] : null; if (v) p = figma.variables.setBoundVariableForPaint(p, 'color', v);
        node.setRangeFills(a, b, [p]);
        node.setRangeLetterSpacing(a, b, { unit: 'PIXELS', value: st[4] });
        node.setRangeLineHeight(a, b, st[5] ? { unit: 'PIXELS', value: st[5] } : { unit: 'AUTO' });
        if (st[6]) node.setRangeTextDecoration(a, b, st[6] === 'U' ? 'UNDERLINE' : 'STRIKETHROUGH');
        if (st[7]) node.setRangeTextCase(a, b, st[7] === 'UP' ? 'UPPER' : st[7] === 'LO' ? 'LOWER' : 'TITLE');
      }
      node.textAlignHorizontal = n.al || 'LEFT';
      parent.appendChild(node);
      if (n.tight) { node.textAutoResize = 'WIDTH_AND_HEIGHT'; node.x = n.x; node.y = n.y; }
      else {
        const extra = 4 + n.w * 0.03;
        node.resize(Math.max(n.w + extra, 1), Math.max(node.height, 1));
        node.textAutoResize = 'HEIGHT';
        const dx = n.al === 'CENTER' ? extra / 2 : n.al === 'RIGHT' ? extra : 0;
        node.x = n.x - dx; node.y = n.y;
      }
      node.name = n.n || node.name;
    }
  } catch (e) { errors.push((n.n || n.t) + ': ' + String(e).slice(0, 120)); return; }
  count++;
  if (n.k && node && 'appendChild' in node && n.t === 'F') for (const c of n.k) build(c, node);
}

// place boards left to right, after anything already on the page
let x = P.x != null ? P.x : 0;
const existing = page.children.filter(c => c.type === 'FRAME' || c.type === 'SECTION');
if (P.x == null && existing.length) x = Math.max(...existing.map(c => c.x + c.width)) + (P.gap || 160);
const made = [];
const cols = P.cols || 1e9; let col = 0, rowY = P.y || 0, rowH = 0, x0 = x;
for (const j of P.jobs) {
  if (col >= cols) { col = 0; x = x0; rowY += rowH + 240; rowH = 0; }
  const root = j.tree;
  const board = figma.createFrame();
  board.resize(root.w, root.h);
  page.appendChild(board);
  decorate(board, root);
  if (!board.fills.length) board.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  board.name = j.title;
  board.clipsContent = true;
  board.x = x; board.y = rowY; rowH = Math.max(rowH, root.h); col++;
  for (const c of root.k || []) build(c, board);
  made.push({ id: board.id, name: board.name, w: board.width, h: board.height });
  x += root.w + (P.gap || 160);
}
return { page: page.id, made, count, errors: errors.slice(0, 30), errorCount: errors.length };
