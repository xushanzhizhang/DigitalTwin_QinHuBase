/**
 * 白点/闪烁探针（调试用）
 * 两种用法：
 *   1) 运行时（__model 已就绪）：
 *        const probe = await import('/js/debug/ghost_probe.js');
 *        probe.install(); probe.uninstall(); probe.result();
 *   2) 早期（createEnvironment 之后立即，传入运行时对象）：
 *        import { attach } from './debug/ghost_probe.js';
 *        const detach = attach(renderer, scene, camera);
 *
 * 原理：包装 renderer.render，在 render 内部同步 readPixels（preserveDrawingBuffer=false
 * 时必须如此），全分辨率扫描高亮度像素，做连通域聚类，并在同一帧用 raycaster 定位来源。
 * 注意：每帧动态读取 canvas 尺寸，resize 后重新分配缓冲区，避免坐标映射错位。
 */
import * as THREE from 'three';

let state = null;

export function attach(renderer, scene, camera, { threshold = 228, maxCluster = 260 } = {}) {
  if (state) throw new Error('探针已安装，请勿重复 attach');
  const cv = renderer.domElement;
  const gl = renderer.getContext();

  // 可变缓冲区，随 canvas 尺寸调整
  let W = 0, H = 0, buf = null;
  function ensureBuffer(w, h) {
    if (w === W && h === H && buf) return;
    W = w; H = h;
    buf = new Uint8Array(W * H * 4);
    ghost.W = W; ghost.H = H;
  }

  const ghost = {
    frames: 0,
    threshold,
    W: 0, H: 0,
    maxLum: 0,
    maxLumSeries: [],
    clusters: [],
    sunTrack: [],
    camTrack: [],
  };
  window.__ghost = ghost;

  // 找到天空对象，用于读取太阳方向
  let skyMesh = null;
  scene.traverse(o => {
    if (o.material && o.material.uniforms && o.material.uniforms.uSunDir) skyMesh = o;
  });
  const _sunProj = new THREE.Vector3();

  const lum = i => buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const origRender = renderer.render.bind(renderer);
  renderer.render = function (s, cam) {
    // 先确保缓冲区匹配当前 canvas 尺寸
    ensureBuffer(cv.width, cv.height);

    origRender(s, cam);
    ghost.frames++;

    // 记录太阳屏幕投影与相机位置
    let curSunScreen = null;
    if (skyMesh && skyMesh.material.uniforms.uSunAmt.value > 0) {
      const sd = skyMesh.material.uniforms.uSunDir.value;
      _sunProj.copy(sd).multiplyScalar(500).project(cam);
      if (_sunProj.z < 1) {
        const sx = (_sunProj.x * 0.5 + 0.5) * W;
        const sy = (-_sunProj.y * 0.5 + 0.5) * H;
        curSunScreen = [sx | 0, sy | 0];
        ghost.sunTrack.push(curSunScreen);
        if (ghost.sunTrack.length > 2000) ghost.sunTrack.shift();
      }
    }
    ghost.camTrack.push([cam.position.x | 0, cam.position.y | 0, cam.position.z | 0]);
    if (ghost.camTrack.length > 2000) ghost.camTrack.shift();

    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    // 1) 全分辨率找最亮像素
    let mx = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const l = lum(i);
      if (l > mx) mx = l;
    }
    if (mx > ghost.maxLum) ghost.maxLum = mx | 0;
    ghost.maxLumSeries.push(mx | 0);
    if (ghost.maxLumSeries.length > 300) ghost.maxLumSeries.shift();

    // 2) 收集超阈值像素，做连通域（4邻域，BFS）
    const labels = new Int16Array(W * H).fill(-1);
    const comps = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (labels[idx] !== -1) continue;
        if (lum(idx * 4) < threshold) { labels[idx] = -2; continue; }
        const cid = comps.length;
        const queue = [idx];
        labels[idx] = cid;
        const pts = [];
        let sumX = 0, sumY = 0, sumL = 0;
        while (queue.length) {
          const cur = queue.shift();
          const cxp = cur % W, cyp = (cur / W) | 0;
          const l = lum(cur * 4);
          pts.push(cur);
          sumX += cxp; sumY += cyp; sumL += l;
          const neigh = [
            cxp > 0 ? cur - 1 : -1,
            cxp < W - 1 ? cur + 1 : -1,
            cyp > 0 ? cur - W : -1,
            cyp < H - 1 ? cur + W : -1,
          ];
          for (const n of neigh) {
            if (n < 0 || labels[n] !== -1) continue;
            if (lum(n * 4) >= threshold) { labels[n] = cid; queue.push(n); }
            else labels[n] = -2;
          }
        }
        comps.push({
          n: pts.length,
          cx: sumX / pts.length,
          cy: sumY / pts.length,
          avgL: sumL / pts.length,
        });
      }
    }

    // 3) 只记录小而亮的孤立簇（排除大面积天空/水面/地面）
    const small = comps.filter(c => c.n > 0 && c.n < maxCluster);
    if (small.length && small.length <= 40) {
      const recs = small.map(c => {
        ndc.x = (c.cx / W) * 2 - 1;
        ndc.y = (c.cy / H) * 2 - 1;
        ray.setFromCamera(ndc, cam);
        const hits = ray.intersectObjects(s.children, true);
        const o0 = hits[0] ? hits[0].object : null;
        return {
          frame: ghost.frames,
          pixels: c.n,
          screen: [c.cx | 0, c.cy | 0],
          avgLum: c.avgL | 0,
          sunScreen: curSunScreen,
          hit: hits[0] ? {
            name: hits[0].object.name,
            point: hits[0].point.toArray().map(v => +v.toFixed(1)),
          } : null,
          names: hits.slice(0, 8).map(h => h.object.name),
          detail: o0 ? {
            name: o0.name,
            uuid: o0.uuid,
            parent: o0.parent ? o0.parent.name : null,
            parentUuid: o0.parent ? o0.parent.uuid : null,
            type: o0.type,
            material: o0.material ? o0.material.name : null,
            materialType: o0.material ? o0.material.type : null,
            verts: o0.geometry && o0.geometry.attributes.position ? o0.geometry.attributes.position.count : null,
            visible: o0.visible,
          } : null,
        };
      });
      ghost.clusters.push(...recs);
      if (ghost.clusters.length > 120) ghost.clusters.splice(0, ghost.clusters.length - 120);
    }
  };

  state = { renderer, origRender };
  return function detach() { uninstall(); };
}

export function install(opts = {}) {
  if (state) return window.__ghost;
  const m = window.__model;
  if (!m) throw new Error('window.__model 不存在，请先确保调试钩子已加载');
  return attach(m.renderer, m.scene, m.camera, opts);
}

export function uninstall() {
  if (!state) return;
  state.renderer.render = state.origRender;
  state = null;
}

export function result() {
  return window.__ghost;
}
