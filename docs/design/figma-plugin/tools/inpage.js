// Runs inside the rendered artboard page. Expands the Design Component template,
// settles animations to their resting state, then walks the DOM into a compact tree.
window.__expand = function (overrides) {
  const scriptEl = document.querySelector('script[type="text/x-dc"]');
  const defs = JSON.parse(scriptEl.getAttribute('data-props') || '{}');
  const props = {};
  for (const k in defs) if (defs[k] && typeof defs[k] === 'object' && 'default' in defs[k]) props[k] = defs[k].default;
  Object.assign(props, overrides || {});
  const Comp = new Function('DCLogic', scriptEl.textContent + '\n;return Component;')(window.DCLogic);
  const inst = new Comp(props);
  if (overrides && overrides.__state) Object.assign(inst.state, overrides.__state);
  const vals = inst.renderVals();
  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const look = (path, scope) => {
    const parts = path.trim().split('.');
    let cur = parts[0] in scope ? scope[parts[0]] : vals[parts[0]];
    for (let i = 1; i < parts.length; i++) cur = cur == null ? undefined : cur[parts[i]];
    return cur;
  };
  const truthy = v => !(v === false || v == null || v === '' || v === 0 || v === 'false');
  const sub = (str, scope) => str.replace(HOLE, (m, p) => { const v = look(p, scope); return v == null ? '' : String(v); });
  function expand(parent, scope) {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) { if (node.data.includes('{{')) node.data = sub(node.data, scope); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === 'sc-for') {
        const m = /\{\{\s*([^}]+?)\s*\}\}/.exec(node.getAttribute('list') || '');
        const list = m ? look(m[1], scope) : [];
        const as = node.getAttribute('as');
        const frag = document.createDocumentFragment();
        (Array.isArray(list) ? list : []).forEach((item, i) => {
          const holder = document.createElement('div');
          for (const c of node.childNodes) holder.appendChild(c.cloneNode(true));
          const s2 = Object.assign({}, scope, { [as]: item, $index: i });
          expand(holder, s2);
          while (holder.firstChild) frag.appendChild(holder.firstChild);
        });
        node.replaceWith(frag);
        continue;
      }
      if (tag === 'sc-if') {
        const m = /\{\{\s*([^}]+?)\s*\}\}/.exec(node.getAttribute('value') || '');
        const ok = m ? truthy(look(m[1], scope)) : false;
        if (!ok) { node.remove(); continue; }
        expand(node, scope);
        const frag = document.createDocumentFragment();
        while (node.firstChild) frag.appendChild(node.firstChild);
        node.replaceWith(frag);
        continue;
      }
      for (const a of Array.from(node.attributes)) {
        if (/^on[a-z]/i.test(a.name)) { node.removeAttribute(a.name); continue; }
        if (a.value.includes('{{')) node.setAttribute(a.name, sub(a.value, scope));
      }
      expand(node, scope);
    }
  }
  const root = document.querySelector('x-dc');
  const helmet = root.querySelector('helmet');
  if (helmet) { for (const c of Array.from(helmet.childNodes)) document.head.appendChild(c); helmet.remove(); }
  expand(root, {});
  return true;
};

window.__settle = function () {
  for (const a of document.getAnimations()) {
    try {
      const tl = a.timeline;
      const isDoc = tl && tl.constructor && tl.constructor.name === 'DocumentTimeline';
      if (!isDoc) { a.cancel(); continue; }
      const t = a.effect.getComputedTiming();
      if (t.iterations === Infinity) { a.pause(); a.currentTime = 0; }
      else a.finish();
    } catch (e) { try { a.cancel(); } catch (e2) {} }
  }
  return document.getAnimations().length;
};

window.__extract = function (opts) {
  opts = opts || {};
  const SX = window.scrollX, SY = window.scrollY;
  const rootEl = opts.selector ? document.querySelector(opts.selector) : document.querySelector('x-dc');
  const rasters = [];
  let rid = 0;
  const px = v => parseFloat(v) || 0;
  const parseColor = s => {
    if (!s) return null;
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    const a = p.length > 3 ? p[3] : 1;
    if (a === 0) return null;
    return [+(p[0] / 255).toFixed(4), +(p[1] / 255).toFixed(4), +(p[2] / 255).toFixed(4), +a.toFixed(3)];
  };
  const splitTop = s => { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const R = el => { const r = el.getBoundingClientRect(); return { x: r.left + SX, y: r.top + SY, w: r.width, h: r.height }; };
  const round = n => Math.round(n * 100) / 100;

  // rotated elements: measure them unrotated, remember the angle
  const rotated = new Map();
  for (const el of rootEl.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const t = getComputedStyle(el).transform;
    if (t && t !== 'none') {
      const m = t.match(/matrix\(([^)]+)\)/);
      if (m) {
        const [a, b] = m[1].split(',').map(Number);
        const ang = Math.atan2(b, a) * 180 / Math.PI;
        if (Math.abs(ang) > 0.05) { rotated.set(el, ang); el.style.setProperty('rotate', '0deg'); el.style.setProperty('transform', 'none', 'important'); }
      }
    }
  }

  function gradientPaints(bgImage, box) {
    const layers = splitTop(bgImage);
    const paints = [];
    for (const L of layers) {
      let m;
      if ((m = L.match(/^linear-gradient\((.*)\)$/))) {
        const parts = splitTop(m[1]);
        let ang = 180;
        if (/deg$/.test(parts[0]) || /^to /.test(parts[0])) {
          const p0 = parts.shift();
          if (/deg$/.test(p0)) ang = parseFloat(p0);
          else { const map = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }; ang = map[p0] != null ? map[p0] : 180; }
        }
        const th = ang * Math.PI / 180;
        const Lpx = Math.abs(box.w * Math.sin(th)) + Math.abs(box.h * Math.cos(th));
        const stops = parseStops(parts, Lpx);
        if (!stops) return null;
        paints.push({ k: 'L', ang, stops });
      } else if ((m = L.match(/^radial-gradient\((.*)\)$/))) {
        const parts = splitTop(m[1]);
        let rx = box.w / 2, ry = box.h / 2, cx = box.w / 2, cy = box.h / 2;
        if (!/^rgba?\(/.test(parts[0])) {
          const g = parts.shift();
          const [sz, at] = g.split(' at ');
          const nums = (sz || '').trim().split(/\s+/).filter(x => /px|%/.test(x));
          if (nums.length) { rx = /%/.test(nums[0]) ? box.w * parseFloat(nums[0]) / 100 : parseFloat(nums[0]); ry = nums[1] ? (/%/.test(nums[1]) ? box.h * parseFloat(nums[1]) / 100 : parseFloat(nums[1])) : rx; }
          else { rx = Math.hypot(box.w, box.h); ry = rx; }
          if (at) { const q = at.trim().split(/\s+/); const conv = (v, size) => /%/.test(v) ? size * parseFloat(v) / 100 : (v === 'center' ? size / 2 : v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? size : parseFloat(v)); cx = conv(q[0], box.w); cy = conv(q[1] || 'center', box.h); }
        }
        const stops = parseStops(parts, rx);
        if (!stops) return null;
        paints.push({ k: 'RAD', cx: cx / box.w, cy: cy / box.h, rx: rx / box.w, ry: ry / box.h, stops });
      } else return null;
    }
    return paints;
  }
  function parseStops(parts, Lpx) {
    const stops = [];
    for (const p of parts) {
      const m = p.match(/^(rgba?\([^)]*\)|transparent)\s*(.*)$/);
      if (!m) return null;
      let col = m[1] === 'transparent' ? [0, 0, 0, 0] : (parseColor(m[1]) || [0, 0, 0, 0]);
      const pos = (m[2] || '').trim().split(/\s+/).filter(Boolean).map(v => /%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v) / Lpx);
      if (!pos.length) stops.push({ c: col, p: null }); else for (const q of pos) stops.push({ c: col, p: q });
    }
    if (stops[0].p == null) stops[0].p = 0;
    if (stops[stops.length - 1].p == null) stops[stops.length - 1].p = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].p == null) { let j = i; while (stops[j].p == null) j++; const a = stops[i - 1].p, b = stops[j].p; for (let k = i; k < j; k++) stops[k].p = a + (b - a) * (k - i + 1) / (j - i + 1); }
      if (stops[i].p < stops[i - 1].p) stops[i].p = stops[i - 1].p;
    }
    return stops.map(s => ({ c: s.c, p: Math.max(0, Math.min(1, +s.p.toFixed(4))) }));
  }
  function bgPlacement(cs, box) {
    // background-size / position for a single no-repeat layer
    const size = cs.backgroundSize.split(',')[0].trim().split(/\s+/);
    const pos = cs.backgroundPosition.split(',')[0].trim().split(/\s+/);
    const dim = (v, full) => v === 'auto' || v == null ? full : /%$/.test(v) ? full * parseFloat(v) / 100 : parseFloat(v);
    let bw = box.w, bh = box.h;
    if (size[0] !== 'cover' && size[0] !== 'contain') { bw = dim(size[0], box.w); bh = dim(size[1] || 'auto', box.h); }
    const off = (v, free) => /%$/.test(v) ? free * parseFloat(v) / 100 : parseFloat(v) || 0;
    return { x: off(pos[0], box.w - bw), y: off(pos[1] || '50%', box.h - bh), w: bw, h: bh };
  }
  const simpleBg = cs => {
    const rep = cs.backgroundRepeat.split(',')[0].trim();
    const size = cs.backgroundSize.trim();
    const layers = splitTop(cs.backgroundImage).length;
    return { full: (size === 'auto' || size === 'auto auto' || size === '100% 100%') && layers >= 1, norepeat: rep === 'no-repeat', layers };
  };

  function shadows(s) {
    if (!s || s === 'none') return [];
    return splitTop(s).map(sh => {
      const inset = /inset/.test(sh);
      const col = parseColor((sh.match(/rgba?\([^)]*\)/) || [''])[0]);
      const nums = sh.replace(/rgba?\([^)]*\)/, '').replace('inset', '').trim().split(/\s+/).map(parseFloat);
      if (!col) return null;
      return { i: inset ? 1 : 0, c: col, x: nums[0] || 0, y: nums[1] || 0, b: nums[2] || 0, s: nums[3] || 0 };
    }).filter(Boolean);
  }
  function radii(cs, w, h) {
    const one = v => { const parts = v.split(' '); const a = parts[0]; return /%$/.test(a) ? Math.min(w, h) * parseFloat(a) / 100 : parseFloat(a) || 0; };
    const r = [one(cs.borderTopLeftRadius), one(cs.borderTopRightRadius), one(cs.borderBottomRightRadius), one(cs.borderBottomLeftRadius)].map(v => Math.min(v, Math.min(w, h) / 2));
    return r.some(v => v > 0) ? r.map(round) : null;
  }
  function borders(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map(S => ({ w: cs['border' + S + 'Style'] === 'none' ? 0 : px(cs['border' + S + 'Width']), c: parseColor(cs['border' + S + 'Color']), st: cs['border' + S + 'Style'] }));
    if (!sides.some(s => s.w > 0 && s.c)) return null;
    const lead = sides.find(s => s.w > 0 && s.c);
    return { c: lead.c, w: sides.map(s => s.c ? round(s.w) : 0), d: lead.st === 'dashed' ? 1 : lead.st === 'dotted' ? 2 : 0 };
  }
  function weightName(w, italic) {
    w = parseInt(w, 10);
    const names = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
    const n = names[Math.round(w / 100) * 100] || 'Regular';
    return italic ? (n === 'Regular' ? 'Italic' : n + ' Italic') : n;
  }
  function family(ff) {
    const first = ff.split(',')[0].replace(/["']/g, '').trim();
    if (/newsreader/i.test(first)) return 'Newsreader';
    if (/source sans/i.test(first)) return 'Source Sans 3';
    if (/devanagari/i.test(first)) return 'Noto Sans Devanagari';
    return 'Source Sans 3';
  }
  function textStyle(cs) {
    const deco = cs.textDecorationLine;
    return [family(cs.fontFamily), weightName(cs.fontWeight, cs.fontStyle === 'italic'), round(px(cs.fontSize)),
      parseColor(cs.color) || [0, 0, 0, 0],
      cs.letterSpacing === 'normal' ? 0 : round(px(cs.letterSpacing)),
      cs.lineHeight === 'normal' ? 0 : round(px(cs.lineHeight)),
      /underline/.test(deco) ? 'U' : /line-through/.test(deco) ? 'S' : '',
      cs.textTransform === 'uppercase' ? 'UP' : cs.textTransform === 'lowercase' ? 'LO' : cs.textTransform === 'capitalize' ? 'TI' : '',
      /tabular/.test(cs.fontVariantNumeric) ? 1 : 0];
  }
  const isInlineEl = el => {
    if (el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return true;
    if (tag === 'svg' || tag === 'img' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return false;
    const cs = getComputedStyle(el);
    if (cs.display !== 'inline') return false;
    for (const c of el.childNodes) if (c.nodeType === 1 && !isInlineEl(c)) return false;
    return true;
  };

  // Build text from a run of inline nodes; returns {s, segs, lines bbox}
  function textRun(nodes) {
    const out = []; const sty = []; const decoRects = [];
    let prevBottom = null, prevTop = null, pendingSpace = false, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const range = document.createRange();
    function walk(n) {
      if (n.nodeType === 3) {
        const pcs = getComputedStyle(n.parentElement);
        if (pcs.visibility === 'hidden') return;
        const st = JSON.stringify(textStyle(pcs));
        const pre = /pre/.test(pcs.whiteSpace);
        const d = n.data;
        for (let i = 0; i < d.length; i++) {
          const ch = d[i];
          range.setStart(n, i); range.setEnd(n, i + 1);
          const rs = range.getClientRects();
          if (!rs.length || (rs[0].width === 0 && /\s/.test(ch) && !pre)) { if (/\s/.test(ch)) pendingSpace = true; continue; }
          const r = rs[0];
          const top = r.top + SY, bottom = r.bottom + SY;
          if (/\s/.test(ch) && !pre) { pendingSpace = true; continue; }
          let newLine = prevBottom != null && top >= prevBottom - 1 && top > prevTop + 1;
          if (newLine) { out.push('\n'); sty.push(st); pendingSpace = false; }
          else if (pendingSpace && out.length && out[out.length - 1] !== '\n') { out.push(' '); sty.push(st); }
          pendingSpace = false;
          out.push(ch); sty.push(st);
          prevBottom = bottom; prevTop = top;
          minX = Math.min(minX, r.left + SX); maxX = Math.max(maxX, r.right + SX); minY = Math.min(minY, top); maxY = Math.max(maxY, bottom);
        }
      } else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'br') { out.push('\n'); sty.push(sty[sty.length - 1] || JSON.stringify(textStyle(getComputedStyle(n.parentElement)))); prevBottom = null; pendingSpace = false; return; }
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return;
        // inline decorations: backgrounds, borders
        const bgc = parseColor(cs.backgroundColor);
        const hasImg = cs.backgroundImage && cs.backgroundImage !== 'none';
        const bd = borders(cs);
        if (bgc || hasImg || bd) {
          for (const r of n.getClientRects()) {
            const box = { x: r.left + SX, y: r.top + SY, w: r.width, h: r.height };
            if (bgc) decoRects.push({ t: 'R', n: 'highlight', x: box.x, y: box.y, w: box.w, h: box.h, f: [{ k: 'S', c: bgc }], r: radii(cs, box.w, box.h), st: bd });
            if (hasImg) {
              const pl = bgPlacement(cs, box);
              const g = gradientPaints(cs.backgroundImage, pl);
              if (g) decoRects.push({ t: 'R', n: 'highlight', x: box.x + pl.x, y: box.y + pl.y, w: pl.w, h: pl.h, f: g });
            }
            if (!bgc && !hasImg && bd) decoRects.push({ t: 'R', n: 'underline', x: box.x, y: box.y, w: box.w, h: box.h, f: [], st: bd });
          }
        }
        for (const c of n.childNodes) walk(c);
      }
    }
    for (const n of nodes) walk(n);
    while (out.length && /\s/.test(out[out.length - 1])) { out.pop(); sty.pop(); }
    if (!out.length) return null;
    const segs = []; let start = 0;
    for (let i = 1; i <= out.length; i++) if (i === out.length || sty[i] !== sty[start]) { segs.push([start, i, JSON.parse(sty[start])]); start = i; }
    return { s: out.join(''), segs, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, deco: decoRects };
  }

  function svgNode(el, box) {
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((s, i) => {
      const d = dst[i]; const cs = getComputedStyle(s);
      d.removeAttribute('style'); d.removeAttribute('class');
      if (i === 0) return;
      for (const p of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity', 'stroke-opacity', 'opacity']) {
        let v = cs.getPropertyValue(p);
        if (v && v !== 'normal') d.setAttribute(p, v);
      }
      if (cs.display === 'none' || cs.visibility === 'hidden') d.setAttribute('display', 'none');
      const t = cs.transform;
      if (t && t !== 'none') {
        const o = cs.transformOrigin.split(' ').map(parseFloat);
        const m = t.match(/matrix\(([^)]+)\)/);
        if (m) d.setAttribute('transform', `translate(${o[0]} ${o[1]}) matrix(${m[1].split(',').join(' ')}) translate(${-o[0]} ${-o[1]})`);
      }
    });
    const cs = getComputedStyle(el);
    const col = cs.color;
    let html = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, col);
    if (!clone.getAttribute('viewBox')) html = html.replace('<svg', `<svg viewBox="0 0 ${box.w} ${box.h}"`);
    html = html.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '').replace('<svg', `<svg width="${round(box.w)}" height="${round(box.h)}"`);
    return html;
  }

  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    let n = tag;
    if (el.id) n += '#' + el.id;
    const lab = el.getAttribute('aria-label');
    if (lab) n += ' "' + lab.slice(0, 40) + '"';
    else if (el.getAttribute('aria-labelledby')) { const h = document.getElementById(el.getAttribute('aria-labelledby')); if (h) n += ' "' + h.textContent.trim().slice(0, 40) + '"'; }
    else if (el.className && typeof el.className === 'string' && el.className.trim()) n += '.' + el.className.trim().split(/\s+/).join('.');
    return n;
  }
  const STRUCT = new Set(['section', 'header', 'footer', 'nav', 'main', 'article', 'form', 'figure', 'aside', 'ul', 'ol', 'li', 'button', 'a', 'label', 'dl', 'fieldset', 'table', 'tr', 'td', 'th']);

  function visit(el, parentOut) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'template') return;
    let box = R(el);
    // visually-hidden helpers
    if (box.w <= 1.5 && box.h <= 1.5 && (cs.overflow === 'hidden' || cs.clip !== 'auto' || cs.position === 'absolute')) return;
    if (cs.visibility === 'hidden' && !el.querySelector('*')) return;
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) return;

    if (tag === 'svg') {
      if (box.w < 0.5 || box.h < 0.5) return;
      const node = { t: 'V', n: nameOf(el), x: box.x, y: box.y, w: box.w, h: box.h, svg: svgNode(el, box) };
      if (opacity < 1) node.o = opacity;
      if (rotated.has(el)) node.rot = rotated.get(el);
      parentOut.k.push(node); return;
    }
    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      const node = { t: 'I', n: nameOf(el) + (el.alt ? ' "' + el.alt.slice(0, 40) + '"' : ''), x: box.x, y: box.y, w: box.w, h: box.h, src, fit: cs.objectFit === 'contain' ? 'FIT' : 'FILL', r: radii(cs, box.w, box.h) };
      if (opacity < 1) node.o = opacity;
      parentOut.k.push(node); return;
    }

    const bgc = parseColor(cs.backgroundColor);
    const bgImg = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : null;
    const bd = borders(cs);
    const sh = shadows(cs.boxShadow);
    const blur = /blur\(([\d.]+)px\)/.exec(cs.backdropFilter || '');
    const clip = (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
    const rot = rotated.get(el);
    const visual = !!(bgc || bgImg || bd || sh.length || blur);
    const makeFrame = visual || clip || opacity < 1 || rot || STRUCT.has(tag) || el === rootEl || (el.id && tag !== 'span') || ['input', 'select', 'textarea'].includes(tag);
    let out = parentOut;
    if (makeFrame && box.w > 0 && box.h > 0) {
      const node = { t: 'F', n: nameOf(el), x: box.x, y: box.y, w: box.w, h: box.h, k: [] };
      const fills = [];
      if (bgc) fills.push({ k: 'S', c: bgc });
      let rasterized = false;
      if (bgImg) {
        const sb = simpleBg(cs);
        const g = !/repeating|url\(/.test(bgImg) ? gradientPaints(bgImg, box) : null;
        if (g && sb.full) fills.push(...g.reverse());
        else if (g && sb.norepeat && sb.layers === 1) {
          const pl = bgPlacement(cs, box);
          node.k.push({ t: 'R', n: 'background', x: box.x + pl.x, y: box.y + pl.y, w: pl.w, h: pl.h, f: g });
        } else {
          const key = 'r' + (rid++);
          el.setAttribute('data-raster', key);
          rasters.push(key);
          fills.length = 0;
          fills.push({ k: 'IMG', key });
          rasterized = true;
        }
      }
      if (fills.length) node.f = fills;
      if (bd && !rasterized) node.st = bd;
      const r = radii(cs, box.w, box.h); if (r) node.r = r;
      if (sh.length) node.e = sh;
      if (blur) node.bb = parseFloat(blur[1]);
      if (clip) node.clip = 1;
      if (opacity < 1) node.o = opacity;
      if (rot) node.rot = rot;
      parentOut.k.push(node);
      out = node;
      // pseudo elements with boxes
      for (const ps of ['::before', '::after']) {
        const p = getComputedStyle(el, ps);
        if (!p.content || p.content === 'none' || p.display === 'none') continue;
        if (/scaleX\(0\)|matrix\(0,/.test(p.transform)) continue;
        const pb = parseColor(p.backgroundColor), pbd = borders(p);
        if (!pb && !pbd) continue;
        if (p.position !== 'absolute') continue;
        const pad = { x: box.x + px(cs.borderLeftWidth), y: box.y + px(cs.borderTopWidth), w: box.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth), h: box.h - px(cs.borderTopWidth) - px(cs.borderBottomWidth) };
        const L = px(p.left), T = px(p.top), Rr = px(p.right), B = px(p.bottom);
        const w = p.width !== 'auto' ? px(p.width) : pad.w - L - Rr, h = p.height !== 'auto' ? px(p.height) : pad.h - T - B;
        const node2 = { t: 'R', n: 'pseudo' + ps, x: pad.x + L, y: pad.y + T, w, h, f: pb ? [{ k: 'S', c: pb }] : [], st: pbd, r: radii(p, w, h) };
        const po = parseFloat(p.opacity); if (po < 1) node2.o = po;
        out.k.push(node2);
      }
    }

    // form controls: their text is not in the DOM
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      let text = '', pcs = cs;
      if (tag === 'select') text = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
      else if (el.type === 'file') text = '';
      else if (el.value) text = el.value;
      else if (el.placeholder) { text = el.placeholder; pcs = getComputedStyle(el, '::placeholder'); }
      if (text) {
        const st = textStyle(pcs);
        const cb = { x: box.x + px(cs.borderLeftWidth) + px(cs.paddingLeft), y: box.y + px(cs.borderTopWidth) + px(cs.paddingTop), w: box.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight), h: box.h - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom) };
        const lh = st[5] || st[2] * 1.25;
        out.k.push({ t: 'T', n: tag + ' text', x: cb.x, y: cb.y + (cb.h - lh) / 2, w: cb.w - (tag === 'select' ? 18 : 0), s: text, segs: [[0, text.length, st]], al: 'LEFT', lh });
      }
      if (tag === 'select') {
        const cx = box.x + box.w - px(cs.borderRightWidth) - 20, cy = box.y + box.h / 2 - 4;
        out.k.push({ t: 'V', n: 'select chevron', x: cx, y: cy, w: 12, h: 8, svg: `<svg width="12" height="8" viewBox="0 0 12 8"><path d="M1 1.5l5 5 5-5" fill="none" stroke="${cs.color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
      }
      return;
    }

    // children: group inline runs into text blocks
    const kids = Array.from(el.childNodes);
    const allInline = kids.every(c => c.nodeType === 3 || c.nodeType === 8 || isInlineEl(c));
    const cbox = () => ({ x: box.x + px(cs.borderLeftWidth) + px(cs.paddingLeft), y: box.y + px(cs.borderTopWidth) + px(cs.paddingTop), w: box.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight) });
    const alignOf = c => ({ center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' }[c.textAlign] || 'LEFT');
    const flexCenter = (cs.display.includes('flex') && (cs.justifyContent === 'center') && cs.flexDirection.startsWith('row')) || cs.display.includes('grid') && cs.justifyItems === 'center';
    if (allInline) {
      const run = textRun(kids);
      if (run) {
        const c = cbox();
        const lh = (run.segs[0][2][5]) || 0;
        const node = { t: 'T', n: (run.s.slice(0, 48)).replace(/\n/g, ' '), x: c.x, y: c.y, w: c.w, s: run.s, segs: run.segs, al: flexCenter ? 'CENTER' : alignOf(cs) };
        // inline-flex/flex containers that center content vertically
        const vcenter = (cs.display.includes('flex') && cs.alignItems === 'center' && cs.flexDirection.startsWith('row')) || tag === 'button';
        if (vcenter) {
          const ch = box.h - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom);
          const lines = run.s.split('\n').length;
          const textH = lh ? lh * lines : run.bbox.h;
          node.y = c.y + (ch - textH) / 2;
        }
        if (cs.display.includes('flex') && flexCenter) { node.x = c.x; }
        run.deco.forEach(d => out.k.push(d));
        out.k.push(node);
      }
      return;
    }
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const run = textRun(buf); buf = [];
      if (!run) return;
      const lh = run.segs[0][2][5] || run.bbox.h;
      const fontH = run.segs[0][2][2] * 1.25;
      run.deco.forEach(d => out.k.push(d));
      out.k.push({ t: 'T', n: run.s.slice(0, 48).replace(/\n/g, ' '), x: run.bbox.x, y: run.bbox.y - Math.max(0, (lh - fontH) / 2), w: run.bbox.w, s: run.s, segs: run.segs, al: 'LEFT', tight: 1 });
    };
    for (const c of kids) {
      if (c.nodeType === 3 || c.nodeType === 8 || isInlineEl(c)) { if (c.nodeType !== 8) buf.push(c); continue; }
      flush();
      visit(c, out);
    }
    flush();
  }

  const top = { k: [] };
  visit(rootEl, top);
  for (const [el] of rotated) { el.style.removeProperty('transform'); el.style.removeProperty('rotate'); }
  const rb = R(rootEl);
  return { tree: top.k[0], rasters, root: rb, docH: document.documentElement.scrollHeight };
};
