/* Bloco Fácil — leitor de cartão-resposta (OMR) em JavaScript puro.
 * Lê o cartão-resposta da Prova de Bloco (SEDUC-GO): duas tabelas com bordas,
 * N linhas cada, 4 bolinhas (A-D) por linha. Tudo roda no aparelho, sem internet.
 */
(function (root) {
  'use strict';

  function toGray(img) {
    const { data, width: W, height: H } = img;
    const g = new Float32Array(W * H), r = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      r[i] = data[p];
    }
    return { g, r, W, H };
  }

  function adaptiveInv(g, W, H, block, C) {
    // bw = 1 onde pixel < média local - C
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = 0; x < W; x++) {
        s += g[y * W + x];
        I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s;
      }
    }
    const h = block >> 1, out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - h), y1 = Math.min(H, y + h + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - h), x1 = Math.min(W, x + h + 1);
        const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        out[y * W + x] = g[y * W + x] < mean - C ? 1 : 0;
      }
    }
    return out;
  }

  // abertura com linha horizontal/vertical = mantém trechos contínuos >= L
  function openH(bw, W, H, L) {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (bw[y * W + x]) {
          let e = x; while (e < W && bw[y * W + e]) e++;
          if (e - x >= L) for (let k = x; k < e; k++) o[y * W + k] = 1;
          x = e;
        } else x++;
      }
    }
    return o;
  }
  function openV(bw, W, H, L) {
    const o = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        if (bw[y * W + x]) {
          let e = y; while (e < H && bw[e * W + x]) e++;
          if (e - y >= L) for (let k = y; k < e; k++) o[k * W + x] = 1;
          y = e;
        } else y++;
      }
    }
    return o;
  }
  function dilate3(a, W, H) {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!a[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx >= 0 && xx < W) o[yy * W + xx] = 1;
        }
      }
    }
    return o;
  }



  function components(a, W, H) {
    const lab = new Int32Array(W * H), comps = [], stack = new Int32Array(W * H);
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      if (!a[i] || lab[i]) continue;
      n++;
      let sp = 0; stack[sp++] = i; lab[i] = n;
      const c = { n: 0, minX: W, minY: H, maxX: 0, maxY: 0, tl: [0, 0, 1e9], br: [0, 0, -1e9], tr: [0, 0, -1e9], bl: [0, 0, 1e9] };
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p / W) | 0;
        c.n++;
        if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
        const s = x + y, d = x - y;
        if (s < c.tl[2]) c.tl = [x, y, s];
        if (s > c.br[2]) c.br = [x, y, s];
        if (d > c.tr[2]) c.tr = [x, y, d];
        if (d < c.bl[2]) c.bl = [x, y, d];
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            if (a[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
          }
        }
      }
      comps.push(c);
    }
    return comps;
  }

  function polyArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; s += x1 * y2 - x2 * y1; }
    return Math.abs(s) / 2;
  }

  function edgeCoverage(lines, W, H, q) {
    // fração de pontos ao longo das 4 bordas que caem sobre linha detectada
    let hit = 0, tot = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
      const n = 60;
      for (let k = 2; k < n - 2; k++) {
        const x = Math.round(x1 + (x2 - x1) * k / n), y = Math.round(y1 + (y2 - y1) * k / n);
        let ok = false;
        for (let dy = -3; dy <= 3 && !ok; dy++) for (let dx = -3; dx <= 3 && !ok; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && lines[yy * W + xx]) ok = true;
        }
        tot++; if (ok) hit++;
      }
    }
    return hit / tot;
  }

  function findTables(G) {
    const { g, W, H } = G;
    let block = Math.round(Math.min(W, H) / 29) | 1;
    const bw = adaptiveInv(g, W, H, Math.max(block, 15), 10);
    // tolera foto girada (~10°): engrossa na direção perpendicular antes de buscar trechos longos
    const LH = Math.round(W / 25), LV = Math.round(H / 40);
    const hl = openH(bw, W, H, LH);
    const vl = openV(bw, W, H, LV);
    const lines0 = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) lines0[i] = hl[i] | vl[i];
    const lines = dilate3(lines0, W, H);
    const comps = components(lines, W, H);
    const cands = [];
    for (const c of comps) {
      if (c.n < 200) continue;
      const q = [[c.tl[0], c.tl[1]], [c.tr[0], c.tr[1]], [c.br[0], c.br[1]], [c.bl[0], c.bl[1]]];
      const a = polyArea(q);
      if (a < 0.03 * W * H) continue;
      const w = c.maxX - c.minX, h = c.maxY - c.minY;
      if (!(h / w > 0.9 && h / w < 5)) continue;
      const cov = edgeCoverage(lines, W, H, q);
      if (cov < 0.8) continue;
      cands.push({ a, x: c.minX, q, cov });
    }
    // procura o par de tabelas lado a lado, de tamanho parecido
    let sel = [], bestA = 0;
    for (let i = 0; i < cands.length; i++) for (let j = 0; j < cands.length; j++) {
      if (i === j) continue;
      const L = cands[i], R = cands[j];
      if (L.x >= R.x) continue;
      const ratio = Math.min(L.a, R.a) / Math.max(L.a, R.a);
      if (ratio < 0.7) continue;
      const lr = Math.max(L.q[1][0], L.q[2][0]), rl = Math.min(R.q[0][0], R.q[3][0]);
      if (rl < lr - 5) continue; // não pode sobrepor
      const topDiff = Math.abs(L.q[0][1] - R.q[0][1]) / Math.sqrt(L.a);
      if (topDiff > 0.35) continue;
      if (L.a + R.a > bestA) { bestA = L.a + R.a; sel = [L, R]; }
    }
    if (!sel.length) {
      const one = cands.filter(c => c.a < 0.45 * W * H).sort((u, v) => v.a - u.a)[0];
      if (one) sel = [one];
    }
    return sel.map(s => s.q);
  }

  // homografia: resolve H que leva src->dst (4 pontos)
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    // eliminação gaussiana
    const n = 8;
    for (let i = 0; i < n; i++) {
      let m = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
      [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function warp(G, quad, TW, TH) {
    const { g, r, W, H } = G;
    const Hm = homography([[0, 0], [TW, 0], [TW, TH], [0, TH]], quad);
    const og = new Float32Array(TW * TH), or = new Float32Array(TW * TH);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const d = Hm[6] * x + Hm[7] * y + 1;
      const sx = (Hm[0] * x + Hm[1] * y + Hm[2]) / d, sy = (Hm[3] * x + Hm[4] * y + Hm[5]) / d;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) { og[y * TW + x] = 255; or[y * TW + x] = 255; continue; }
      const fx = sx - x0, fy = sy - y0, i = y0 * W + x0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      og[y * TW + x] = g[i] * w00 + g[i + 1] * w10 + g[i + W] * w01 + g[i + W + 1] * w11;
      or[y * TW + x] = r[i] * w00 + r[i + 1] * w10 + r[i + W] * w01 + r[i + W + 1] * w11;
    }
    return { g: og, r: or, W: TW, H: TH };
  }

  function peaks(p, minGap, thr) {
    const idx = [];
    let i = 0;
    while (i < p.length) {
      if (p[i] > thr) {
        let j = i; while (j < p.length && p[j] > thr) j++;
        const c = (i + j - 1) >> 1;
        if (!idx.length || c - idx[idx.length - 1] >= minGap) idx.push(c);
        i = j;
      } else i++;
    }
    return idx;
  }

  function readTable(G, quad) {
    const TW = 600, TH = 1400;
    const w = warp(G, quad, TW, TH);
    const bw = adaptiveInv(w.g, TW, TH, 25, 8);
    const hl = openH(bw, TW, TH, TW / 3), vl = openV(bw, TW, TH, TH / 6);
    const rp = new Float32Array(TH), cp = new Float32Array(TW);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { rp[y] += hl[y * TW + x]; cp[x] += vl[y * TW + x]; }
    let rows = peaks(rp, 25, TW * 0.3), cols = peaks(cp, 25, TH * 0.4);
    if (!rows.length || !cols.length) return null;
    if (rows[0] > 20) rows.unshift(0);
    if (rows[rows.length - 1] < TH - 20) rows.push(TH - 1);
    if (cols[0] > 20) cols.unshift(0);
    if (cols[cols.length - 1] < TW - 20) cols.push(TW - 1);
    let bands = [];
    for (let i = 0; i + 1 < rows.length; i++) bands.push([rows[i], rows[i + 1]]);
    let body = bands.slice(1);
    const hs = body.map(b => b[1] - b[0]).sort((a, b) => a - b);
    const med = hs[hs.length >> 1] || 0;
    body = body.filter(b => b[1] - b[0] > 0.6 * med);
    if (body.some(b => b[1] - b[0] > 1.5 * med)) return null;
    const cx = [];
    for (let i = 0; i + 1 < cols.length; i++) cx.push([cols[i], cols[i + 1]]);
    if (cx.length < 5) return null;
    const bub = cx.slice(1, 5);
    const red = w.r, res = [];
    for (const [y0, y1] of body) {
      const vals = [];
      for (const [x0, x1] of bub) {
        const r = 0.30 * Math.min(x1 - x0, y1 - y0);
        const X0 = Math.round(x0 + 4), X1 = Math.round(x1 - 3), Y0 = Math.round(y0 + 4), Y1 = Math.round(y1 - 3);
        const cw = X1 - X0, ch = Y1 - Y0, R = Math.min(cw, ch) / 2;
        let si = 0, ni = 0; const ring = [];
        for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
          const d = Math.hypot(y - Y0 - ch / 2, x - X0 - cw / 2), v = red[y * TW + x];
          if (d <= r) { si += v; ni++; }
          if (d >= 0.95 * R) ring.push(v);
        }
        ring.sort((a, b) => a - b);
        const bg = ring.length ? ring[Math.floor(0.7 * (ring.length - 1))] : 255;
        const inner = ni ? si / ni : 255;
        vals.push(Math.max(0, (bg - inner) / Math.max(bg, 1)));
      }
      res.push(vals);
    }
    return { scores: res, rows: body.length, cols: cx.length };
  }

  function decide(d) {
    const s = [0, 1, 2, 3].sort((i, j) => d[j] - d[i]);
    const a = d[s[0]], b = d[s[1]];
    const base = [...d].sort((x, y) => x - y)[1];
    if (a - base < 0.12) return { r: '-', conf: 1 - (a - base) / 0.12 };
    if (b - base > 0.5 * (a - base)) return { r: '*', conf: 0 };
    return { r: 'ABCD'[s[0]], conf: Math.min(1, (a - b) / 0.25) };
  }

  function scaleDown(img, maxDim) {
    const { width: W, height: H } = img;
    const k = Math.min(1, maxDim / Math.max(W, H));
    if (k === 1) return img;
    const nw = Math.round(W * k), nh = Math.round(H * k), out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      // média de caixa
      const sx0 = Math.floor(x / k), sx1 = Math.min(W, Math.floor((x + 1) / k)), sy0 = Math.floor(y / k), sy1 = Math.min(H, Math.floor((y + 1) / k));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
        const p = (yy * W + xx) * 4; r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++;
      }
      const q = (y * nw + x) * 4; out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = 255;
    }
    return { data: out, width: nw, height: nh };
  }



  function rotate(G, deg) {
    if (Math.abs(deg) < 0.3) return G;
    const { g, r, W, H } = G, t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const og = new Float32Array(W * H), or = new Float32Array(W * H), cx = W / 2, cy = H / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      // destino (x,y) vem da origem girada por +deg
      const dx = x - cx, dy = y - cy;
      const sx = c * dx - s * dy + cx, sy = s * dx + c * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), o = y * W + x;
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) { og[o] = 128; or[o] = 128; continue; }
      const fx = sx - x0, fy = sy - y0, i = y0 * W + x0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      og[o] = g[i] * w00 + g[i + 1] * w10 + g[i + W] * w01 + g[i + W + 1] * w11;
      or[o] = r[i] * w00 + r[i + 1] * w10 + r[i + W] * w01 + r[i + W + 1] * w11;
    }
    return { g: og, r: or, W, H };
  }

  function attempt(G, expected) {
    const quads = findTables(G);
    if (quads.length < 1) return { ok: false, erro: 'Não encontrei as tabelas do cartão. Enquadre o cartão inteiro, com boa luz.' };
    const answers = [], conf = [], tables = [];
    for (const q of quads) {
      const t = readTable(G, q);
      if (!t) return { ok: false, erro: 'Não consegui ler as linhas da tabela. Tente uma foto mais reta.' };
      tables.push({ quad: q, rows: t.rows });
      for (const d of t.scores) { const k = decide(d); answers.push(k.r); conf.push(k.conf); }
    }
    if (tables.length === 2 && tables[0].rows !== tables[1].rows)
      return { ok: false, erro: 'As duas colunas do cartão saíram com tamanhos diferentes. Tire a foto de novo, mais de frente.' };
    if (expected && answers.length !== expected)
      return { ok: false, erro: 'Li ' + answers.length + ' questões, mas a prova tem ' + expected + '. Enquadre o cartão inteiro.' };
    const vazias = answers.filter(a => a === '-' || a === '*').length;
    if (vazias > answers.length * 0.3)
      return { ok: false, erro: 'Muitas questões sem leitura clara. Tire a foto com mais luz e mais de frente.' };
    return { ok: true, answers, conf, tables };
  }

  /** Lê um cartão. img = {data: RGBA, width, height}; expected = nº de questões (opcional). */
  function readCard(img, expected) {
    const small = scaleDown(img, 1600);
    const G0 = toGray(small);
    let first = null;
    for (const ang of [0, -3, 3, -6, 6, -9, 9, -12, 12]) {
      const r = attempt(ang ? rotate(G0, ang) : G0, expected);
      if (r.ok) { r.angle = ang; r.size = [small.width, small.height]; return r; }
      if (!first) first = r;
    }
    return first;
  }

  root.BlocoOMR = { readCard };
  if (typeof module !== 'undefined') module.exports = root.BlocoOMR;
})(typeof window !== 'undefined' ? window : globalThis);
