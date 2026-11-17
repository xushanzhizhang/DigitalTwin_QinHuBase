/**
 * 场景主体：原样加载用户手工制作并定稿的 glb 模型
 * ================================================
 * 模型：《场景图及建模要求/建模/qinhu_base_final_textured.glb》
 *      （Draco 6 级压缩，411 网格 / 75 材质 / 约 72.6 万三角面，23 张内嵌贴图）
 *
 * 【本模块的边界 —— 加载时不修改模型】
 *   不再做任何材质改写、几何补洞、静态合并、水面替换、风机/棚膜/作物驱动。
 *   模型以 GLTFLoader + DRACOLoader 解码后，**保持其几何、材质、层级、贴图原样**
 *   加入场景。这里只做三件不触碰模型数据的事：
 *     1. 按模型自身的几何名前缀（M01–M09 / SITE / VEG）建立功能分区索引，
 *        供左侧分区列表、3D 标签点击与相机 flyTo 使用；
 *     2. 从模型里识别东门门柱（M01_Gate_Pier_N/S），给出"站在东门"的初始视角；
 *     3. 设置运行时渲染标志（阴影开关）与一圈收边的周边地面 —— 这些是 three 对象
 *        的运行时属性 / 场景衬托，不会写回模型文件，模型本身不变。
 *
 * 为与既有 main.js / binding.js 的调用约定保持兼容，返回值仍带 setRegion /
 * applyState / update / fans / films / water 等字段，但它们均为空或空操作（no-op）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MODEL_URL = '/assets/model/qinhu_base_final_textured.glb';

// 本地 Draco decoder 目录（含 draco_wasm_wrapper.js + draco_decoder.wasm，
// 以及 asm.js 后备 draco_decoder.js）。相对路径，随项目走、无需联网。
const DECODER_PATH = './vendor/three/addons/libs/draco/';

/** 业务区域 -> 几何名前缀判定（模型几何名以 M0x_ / SITE_ / VEG_ 开头） */
const REGION_RULES = [
  ['lake',  /^(M03|M04)_/],   // M03 湖体/驳岸/湖心岛，M04 平板石桥/栏杆/石狮
  ['hort',  /^M07_/],         // M07 园艺三连栋薄膜温室（农膜/玫瑰/LED）
  ['peony', /^M08_/],         // M08 芍药三拱棚 + 管理房（Tunnel1–3/House）
  ['smart', /^(M05|M06)_/],   // M05 研学中心玻璃温室主体，M06 其室内（苗床/水培/控制柜）
];

/** 区域业务 id -> 中文展示名 */
const REGION_NAME = {
  base: '基地环境',
  lake: '琴湖景观区',
  hort: '园艺植物生产实训中心',
  peony: '芍药种质资源创新基地',
  smart: '数智农业实践研学中心',
};

/** 按几何名判断所属业务区域；其余（SITE/M01/M02/M09/VEG 等）归入 base */
function regionOfName(name) {
  for (const [id, re] of REGION_RULES) {
    if (re.test(name)) return id;
  }
  return 'base';
}

/**
 * 运行时阴影标志（仅渲染状态，不改动模型）。
 * 建筑/大门/桥/路灯等结构件投影；地形、铺装、水面、室内作物与全部植被不投影，
 * 以控制阴影开销，避免 72 万面整体进入阴影通道。
 */
const CAST_SHADOW_RE = /^(M01|M04|M05|M07|M08|M09)_/;

function setupRuntimeShadows(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.receiveShadow = true;
    o.castShadow = CAST_SHADOW_RE.test(o.name || '');
  });
}

/* ------------------------------------------------------------------ */
/* 加载并组装                                                          */
/* ------------------------------------------------------------------ */
export async function loadSite(scene, { onProgress } = {}) {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DECODER_PATH);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  const gltf = await loader.loadAsync(MODEL_URL, (e) => {
    if (onProgress && e.total) onProgress(Math.min(0.99, e.loaded / e.total));
  });

  const root = gltf.scene;
  root.name = 'qinhu_site';
  root.updateMatrixWorld(true);

  // 运行时阴影标志（不触碰模型几何/材质）
  setupRuntimeShadows(root);

  /* ---- 按几何名收集各区域 mesh，并计算真实包围盒 ---- */
  const regionMeshes = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const id = regionOfName(o.name || '');
    if (!regionMeshes.has(id)) regionMeshes.set(id, []);
    regionMeshes.get(id).push(o);
  });

  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());

  const regions = new Map();
  for (const [id, list] of regionMeshes) {
    const box = new THREE.Box3();
    for (const m of list) box.expandByObject(m);
    if (box.isEmpty()) continue;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    regions.set(id, {
      id,
      name: REGION_NAME[id] || id,
      meshes: list,
      box,
      center: c,
      size: s,
      // 相机焦点：区域中心、抬到建筑高度的一半
      focus: new THREE.Vector3(c.x, Math.min(6, box.max.y * 0.45), c.z),
    });
  }

  /* ---- 周边收边地面（场景衬托，非模型数据） ----
   * 模型地块本身有限，补一圈大地面 + 雾收边，避免看起来像浮空的模型底座。 */
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

  scene.add(root);
  dracoLoader.dispose();

  /* ---- 兼容字段：不再驱动模型，保留空值/空操作以匹配既有调用 ---- */
  const noop = () => {};

  return {
    root,
    bounds, center, size,
    regions,
    // 以下为兼容 main.js / binding.js 的占位字段
    facilities: [],
    components: [],
    manifest: null,
    fans: [],
    lamps: [],
    crops: [],
    films: [],
    water: null,       // 保留模型自带水面，不替换、不做自定义平面反射
    waterY: 0,
    mergedCount: 0,
    setRegion: noop,
    applyState: noop,
    update: noop,
    regionOf: (o) => regionOfName(o?.name || ''),
  };
}

/* ------------------------------------------------------------------ */
/* 相机预设：全部按模型实际包围盒与门柱位置计算，不写死坐标               */
/* ------------------------------------------------------------------ */
export function buildViews(site) {
  const { center, size, bounds } = site;
  const R = Math.max(size.x, size.z);
  const d = R * 0.92;
  const h = R * 0.66;

  /* 东门视角：大门在基地东侧（X≈112），"进门第一眼"自东向西。
   * 门柱有南北两根（M01_Gate_Pier_N / _S），收集全部门柱再取中点，
   * 不能只取命中的第一根，否则中线会偏。 */
  const gatePts = [];
  site.root.traverse((o) => {
    if (!o.isMesh) return;
    if (!/Gate_Pier/.test(o.name || '')) return;
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
    // 默认视角：站在东门内侧 6 m，人眼高度 1.75，自东向西看湖与桥
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
