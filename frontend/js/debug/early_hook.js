/**
 * 早期渲染钩子（调试用）
 * 在 main.js 之前以 module 方式加载，hook WebGLRenderer.prototype.render，
 * 从应用的第一帧开始记录每帧最大亮度与高亮度小簇，捕捉初始化瞬间的白点。
 * 结果存 window.__early。
 */
import * as THREE from 'three';

const THRESHOLD = 225;

function makeStore() {
  return {
    frames: 0,
    maxLum: 0,
    series: [],
    spikes: [],
    installed: false,
  };
}
window.__early = makeStore();
window.__early.THREE = THREE;

const origRender = THREE.WebGLRenderer.prototype.render;
THREE.WebGLRenderer.prototype.render = function (scene, camera) {
  origRender.call(this, scene, camera);
  // eslint-disable-next-line no-unused-expressions
  this.__earlyTouch = (this.__earlyTouch || 0) + 1;

  const store = window.__early;
  store.frames++;

  const gl = this.getContext();
  const cv = this.domElement;
  const W = cv.width, H = cv.height;
  if (!store._buf || store._buf.length !== W * H * 4) {
    store._buf = new Uint8Array(W * H * 4);
    store.W = W; store.H = H;
  }
  const buf = store._buf;
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  const lum = i => buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722;

  let mx = 0;
  const bright = [];
  for (let i = 0; i < buf.length; i += 4) {
    const l = lum(i);
    if (l > mx) mx = l;
    if (l >= THRESHOLD) {
      const px = (i / 4) % W, py = ((i / 4) / W) | 0;
      bright.push([px, py, l | 0]);
    }
  }
  if (mx > store.maxLum) store.maxLum = mx | 0;
  store.series.push(mx | 0);
  if (store.series.length > 500) store.series.shift();

  // 记录亮像素数量较少的帧（小簇/孤立点），并定位
  if (bright.length > 0 && bright.length < 400) {
    const xs = bright.map(p => p[0]), ys = bright.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let hit = null;
    try {
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2((cx / W) * 2 - 1, (cy / H) * 2 - 1);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(scene.children, true);
      hit = hits[0] ? {
        name: hits[0].object.name,
        point: hits[0].point.toArray().map(v => +v.toFixed(1)),
        names: hits.slice(0, 8).map(h => h.object.name),
      } : null;
    } catch (e) { hit = { error: e.message }; }

    store.spikes.push({
      frame: store.frames,
      n: bright.length,
      screen: [cx | 0, cy | 0],
      maxLum: mx | 0,
      hit,
    });
    if (store.spikes.length > 60) store.spikes.shift();
  }
};
THREE.WebGLRenderer.prototype.render.__isEarly = true;

window.__early.installed = true;
