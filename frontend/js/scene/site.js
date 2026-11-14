/**
 * 场景主体：加载用户建好的 glb 模型并做工程化处理
 * ================================================
 * 模型来自《场景图及建模要求/建模/qinhu_base_digital_twin.glb》，由用户在
 * Blender 流程里建好，整体位置与分区关系是对的。这个模块的职责不是重建，
 * 而是**把美术模型变成可运营的孪生场景**：
 *
 *   1. 材质工程化：把 trimesh 导出的"能用但不像"的材质，调成带环境反射、
 *      带半透薄膜、带真实水面的 PBR 材质；
 *   2. 性能优化：按（区域 × 材质）合并静态几何，把 900 多次 draw call 压到
 *      几十次；阴影只给承重构件，不给 60 万面的室内作物；
 *   3. 结构化索引：按模型里的中文命名规律（排风机叶片 / 传感器状态灯 /
 *      内部作物行 / 拱形棚膜）建立可驱动对象表，供数据层绑定；
 *   4. 提供孪生 API：setRegion() 一次性下发某区域的风机转速、棚膜状态、
 *      作物色相、状态灯颜色。
 *
 * 模型自身的命名就是接口约定，这一点写在 docs/技术路线与功能说明.md 里。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { makeWaterMaterial } from './water.js';
import { getTextures, tile } from './textures.js';

const MODEL_URL = '/assets/model/qinhu_base_digital_twin_realistic.glb';
const MANIFEST_URL = '/assets/model/scene_manifest.json';

/** 区域组名 → 业务 id */
const REGION_MAP = {
  '00_基地环境': 'base',
  '01_入口湖景与桥梁': 'lake',
  '02_园艺植物生产实训中心': 'hort',
  '03_芍药种植资源创新基地': 'peony',
  '04_数智农业实践研学中心': 'smart',
};

/** 这些构件要保留独立对象（要做动画、要高亮、要编号检索） */
const KEEP_SEPARATE = /叶片|电机轴|状态灯|内部作物行|拱形棚膜|透光板|传感器|控制柜|水肥|储罐|标牌|门柱|门头/;

/* ------------------------------------------------------------------ */
/* 几何规范化：mergeGeometries 要求属性集合完全一致                     */
/* ------------------------------------------------------------------ */
function prepGeo(g) {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  const n = geo.attributes.position.count;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  geo.deleteAttribute('uv2');
  geo.deleteAttribute('color');
  geo.deleteAttribute('tangent');
  return geo;
}

/* ------------------------------------------------------------------ */
/* 材质调优                                                            */
/* ------------------------------------------------------------------ */
function tuneMaterials(root, env) {
  const seen = new Set();
  const info = { film: [], water: null, glass: [] };

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      const name = m.name || '';

      // 所有标准材质都吃环境反射，否则金属和膜都是一片死灰
      // 1.0 的环境反射强度，配上细金属杆和低粗糙度膜面，会在真实 GPU 上
      // 打出"一闪而过"的极亮小点（镜面走样）。0.7 已经足够表现金属感。
      if ('envMapIntensity' in m) m.envMapIntensity = 0.7;

      if (name === 'Pond water') {
        info.water = m;
        continue;
      }

      if (name === 'Translucent greenhouse film') {
        // 农膜：半透、双面。
        // roughness 别给太低：膜面是漫反射为主，0.38 会让太阳在膜上打出一个
        // 针尖大的高光，薄薄一片膜反而比玻璃还亮，远看就是闪白点。
        m.transparent = true;
        m.opacity = 0.62;
        m.roughness = 0.62;
        m.metalness = 0.0;
        m.side = THREE.DoubleSide;
        m.depthWrite = false;
        m.envMapIntensity = 0.55;
        // 棚内几乎收不到天光，透过膜看进去是一团黑。给膜加一点自发光，
        // 相当于补上棚内的漫射光，端墙才不会像挂着黑布。
        if ('emissive' in m) {
          m.emissive = new THREE.Color('#5a6f57');
          m.emissiveIntensity = 0.42;
        }
        info.film.push(m);
      } else if (name === 'Greenhouse polycarbonate wall' || name.includes('透光板')) {
        m.transparent = true;
        m.opacity = 0.42;
        m.roughness = 0.34;
        m.metalness = 0.1;
        m.side = THREE.DoubleSide;
        m.depthWrite = false;
        info.glass.push(m);
      } else if (name === 'Turf • natural grass') {
        m.roughness = 0.96;
        m.metalness = 0;
        // 模型自带的草地贴图偏灰，稍微推一点饱和度，让场地比周边更"活"
        if (m.color) m.color.multiplyScalar(1.0);
      } else if (name === 'Asphalt path' || name === 'Weathered concrete') {
        m.roughness = 0.92;
      } else if (name === 'Galvanized steel' || name.includes('steel')) {
        // 温室骨架是成百上千根细杆，roughness 给到 0.45 时，每根杆上的
        // 太阳高光只有一两个像素宽，视角一动就成片地"闪"。0.58 仍然有金属感。
        m.roughness = Math.max(m.roughness ?? 0.5, 0.58);
        m.metalness = Math.min(Math.max(m.metalness ?? 0.5, 0.5), 0.55);
      } else if (name === 'Natural lake retaining stone') {
        m.roughness = 0.95;
        m.metalness = 0;
      } else if (name.startsWith('Foliage') || name.includes('Peony petals')) {
        m.roughness = 0.82;
        m.metalness = 0;
        m.side = THREE.DoubleSide;
      }
      m.needsUpdate = true;
    }
  });

  return info;
}

/* ------------------------------------------------------------------ */
/* 阴影策略                                                            */
/* ------------------------------------------------------------------ */
function setupShadows(root) {
  const CAST = /钢结构拱架|纵向檩条|排风机|电机轴|门柱|门头|墙体|墙板|屋面|屋顶|桥|木栈|栏杆|立柱|支架|灯杆|标牌|Foliage|树|灌木|柱/;
  const SKIP = /内部作物行|拱形棚膜|透光板|防护网|驳岸块|地面|Turf|Asphalt|水/;

  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || '';
    const matName = o.material?.name || '';
    const skip = SKIP.test(name) || SKIP.test(matName);
    o.castShadow = !skip && (CAST.test(name) || CAST.test(matName));
    o.receiveShadow = !/内部作物行/.test(name);
  });
}

/* ------------------------------------------------------------------ */
/* 桥：两端接到岸上                                                    */
/* ------------------------------------------------------------------ */
/**
 * 模型里的木栈桥由 53 块 `木栈桥桥面板` 拼成，x 只铺到 91.9，而湖面东边界在
 * 96.8 —— 东端整整悬空 4.9 m，人站在门口一眼就能看出来"桥没接上岸"。
 *
 * 这里按桥面实际数据补两段引桥：引桥跨过驳岸、伸进外侧实地，顶面从桥端高度
 * 平滑降到外侧大地面 surround_ground 的实际高度（GROUND_Y = 模型最低处 + 0.55），
 * 宽厚与桥板一致，材质沿用桥板材质，栏杆按同样的间距补上。
 *
 * 二次修复要点：旧版把终点高度硬编码成 0.34（以为是驳岸压顶），引桥停在水边，
 * 而外侧实际地面在 -0.1，末端仍有 0.44 m 落差和水平缝隙，看起来还是断头桥。
 * 现在终点高度按 surround_ground 同口径计算，终点位置跨过驳岸再伸进实地 4.2 m。
 * 补出来的几何和桥板同区域同材质，会被一起合进同一个网格，不增加 draw call。
 */
function weldBridge(root, matInfo) {
  const decks = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name || '';
    if (/栈桥/.test(n) && /板/.test(n)) decks.push(o);
  });
  if (!decks.length) return null;

  let deckBox = null;
  for (const d of decks) {
    const bb = new THREE.Box3().setFromObject(d);
    deckBox = deckBox ? deckBox.union(bb) : bb.clone();
  }

  let waterBox = null;
  root.traverse((o) => {
    if (!o.isMesh || o.material !== matInfo.water) return;
    const bb = new THREE.Box3().setFromObject(o);
    waterBox = waterBox ? waterBox.union(bb) : bb.clone();
  });
  if (!waterBox || !deckBox) return null;

  const mat = decks[0].material;
  const parent = decks[0].parent || root;
  const W = deckBox.max.z - deckBox.min.z;
  const cz = (deckBox.min.z + deckBox.max.z) / 2;
  const TH = 0.17;

  // 端部板顶面高度（桥是微拱的，两端比中间低，必须按端部取）
  let wMesh = null, eMesh = null, wx = Infinity, ex = -Infinity;
  for (const d of decks) {
    const bb = new THREE.Box3().setFromObject(d);
    const c = (bb.min.x + bb.max.x) / 2;
    if (c < wx) { wx = c; wMesh = d; }
    if (c > ex) { ex = c; eMesh = d; }
  }
  const yW = new THREE.Box3().setFromObject(wMesh).max.y;
  const yE = new THREE.Box3().setFromObject(eMesh).max.y;

  /* 外侧大地面 surround_ground 在本函数之后才创建（见 loadSite 步骤 6.5），
   * 其高度口径恒为 `模型最低处 + 0.55`。这里先按同一口径算出它的顶面高度，
   * 引桥终点才能与最终可见的地面齐平——旧值 0.34 是凭"驳岸压顶"猜的，
   * 实际外侧地面在 -0.1，导致引桥末端仍悬空 0.44 m、视觉上像断头桥。 */
  const rootBounds = new THREE.Box3().setFromObject(root);
  const GROUND_Y = rootBounds.min.y + 0.55;
  // 引桥跨过驳岸后伸进外侧实地的长度，避免看到接缝
  const REACH = 4.2;

  /**
   * 一段引桥。
   *
   * 不用 BoxGeometry 贴木纹，而是**复制原桥板的几何并排铺过去**：
   * Box 的 UV 是 0..1 覆盖整面，5.8 m 长的一块会把手里的木纹拉成斜条，
   * 和旁边 1.07 m 一块的桥板完全不是一种东西。铺板则纹理、板缝、宽度全部一致。
   */
  const probe = decks[Math.floor(decks.length / 2)];
  const plateGeo = probe.geometry.clone();
  plateGeo.applyMatrix4(probe.matrixWorld);       // 转成世界坐标的"样板"
  plateGeo.computeBoundingBox();
  const pb = plateGeo.boundingBox;
  const plateLen = Math.max(0.4, pb.max.x - pb.min.x);
  const plateY = pb.max.y;
  const plateCx = (pb.min.x + pb.max.x) / 2;
  const plateCz = (pb.min.z + pb.max.z) / 2;

  const ramp = (x0, x1, y0, y1) => {
    const span = Math.abs(x1 - x0);
    if (span < 0.3) return null;
    const n = Math.max(1, Math.round(span / plateLen));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const cx = x0 + (x1 - x0) * t;
      const top = y0 + (y1 - y0) * t;
      const g = plateGeo.clone();
      g.translate(cx - plateCx, top - plateY, cz - plateCz);
      parts.push(g);
    }
    const mergedGeo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    return mergedGeo;
  };

  /** 引桥栏杆：3 道横杆 + 立柱，沿坡线走 */
  const railing = (x0, x1, y0, y1) => {
    const parts = [];
    const H = 1.02;
    const zHalf = (W - 0.16) / 2;
    for (let k = 0; k < 3; k++) {
      const h = 0.36 + k * 0.32;
      const len = Math.abs(x1 - x0);
      for (const sz of [-1, 1]) {
        const g = new THREE.BoxGeometry(len, 0.055, 0.07, 1, 1, 1);
        g.translate((x0 + x1) / 2, 0, cz + sz * zHalf);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const t = (p.getX(i) - x0) / (x1 - x0);
          // 加上坡度基准，保留自身厚度
          p.setY(i, p.getY(i) + y0 + (y1 - y0) * t + h);
        }
        g.computeVertexNormals();
        parts.push(g);
      }
    }
    const nP = Math.max(2, Math.round(Math.abs(x1 - x0) / 1.6));
    for (let i = 0; i <= nP; i++) {
      const t = i / nP;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (const sz of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.075, H, 0.075);
        g.translate(x, y + H / 2, cz + sz * zHalf);
        parts.push(g);
      }
    }
    return parts;
  };

  /* 东西两段引桥。参数走一个列表，避免"从几何反推坡度符号"这种容易写反的活。
   * 终点不再停在水边（waterBox 边界），而是跨过驳岸、再伸进外侧实地 REACH 米，
   * 顶面平滑降到 GROUND_Y，与 surround_ground 无缝相接。 */
  const spans = [
    { x0: deckBox.max.x, x1: waterBox.max.x + REACH, y0: yE, y1: GROUND_Y },
    { x0: deckBox.min.x, x1: waterBox.min.x - REACH, y0: yW, y1: GROUND_Y },
  ];

  /* 关键：这些几何是按**世界坐标**算的（x 沿桥长、y 向上、z 沿桥宽），
   * 但区域组 `01_入口湖景与桥梁` 自带一个 −90° 绕 X 的旋转（Blender 的
   * Y-up 转 Z-up 留在节点上）。直接把世界几何挂进去，y 和 z 会互换，
   * 引桥就会跑到天上、缩成一条。所以统一乘一次父级逆矩阵再挂。 */
  parent.updateWorldMatrix(true, false);
  const toLocal = new THREE.Matrix4().copy(parent.matrixWorld).invert();

  const added = [];
  for (const sp of spans) {
    const g = ramp(sp.x0, sp.x1, sp.y0, sp.y1);
    if (!g) continue;
    g.applyMatrix4(toLocal);
    const deck = new THREE.Mesh(g, mat);
    deck.name = '栈桥_引桥';
    deck.castShadow = true;
    deck.receiveShadow = true;
    parent.add(deck);
    added.push(deck);

    const geos = railing(sp.x0, sp.x1, sp.y0, sp.y1).map((gg) => {
      gg.applyMatrix4(toLocal);
      gg.deleteAttribute('uv2');
      return gg;
    });
    const merged = mergeGeometries(geos, false);
    if (merged) {
      const r = new THREE.Mesh(merged, mat);
      r.name = '栈桥_引桥栏杆';
      r.castShadow = true;
      r.receiveShadow = true;
      parent.add(r);
      added.push(r);
    }
  }

  return { deckBox, waterBox, added: added.length };
}

/* ------------------------------------------------------------------ */
/* 湖心岛草坪：方形面片改成沿岛形的椭圆                                */
/* ------------------------------------------------------------------ */
/**
 * 模型里湖心岛的草坪是一整块 12×9 的矩形面片，比石砌护岸还大一圈，
 * 从任何角度俯看都是一个绿方块浮在水上。这里按它的实际位置换成椭圆，
 * 略小于石砌内圈，边缘就自然了。
 */
function fixIslandLawn(root) {
  let done = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (o.material.name !== 'Turf • natural grass') return;
    const bb = new THREE.Box3().setFromObject(o);
    if (bb.isEmpty()) return;
    const sz = bb.getSize(new THREE.Vector3());
    const c = bb.getCenter(new THREE.Vector3());
    // 判定：12×9 左右、很扁、位于湖心
    if (Math.abs(sz.x - 12) > 4 || Math.abs(sz.z - 9) > 4) return;
    if (sz.y > 1.2 || c.x < 45 || c.x > 80 || Math.abs(c.z) > 16) return;

    const rx = sz.x * 0.5 * 0.93;
    const rz = sz.z * 0.5 * 0.93;
    const g = new THREE.CircleGeometry(1, 64);
    // Circle 在 XY 平面：先按 rx / rz 拉伸，再摊平到地面
    g.scale(rx, rz, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(c.x, bb.max.y, c.z);
    // 同 weldBridge：区域组带 −90°X 旋转，世界几何要换回父局部再挂
    if (o.parent) {
      o.parent.updateWorldMatrix(true, false);
      g.applyMatrix4(new THREE.Matrix4().copy(o.parent.matrixWorld).invert());
    }
    o.geometry.dispose();
    o.geometry = g;
    done++;
  });
  return done;
}

/* ------------------------------------------------------------------ */
/* 无材质构件：按形态补材质                                            */
/* ------------------------------------------------------------------ */
/**
 * trimesh 导出时丢了材质的构件会退回 three 的默认白材质，于是模型里
 * 混着几棵"白树"和白色构筑物。
 *
 * 这里最容易踩的坑是**只按尺寸猜**：`0625_园艺中心_连栋1_端墙透光板`
 * 高 4 m、面宽 7 m，按"高而窄"判成树冠，端墙就被刷成了深绿色 ——
 * 远看是两个大黑洞。所以判定必须**先看构件名，再退到形态**。
 */
function assignMissingMaterials(root) {
  const mk = {
    leaf: new THREE.MeshStandardMaterial({
      name: 'Foliage (auto)', color: '#47613a', roughness: 0.92, metalness: 0,
      side: THREE.DoubleSide,
    }),
    film: new THREE.MeshStandardMaterial({
      name: 'Film (auto)', color: '#e2ebe4', roughness: 0.6, metalness: 0,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
      emissive: new THREE.Color('#66795f'), emissiveIntensity: 0.45, envMapIntensity: 0.5,
    }),
    steel: new THREE.MeshStandardMaterial({
      name: 'Steel (auto)', color: '#b9c2c4', roughness: 0.58, metalness: 0.5,
      envMapIntensity: 0.7,
    }),
    wall: new THREE.MeshStandardMaterial({
      name: 'Wall (auto)', color: '#d9d9d2', roughness: 0.9, metalness: 0,
    }),
    hard: new THREE.MeshStandardMaterial({
      name: 'Default (auto)', color: '#8f8f86', roughness: 0.85, metalness: 0,
    }),
  };

  const pick = (name, sz) => {
    if (/透光板|阳光板|玻璃|窗/.test(name)) return mk.film;
    if (/膜/.test(name)) return mk.film;
    if (/钢|架|梁|柱|杆|檩|螺栓|龙骨/.test(name)) return mk.steel;
    if (/墙|屋面|屋顶|门|板/.test(name)) return mk.wall;
    // 名字里没有任何建筑特征，才按形态猜：高而窄 → 树冠
    if (sz.y > 1.8 && Math.max(sz.x, sz.z) < 9) return mk.leaf;
    return mk.hard;
  };

  const stat = {};
  const bb = new THREE.Box3();
  const sz = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if ((o.material.name || '').length > 0) return;   // 只处理无名默认材质
    bb.setFromObject(o);
    if (bb.isEmpty()) return;
    bb.getSize(sz);
    const m = pick(o.name || '', sz);
    o.material = m;
    stat[m.name] = (stat[m.name] || 0) + 1;
  });
  return stat;
}

/* ------------------------------------------------------------------ */
/* 静态几何合并（按 区域 × 材质）                                      */
/* ------------------------------------------------------------------ */
function mergeStatic(root, regionOf) {
  const buckets = new Map();       // key = region|materialUuid
  const victims = [];

  root.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    if (KEEP_SEPARATE.test(o.name || '')) return;
    if (!o.geometry || !o.geometry.attributes.position) return;
    const region = regionOf(o);
    const key = `${region}|${o.material.uuid}`;
    if (!buckets.has(key)) buckets.set(key, { region, mat: o.material, list: [] });
    buckets.get(key).list.push(o);
    victims.push(o);
  });

  let merged = 0;
  for (const { region, mat, list } of buckets.values()) {
    if (list.length < 2) continue;
    const geos = [];
    for (const m of list) {
      m.updateWorldMatrix(true, false);
      const g = prepGeo(m.geometry);
      g.applyMatrix4(m.matrixWorld);
      geos.push(g);
    }
    let combined = null;
    try {
      combined = mergeGeometries(geos, false);
    } catch (e) {
      combined = null;
    }
    if (!combined) { geos.forEach((g) => g.dispose()); continue; }
    const mesh = new THREE.Mesh(combined, mat);
    mesh.userData.region = region;
    mesh.name = `merged_${region}_${mat.name || 'mat'}_${list.length}`;
    mesh.castShadow = list.some((m) => m.castShadow);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    for (const m of list) m.parent?.remove(m);
    merged += list.length;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* 风机：以"一台风机"为单位建枢轴，而不是逐片叶子                        */
/* ------------------------------------------------------------------ */
const BLADE_RE = /排风机叶片|循环风扇叶片/;

/**
 * 给排风机 / 循环风扇建转轴。
 *
 * 这里曾经有一个非常隐蔽的 bug，值得写下来：
 *
 * 旧实现是在 root.traverse() 的回调里**直接改树**（把 mesh 从原父节点摘下来、
 * 塞进新建的 pivot、再把 pivot 挂回原父节点）。three 的 traverse 是按下标遍历
 * children 的，边遍历边往 children 里 push，新加的 pivot 会被继续访问到；
 * 它的子节点又是一片名字匹配的叶片，于是**对同一片叶子反复套 pivot**
 * （实测套到 168 层，而叶片只有 154 片）。
 *
 * 每套一层都会执行一次 geometry.translate(-c)。第一层 c 是叶片在几何里的
 * 中心（这个模型的叶片顶点是绝对坐标，c 能到 70 m 量级）；第二层几何已经被
 * 平移过，c 变成 0，于是 mesh.position 被写成 0 —— 叶片就从原位**跳到了世界
 * 原点**，并且绕着原点转。一片 `0.3×0.8` 的白色薄片绕着场地中心扫出半径
 * 几十米的圆，投影到屏幕上就是"一只小鸟翅膀从地面划到天空，一闪而过"。
 *
 * 现在的做法：
 *   1. 先完整收集，再统一处理，绝不在遍历中改树；
 *   2. 用世界矩阵反解保持原位置，不碰 geometry（几何可能是共享的，
 *      改一次会污染所有引用它的网格）；
 *   3. 按空间邻近把同一台风机上的几片叶子归到一个枢轴，整体旋转，
 *      看起来才是"风扇在转"，而不是几片叶子各转各的。
 */
function setupFans(root) {
  // ---- 1) 只收集 ----
  const blades = [];
  root.traverse((o) => {
    if (o.isMesh && BLADE_RE.test(o.name || '')) blades.push(o);
  });
  if (!blades.length) return [];

  const infos = blades.map((m) => {
    m.updateWorldMatrix(true, false);
    const bb = new THREE.Box3().setFromObject(m);
    return {
      m,
      c: bb.getCenter(new THREE.Vector3()),
      size: bb.getSize(new THREE.Vector3()),
      parent: m.parent,
    };
  });

  // ---- 2) 空间聚类：同一台风机上的叶片间距 < 2 m ----
  const clusters = [];
  for (const it of infos) {
    let hit = null;
    for (const cl of clusters) {
      if (cl.parent !== it.parent) continue;      // 不同棚的叶片不合并
      if (cl.center.distanceTo(it.c) < 2.0) { hit = cl; break; }
    }
    if (hit) hit.items.push(it);
    else clusters.push({ parent: it.parent, center: it.c.clone(), items: [it] });
  }

  // ---- 3) 每簇一个枢轴 ----
  const fans = [];
  const inv = new THREE.Matrix4();
  for (const cl of clusters) {
    const parent = cl.parent || root;
    const center = new THREE.Vector3();
    for (const it of cl.items) center.add(it.c);
    center.multiplyScalar(1 / cl.items.length);

    // 转轴：这一簇叶片"最薄"的那根世界轴（薄片法线方向）
    const avg = new THREE.Vector3();
    for (const it of cl.items) avg.add(it.size);
    avg.multiplyScalar(1 / cl.items.length);
    let axisName = 'y';
    if (avg.x <= avg.y && avg.x <= avg.z) axisName = 'x';
    else if (avg.y > avg.z) axisName = 'y';

    const pivot = new THREE.Group();
    pivot.name = `fan_${cl.items.length}blade`;
    parent.add(pivot);
    parent.updateWorldMatrix(true, false);
    pivot.position.copy(parent.worldToLocal(center.clone()));

    // 世界轴换算到枢轴的局部空间：模型若带旋转，直接用 'y' 会转错方向
    const wq = pivot.getWorldQuaternion(new THREE.Quaternion());
    const axisLocal = new THREE.Vector3(
      axisName === 'x' ? 1 : 0, axisName === 'y' ? 1 : 0, axisName === 'z' ? 1 : 0,
    ).applyQuaternion(wq.invert()).normalize();

    for (const it of cl.items) {
      const world = it.m.matrixWorld.clone();
      pivot.add(it.m);                                   // 从原父摘下
      // 用反解矩阵保持世界变换不变，几何一律不动
      it.m.matrix.copy(inv.copy(pivot.matrixWorld).invert().multiply(world));
      it.m.matrix.decompose(it.m.position, it.m.quaternion, it.m.scale);
      it.m.matrixAutoUpdate = true;
      // 薄片投影极易出现 shadow acne，而且叶片本身在转，投影会跟着扫
      it.m.castShadow = false;
      it.m.receiveShadow = false;
    }

    fans.push({ pivot, axis: axisName, axisLocal, region: null, speed: 0 });
  }
  return fans;
}

/* ------------------------------------------------------------------ */
/* 主加载函数                                                          */
/* ------------------------------------------------------------------ */
export async function loadSite(scene, { onProgress, merge = true } = {}) {
  const loader = new GLTFLoader();

  const gltf = await loader.loadAsync(MODEL_URL, (e) => {
    if (onProgress && e.total) onProgress(Math.min(0.99, e.loaded / e.total));
  });

  const root = gltf.scene;
  root.name = 'qinhu_site';
  root.updateMatrixWorld(true);

  /* ---- 1. 区域分组 ----
   * 注意层级：glb 的场景根下面还套了一层 "world"，五个区域组在它下面。
   * 所以不能只扫 root.children，必须整棵树找名字匹配的组节点。
   */
  const regionNodes = new Map();          // Object3D -> regionId
  root.traverse((o) => {
    if (REGION_MAP[o.name]) regionNodes.set(o, REGION_MAP[o.name]);
  });

  const regionGroups = new Map();         // regionId -> Object3D[]
  for (const [node, id] of regionNodes) {
    if (!regionGroups.has(id)) regionGroups.set(id, []);
    regionGroups.get(id).push(node);
  }

  const regionCache = new WeakMap();
  /** 判断一个网格属于哪个区域：向上找注册过的祖先 */
  function regionOf(obj) {
    let o = obj;
    const chain = [];
    while (o) {
      if (regionCache.has(o)) {
        const v = regionCache.get(o);
        chain.forEach((c) => regionCache.set(c, v));
        return v;
      }
      chain.push(o);
      if (regionNodes.has(o)) {
        const id = regionNodes.get(o);
        chain.forEach((c) => regionCache.set(c, id));
        return id;
      }
      o = o.parent;
    }
    chain.forEach((c) => regionCache.set(c, 'base'));
    return 'base';
  }

  /* ---- 2. 材质 / 阴影 / 几何修补 ---- */
  const matInfo = tuneMaterials(root);

  // 丢了材质的构件（trimesh 导出时的老毛病）先补上，否则模型里会混着
  // 几棵"白树"；而且它们各自是独立材质实例，合并时会碎成一堆桶。
  const missingMat = assignMissingMaterials(root);

  setupShadows(root);

  // 桥接岸：桥面板 x 只铺到 91.9，而湖面东边界在 96.8，东端悬空近 5 m
  const bridgeFix = weldBridge(root, matInfo);
  // 湖心岛草坪是一整块 12×9 的矩形面片，比石砌护岸还大，换成椭圆
  const islandFix = fixIslandLawn(root);

  /* ---- 3. 收集可驱动对象 ---- */
  const fans = [];
  const lamps = [];
  const crops = [];
  const films = [];

  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || '';
    const region = regionOf(o);

    // 叶片统一交给 setupFans 处理（它要按"台"聚类，不能逐片塞 pivot）
    if (BLADE_RE.test(name)) return;

    if (/传感器状态灯/.test(name)) {
      const mat = o.material.clone();
      mat.emissive = new THREE.Color('#39e0c0');
      mat.emissiveIntensity = 0.6;
      o.material = mat;
      lamps.push({ mesh: o, mat, region, pulse: Math.random() * 6 });
    } else if (/内部作物行/.test(name)) {
      const mat = o.material.clone();
      mat.color = new THREE.Color('#ffffff');
      o.material = mat;
      crops.push({ mesh: o, mat, region, base: new THREE.Color('#ffffff') });
    } else if (/拱形棚膜/.test(name)) {
      // 这里的膜**按构件名**兜底，不依赖材质名：模型里这批端墙的材质名并不叫
      // 'Translucent greenhouse film'，于是漏掉了 tuneMaterials 那套处理，
      // 保持成 trimesh 导出的不透明深色 —— 远看就是"挂着黑布的两个大洞"。
      const mat = o.material.clone();
      mat.transparent = true;
      mat.opacity = 0.58;
      mat.roughness = 0.6;
      mat.metalness = 0.0;
      mat.side = THREE.DoubleSide;
      mat.depthWrite = false;
      mat.color = new THREE.Color('#e2ebe4');
      mat.envMapIntensity = 0.5;
      if ('emissive' in mat) {
        // 棚内几乎收不到光，靠自发光补一层漫射，膜才有"透光"的感觉
        mat.emissive = new THREE.Color('#66795f');
        mat.emissiveIntensity = 0.5;
      }
      o.material = mat;
      films.push({ mesh: o, mat, region, base: mat.opacity, baseColor: mat.color.clone() });
    }
  });

  /* ---- 3.5 风机枢轴（按台聚类，必须在合并之前做） ---- */
  for (const f of setupFans(root)) {
    f.region = regionOf(f.pivot);
    fans.push(f);
  }

  /* ---- 4. 合并静态几何 ---- */
  let mergedCount = 0;
  if (merge) {
    try {
      mergedCount = mergeStatic(root, regionOf);
    } catch (e) {
      console.warn('[site] 静态合并失败，跳过', e);
    }
  }

  /* ---- 5. 水面换成带反射的材质 ---- */
  let water = null;
  let waterY = 0;
  if (matInfo.water) {
    root.traverse((o) => {
      if (o.isMesh && o.material === matInfo.water) {
        o.material = makeWaterMaterial(getTextures().waterN);
        o.renderOrder = 2;
        o.receiveShadow = false;
        o.castShadow = false;
        o.geometry.computeBoundingBox();
        const bb = new THREE.Box3().setFromObject(o);
        waterY = bb.max.y;
        water = { mesh: o, mat: o.material };
      }
    });
  }

  /* ---- 6. 包围盒与区域框 ---- */
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());

  const regions = new Map();
  for (const [id, groups] of regionGroups) {
    const box = new THREE.Box3();
    for (const g of groups) box.expandByObject(g);
    if (box.isEmpty()) continue;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    regions.set(id, {
      id,
      name: {
        lake: '琴湖景观区', hort: '园艺植物生产实训中心',
        peony: '芍药种质资源创新基地', smart: '数智农业实践研学中心',
        base: '基地环境',
      }[id] || id,
      groups,
      box,
      center: c,
      size: s,
      // 相机对准的焦点：取区域中心、抬到建筑高度的一半
      focus: new THREE.Vector3(c.x, Math.min(6, box.max.y * 0.45), c.z),
    });
  }

  /* ---- 6.5 周边地面 ----
   * 模型自带的地块是一块"方板"，远看像浮在空中的模型底座。补一圈大地面，
   * 用纯色 + 雾来收边：不铺贴图是故意的，远处铺贴图只会出现明显的重复。
   */
  {
    const R = Math.max(size.x, size.z) * 5.0;
    const g = new THREE.PlaneGeometry(R, R, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshStandardMaterial({
      color: '#4f5b3c',
      roughness: 1,
      metalness: 0,
    });
    const apron = new THREE.Mesh(g, m);
    apron.position.set(center.x, bounds.min.y + 0.55, center.z);
    apron.receiveShadow = true;
    apron.name = 'surround_ground';
    scene.add(apron);
  }

  /* ---- 7. 清单（设备坐标与数据键） ---- */
  let manifest = null;
  try {
    const r = await fetch(MANIFEST_URL);
    manifest = await r.json();
  } catch (e) {
    console.warn('[site] manifest 读取失败', e);
  }

  scene.add(root);

  /* ---- 8. 孪生驱动 API ---- */
  const state = new Map();     // region -> { fan, filmShade, cropTint, lamp }

  function setRegion(id, patch) {
    const cur = state.get(id) || { fan: 0, filmShade: 0, cropTint: null, lamp: null };
    Object.assign(cur, patch);
    state.set(id, cur);
  }

  function applyState() {
    // 风机转速
    for (const f of fans) {
      const s = state.get(f.region);
      f.speed = s ? (s.fan || 0) : 0;
    }
    // 棚膜：遮阳越高，膜越暗、越不透
    for (const f of films) {
      const s = state.get(f.region);
      const shade = s ? (s.filmShade || 0) : 0;
      f.mat.opacity = f.base + shade * 0.3;
      f.mat.color.copy(f.baseColor).multiplyScalar(1 - shade * 0.42);
    }
    // 作物色
    for (const c of crops) {
      const s = state.get(c.region);
      c.mat.color.copy(s && s.cropTint ? s.cropTint : c.base);
    }
    // 状态灯
    for (const l of lamps) {
      const s = state.get(l.region);
      if (s && s.lamp) l.mat.emissive.copy(s.lamp);
    }
  }

  let t = 0;
  function update(dt) {
    t += dt;
    for (const f of fans) {
      if (!f.speed) continue;
      // 绕"这一簇叶片自己算出来的局部轴"转，整台风机是一个刚体。
      // 转速 2.4 rad/s（≈0.38 转/秒）：再快就是频闪，不是旋转。
      f.pivot.rotateOnAxis(f.axisLocal, dt * f.speed * 2.4);
    }
    // 状态灯缓慢呼吸，暗示"在线"
    for (const l of lamps) {
      l.mat.emissiveIntensity = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.6 + l.pulse));
    }
  }

  return {
    root,
    bounds, center, size,
    regions,
    facilities: manifest?.facilities || [],
    components: manifest?.components || [],
    manifest,
    fans, lamps, crops, films,
    water, waterY: waterY || 0,
    mergedCount,
    fixes: { missingMat, bridge: bridgeFix, island: islandFix },
    setRegion, applyState, update,
    regionOf,
  };
}

/* ------------------------------------------------------------------ */
/* 相机预设：按模型实际包围盒算，换模型也不用改代码                      */
/* ------------------------------------------------------------------ */
export function buildViews(site) {
  const { center, size, bounds } = site;
  const R = Math.max(size.x, size.z);
  const d = R * 0.92;
  const h = R * 0.66;

  /* 大门视角：模型的入口在东侧（门柱 x≈108），所以"进门第一眼"是自东向西。
   * 位姿不写死数字，从模型里找门柱，换个模型也能用。
   * 注意：门柱有南北两根（z≈±8），必须收集全部门柱再取中点，
   * 不能取 traverse 命中的第一根——否则中线会偏到 z=8，视角是斜的。 */
  const gatePts = [];
  site.root.traverse((o) => {
    if (!o.isMesh) return;
    if (!/入口门柱/.test(o.name || '')) return;
    const bb = new THREE.Box3().setFromObject(o);
    if (bb.isEmpty()) return;
    gatePts.push(bb.getCenter(new THREE.Vector3()));
  });
  let gateX = null;
  let gateZ = 0;
  if (gatePts.length) {
    gateX = gatePts.reduce((s, p) => s + p.x, 0) / gatePts.length;
    gateZ = gatePts.reduce((s, p) => s + p.z, 0) / gatePts.length;
  }
  const gx = gateX ?? bounds.max.x;

  return {
    // 默认视角：进门之后的第一个镜头，自东向西看湖与桥。
    // 站位放在门内侧 6 m：再靠外会顶到门头结构和标识牌上。
    entry: {
      pos: [gx - 6, 1.75, gateZ],
      target: [gx - 60, 2.15, gateZ],
      fov: 50,
    },
    aerial: {
      pos: [center.x - d * 0.75, h, center.z + d * 0.72],
      target: [center.x, 0, center.z], fov: 38,
    },
    overview: {
      pos: [center.x - d * 0.95, h * 1.05, center.z + d * 0.95],
      target: [center.x, 0, center.z], fov: 42,
    },
    top: { pos: [center.x, R * 1.35, center.z + 0.01], target: [center.x, 0, center.z], fov: 38 },
    lake: { pos: [center.x + 26, 13, center.z + 42], target: [center.x + 12, 0, center.z], fov: 46 },
    hort: { pos: [center.x + 46, 18, center.z + 6], target: [center.x + 24, 2, center.z - 46], fov: 44 },
    peony: { pos: [center.x - 30, 16, center.z + 18], target: [center.x - 22, 2, center.z - 49], fov: 44 },
    smart: { pos: [center.x - 22, 14, center.z + 34], target: [center.x - 38, 2, center.z + 8], fov: 44 },
  };
}
