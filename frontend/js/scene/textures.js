/**
 * 程序化材质库
 * ============
 * 全部用 Canvas 现场生成，不依赖任何外部贴图文件 —— 项目要能离线跑，
 * 也避免"网上下载的草地贴图"那种一眼假的重复纹理。
 *
 * 每个材质都尽量给出三张图：
 *   map       颜色（albedo）
 *   normal    法线（由高度场差分得到）
 *   roughness 粗糙度差异（用同一张图不同解读，比纯常数真实得多）
 *
 * 关键实现约定：
 *   · 噪声全部用确定性随机（mulberry32 固定种子），每次刷新画面一致；
 *   · 尺度按"真实尺寸"设计：草坪贴图代表 6×6 m，方砖代表 4×4 块，
 *     在 3D 里按米设置 repeat 就能保证纹理密度一致，不会出现
 *     "近处像地毯、远处像马赛克"。
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTex(cv, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** 叠一层柔和的斑块噪声（模拟草色不匀、土面结皮） */
function blotches(ctx, size, { count = 140, rMin = 6, rMax = 34, colors = [], alpha = 0.12, seed = 1 }) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = r() * size, y = r() * size;
    const rr = rMin + r() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    const col = colors[(r() * colors.length) | 0] || '#ffffff';
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha * (0.5 + r());
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** 细颗粒（水泥、沥青、土面的"砂感"） */
function grain(ctx, size, amount = 10, seed = 7) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

/** 由灰度高度场生成法线图 */
function normalFrom(cv, strength = 2.0) {
  const size = cv.width;
  const src = cv.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const d = img.data;
  const h = (x, y) => {
    const xi = (x + size) % size, yi = (y + size) % size;
    const i = (yi * size + xi) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const nx = -dx, ny = -dy, nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      d[i] = (nx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      d[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* 各材质生成器                                                        */
/* ------------------------------------------------------------------ */

/**
 * 修剪草坪。代表 6×6 m。
 * 有修剪条纹（割草机来回压出的浅色带），这是校园绿地最明显的特征，
 * 少了它草坪就会像一块绿色塑料板。
 */
function makeLawn() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#5f7a44';
  c.fillRect(0, 0, S, S);

  const band = S / 8;
  for (let i = 0; i < 8; i++) {
    c.globalAlpha = i % 2 ? 0.10 : 0.0;
    c.fillStyle = '#8ea465';
    c.fillRect(0, i * band, S, band);
  }
  c.globalAlpha = 1;

  blotches(c, S, { count: 240, rMin: 10, rMax: 60, alpha: 0.13, seed: 11,
    colors: ['#6d8a4c', '#546d3c', '#7d9455', '#4a6338'] });
  blotches(c, S, { count: 160, rMin: 3, rMax: 12, alpha: 0.10, seed: 12,
    colors: ['#8fa565', '#3f5730'] });

  const r = rng(21);
  for (let i = 0; i < 5200; i++) {
    const x = r() * S, y = r() * S;
    c.strokeStyle = r() > 0.5 ? 'rgba(126,146,86,0.5)' : 'rgba(58,80,42,0.45)';
    c.lineWidth = 0.8 + r() * 0.7;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (r() - 0.5) * 2.2, y - 2.2 - r() * 3.2);
    c.stroke();
  }
  grain(c, S, 9, 5);
  return cv;
}

/** 耕作土。代表 4×4 m，带犁沟与土块。 */
function makeSoil() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#6b5540';
  c.fillRect(0, 0, S, S);
  blotches(c, S, { count: 200, rMin: 8, rMax: 46, alpha: 0.16, seed: 31,
    colors: ['#7a6249', '#5a4534', '#86694c', '#4e3b2c'] });
  const r = rng(32);
  for (let i = 0; i < 26; i++) {
    const y = (i / 26) * S + r() * 5;
    c.strokeStyle = `rgba(${(48 + r() * 30) | 0}, ${(38 + r() * 22) | 0}, ${(28 + r() * 16) | 0}, 0.5)`;
    c.lineWidth = 2 + r() * 3;
    c.beginPath();
    c.moveTo(0, y);
    for (let x = 0; x <= S; x += 16) c.lineTo(x, y + Math.sin(x * 0.05 + i) * 2.2);
    c.stroke();
  }
  for (let i = 0; i < 900; i++) {
    const x = r() * S, y = r() * S, s = 1 + r() * 3;
    c.fillStyle = r() > 0.5 ? 'rgba(140,116,88,0.55)' : 'rgba(70,54,40,0.5)';
    c.beginPath(); c.arc(x, y, s, 0, Math.PI * 2); c.fill();
  }
  grain(c, S, 14, 6);
  return cv;
}

/** 沥青路。代表 8×8 m。 */
function makeAsphalt() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#6d7074';
  c.fillRect(0, 0, S, S);
  blotches(c, S, { count: 160, rMin: 20, rMax: 90, alpha: 0.09, seed: 41,
    colors: ['#7a7d81', '#5f6266', '#84878a'] });
  const r = rng(42);
  for (let i = 0; i < 9000; i++) {
    const x = r() * S, y = r() * S;
    const v = 90 + r() * 80;
    c.fillStyle = `rgba(${v | 0},${v | 0},${(v + 3) | 0},${0.25 + r() * 0.4})`;
    c.fillRect(x, y, 1 + r() * 1.6, 1 + r() * 1.6);
  }
  for (let i = 0; i < 5; i++) {
    c.strokeStyle = 'rgba(45,46,48,0.45)';
    c.lineWidth = 1.2 + r() * 1.4;
    c.beginPath();
    let x = r() * S, y = 0;
    c.moveTo(x, y);
    while (y < S) { x += (r() - 0.5) * 26; y += 18; c.lineTo(x, y); }
    c.stroke();
  }
  grain(c, S, 12, 8);
  return cv;
}

/**
 * 灰色方砖铺装。代表 4×4 块（每块 1.15 m）。
 * 俯拍实景图里西侧那条步道就是这种板：大块、浅灰、缝里长草。
 */
function makePaver() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#8f938f';
  c.fillRect(0, 0, S, S);

  const n = 4, gap = 5, cell = S / n;
  const r = rng(51);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const x = ix * cell + gap / 2, y = iy * cell + gap / 2;
      const w = cell - gap;
      const base = 150 + (r() - 0.5) * 26;
      c.fillStyle = `rgb(${base | 0},${(base + 2) | 0},${(base - 4) | 0})`;
      c.fillRect(x, y, w, w);

      for (let k = 0; k < 5; k++) {
        const sx = x + r() * w, sy = y + r() * w, sr = 6 + r() * 22;
        const g = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
        g.addColorStop(0, `rgba(110,108,100,${0.10 + r() * 0.10})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.beginPath(); c.arc(sx, sy, sr, 0, Math.PI * 2); c.fill();
      }
      c.strokeStyle = 'rgba(105,105,100,0.35)';
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, w - 1, w - 1);
    }
  }
  for (let i = 0; i < 240; i++) {
    const onV = r() > 0.5;
    const x = onV ? Math.round(r() * n) * cell : r() * S;
    const y = onV ? r() * S : Math.round(r() * n) * cell;
    c.fillStyle = `rgba(${(70 + r() * 30) | 0},${(92 + r() * 30) | 0},${(50 + r() * 20) | 0},${0.3 + r() * 0.4})`;
    c.fillRect(x - 1, y - 1, 2 + r() * 2, 2 + r() * 2);
  }
  grain(c, S, 10, 9);
  return cv;
}

/** 混凝土 / 水泥地坪。代表 6×6 m。 */
function makeConcrete() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#b4b3ac';
  c.fillRect(0, 0, S, S);
  blotches(c, S, { count: 190, rMin: 12, rMax: 70, alpha: 0.10, seed: 61,
    colors: ['#c2c1ba', '#a3a29b', '#cbcac2', '#8e8d87'] });
  c.strokeStyle = 'rgba(120,120,114,0.55)';
  c.lineWidth = 2;
  for (let i = 1; i < 3; i++) {
    c.beginPath(); c.moveTo((i * S) / 3, 0); c.lineTo((i * S) / 3, S); c.stroke();
    c.beginPath(); c.moveTo(0, (i * S) / 3); c.lineTo(S, (i * S) / 3); c.stroke();
  }
  grain(c, S, 12, 10);
  return cv;
}

/**
 * 浆砌石护岸。代表 2×2 m。
 * 实景里湖岸一圈浅灰色块石，块径 20~40 cm，水泥勾缝 —— 俯视时是
 * 一圈明显比草地亮的石带，这是辨认琴湖的第一个特征。
 */
function makeRiprap() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#6f6f68';
  c.fillRect(0, 0, S, S);

  const r = rng(71);
  const rows = 7, cols = 7;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const cx = (ix + 0.5) * (S / cols) + (r() - 0.5) * (S / cols) * 0.42;
      const cy = (iy + 0.5) * (S / rows) + (r() - 0.5) * (S / rows) * 0.42;
      const rx = (S / cols) * (0.34 + r() * 0.13);
      const ry = (S / rows) * (0.32 + r() * 0.13);
      const base = 132 + (r() - 0.5) * 44;
      c.beginPath();
      const K = 6 + ((r() * 3) | 0);
      for (let k = 0; k < K; k++) {
        const a = (k / K) * Math.PI * 2 + r() * 0.35;
        const px = cx + Math.cos(a) * rx * (0.82 + r() * 0.34);
        const py = cy + Math.sin(a) * ry * (0.82 + r() * 0.34);
        if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
      c.fillStyle = `rgb(${base | 0},${(base - 2) | 0},${(base - 8) | 0})`;
      c.fill();
      c.globalAlpha = 0.25;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.ellipse(cx - rx * 0.2, cy - ry * 0.3, rx * 0.5, ry * 0.4, 0, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    }
  }
  grain(c, S, 22, 11);
  return cv;
}

/** 白色涂料砖墙（看护房、公厕）。代表 3×3 m。 */
function makeBrick() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#ddd7ca';
  c.fillRect(0, 0, S, S);
  const rows = 12, h = S / rows, w = S / 6;
  const r = rng(81);
  for (let iy = 0; iy < rows; iy++) {
    const off = (iy % 2) * (w / 2);
    for (let ix = -1; ix < 7; ix++) {
      const x = ix * w + off, y = iy * h;
      const t = 226 + (r() - 0.5) * 22;
      c.fillStyle = `rgb(${t | 0},${(t - 4) | 0},${(t - 14) | 0})`;
      c.fillRect(x + 1.5, y + 1.5, w - 3, h - 3);
    }
    c.fillStyle = 'rgba(160,155,145,0.5)';
    c.fillRect(0, iy * h, S, 1.4);
  }
  blotches(c, S, { count: 60, rMin: 10, rMax: 60, alpha: 0.07, seed: 82,
    colors: ['#b9b3a6', '#efeae0'] });
  grain(c, S, 8, 12);
  return cv;
}

/** 镀锌钢（骨架、檩条）表面斑驳。 */
function makeGalv() {
  const S = 256;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#b9bec0';
  c.fillRect(0, 0, S, S);
  const r = rng(91);
  for (let i = 0; i < 900; i++) {
    const x = r() * S, y = r() * S;
    c.fillStyle = r() > 0.5 ? 'rgba(210,214,216,0.35)' : 'rgba(140,146,150,0.3)';
    c.fillRect(x, y, 1 + r() * 8, 1);
  }
  for (let i = 0; i < 12; i++) {
    c.fillStyle = 'rgba(120,124,126,0.18)';
    c.fillRect(0, r() * S, S, 1 + r() * 2);
  }
  grain(c, S, 7, 13);
  return cv;
}

/** 薄膜：乳白半透，带纵向水痕与褶皱。 */
function makeFilm() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#eef4f4';
  c.fillRect(0, 0, S, S);
  const r = rng(101);
  for (let i = 0; i < 90; i++) {
    const x = r() * S;
    c.strokeStyle = `rgba(200,214,214,${0.05 + r() * 0.08})`;
    c.lineWidth = 1 + r() * 5;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x + (r() - 0.5) * 14, S);
    c.stroke();
  }
  for (let i = 0; i < 40; i++) {
    const y = r() * S;
    c.strokeStyle = `rgba(255,255,255,${0.05 + r() * 0.09})`;
    c.lineWidth = 2 + r() * 8;
    c.beginPath();
    c.moveTo(0, y);
    c.bezierCurveTo(S * 0.3, y + (r() - 0.5) * 40, S * 0.7, y + (r() - 0.5) * 40, S, y);
    c.stroke();
  }
  blotches(c, S, { count: 70, rMin: 20, rMax: 90, alpha: 0.05, seed: 102,
    colors: ['#dbe6e6', '#ffffff'] });
  return cv;
}

/**
 * 遮阳网/铁丝网的**遮罩图**。
 *
 * 这里有个坑必须记一笔：three 的 alphaMap 取的是贴图的**绿通道**，
 * 不是 alpha 通道。之前画成"黑底 + 挖透明孔"，绿通道全 0，
 * 结果遮阳网和围栏网面整片消失（只剩杆件）。
 * 正确做法是画成不透明的灰度图：网线处白、网眼处黑。
 */
function makeShadeNet() {
  const S = 256;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, S, S);
  c.fillStyle = '#000000';
  const n = 32, cell = S / n;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      c.beginPath();
      c.arc((ix + 0.5) * cell, (iy + 0.5) * cell, cell * 0.34, 0, Math.PI * 2);
      c.fill();
    }
  }
  // 经纬线再压一点，让网面不至于像圆点阵列
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.lineWidth = 1;
  for (let i = 0; i <= n; i++) {
    c.beginPath(); c.moveTo(i * cell, 0); c.lineTo(i * cell, S); c.stroke();
    c.beginPath(); c.moveTo(0, i * cell); c.lineTo(S, i * cell); c.stroke();
  }
  return cv;
}

/** 遮阳网的细织纹（用在 map 上，只做质感，不做镂空） */
function makeNetWeave() {
  const S = 128;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#2a2d26';
  c.fillRect(0, 0, S, S);
  c.strokeStyle = 'rgba(70,74,64,0.55)';
  c.lineWidth = 1;
  for (let i = 0; i < S; i += 4) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i, S); c.stroke();
    c.beginPath(); c.moveTo(0, i); c.lineTo(S, i); c.stroke();
  }
  c.strokeStyle = 'rgba(14,16,12,0.5)';
  for (let i = 2; i < S; i += 4) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i, S); c.stroke();
    c.beginPath(); c.moveTo(0, i); c.lineTo(S, i); c.stroke();
  }
  return cv;
}

/** 水面法线：多尺度波纹，两组不同方向叠加，避免规则的"搓板纹" */
function makeWaterNormal() {
  const S = 512;
  const cv = canvas(S);
  const c = cv.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, S, S);
  const r = rng(111);
  for (let i = 0; i < 900; i++) {
    const x = r() * S, y = r() * S;
    const w = 8 + r() * 60, h = 2 + r() * 6;
    const a = 0.02 + r() * 0.05;
    c.fillStyle = r() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    c.beginPath();
    c.ellipse(x, y, w, h, (r() - 0.5) * 0.5, 0, Math.PI * 2);
    c.fill();
  }
  return normalFrom(cv, 1.1);
}

/* ------------------------------------------------------------------ */
/* 缓存与对外接口                                                      */
/* ------------------------------------------------------------------ */
let _cache = null;

export function getTextures() {
  if (_cache) return _cache;

  const lawn = makeLawn();
  const soil = makeSoil();
  const asphalt = makeAsphalt();
  const paver = makePaver();
  const concrete = makeConcrete();
  const riprap = makeRiprap();
  const brick = makeBrick();
  const galv = makeGalv();
  const film = makeFilm();
  const net = makeShadeNet();
  const waterN = makeWaterNormal();

  _cache = {
    lawn: toTex(lawn),
    soil: toTex(soil),
    asphalt: toTex(asphalt),
    paver: toTex(paver),
    concrete: toTex(concrete),
    riprap: toTex(riprap),
    brick: toTex(brick),
    galv: toTex(galv),
    film: toTex(film),
    lawnN: toTex(normalFrom(lawn, 1.6), { srgb: false }),
    soilN: toTex(normalFrom(soil, 2.4), { srgb: false }),
    asphaltN: toTex(normalFrom(asphalt, 1.2), { srgb: false }),
    paverN: toTex(normalFrom(paver, 1.8), { srgb: false }),
    concreteN: toTex(normalFrom(concrete, 0.9), { srgb: false }),
    riprapN: toTex(normalFrom(riprap, 3.2), { srgb: false }),
    brickN: toTex(normalFrom(brick, 1.6), { srgb: false }),
    waterN: toTex(waterN, { srgb: false }),
    netAlpha: toTex(net),
    netWeave: toTex(makeNetWeave()),
  };
  return _cache;
}

/**
 * 克隆一份贴图并设置重复次数。
 * 同一张 canvas 贴图在不同物体上需要不同 repeat，直接改原贴图会互相污染，
 * 所以这里统一 clone。
 */
export function tile(tex, rx, ry = rx) {
  const t = tex.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

/* 兼容旧接口 */
export const grassTexture = () => getTextures().lawn;
export const roadTexture = () => getTextures().asphalt;
export const paverTexture = () => getTextures().paver;
export const riprapTexture = () => getTextures().riprap;
export const brickTexture = () => getTextures().brick;
export const shadeNetTexture = () => getTextures().netAlpha;
export const waterNormalTexture = () => getTextures().waterN;
export const filmTexture = () => getTextures().film;
export const soilTexture = () => getTextures().soil;
export { canvas as makeCanvas, rng as makeRng, normalFrom as buildNormal };
