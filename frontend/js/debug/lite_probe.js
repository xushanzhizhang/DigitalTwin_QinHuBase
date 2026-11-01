/**
 * 轻量级白点探针（不做 BFS，保证不丢帧）
 * =====================================
 * 旧 ghost 探针每帧做 4 邻域 BFS + raycast，flyTo 期间开销过大、大量丢帧，
 * 只抓到 frame 2/4。本探针每帧只做：
 *   1) readPixels 全分辨率；
 *   2) 一次线性扫描，记录最大亮度及其坐标；
 *   3) 统计超阈值像素数量与屏幕边界框（不做连通域、不做 raycast）。
 * 数据存 window.__lite，可在 flyTo 结束后离线分析，再按需补 raycast。
 */
import * as THREE from 'three';

let state = null;

export function attach(renderer, scene, camera, { threshold = 245 } = {}) {
  if (state) throw new Error('lite 探针已安装');
  const cv = renderer.domElement;
  const gl = renderer.getContext();

  let W = 0, H = 0, buf = null;
  function ensureBuffer(w, h) {
    if (w === W && h === H && buf) return;
    W = w; H = h;
    buf = new Uint8Array(W * H * 4);
    lite.W = W; lite.H = H;
  }

  const lite = {
    threshold,
    frames: 0,
    W: 0, H: 0,
    perFrame: [],   // 每帧摘要
  };
  window.__lite = lite;

  const origRender = renderer.render.bind(renderer);
  renderer.render = function (s, cam) {
    // 只分析主渲染（默认 framebuffer + 主相机）；平面反射 render 到独立 RT，
    // 其反射相机位置是主相机关于水面的镜像，混进来会产生"y 正负翻转"的假象。
    const isMain = renderer.getRenderTarget() === null && cam === camera;
    ensureBuffer(cv.width, cv.height);
    origRender(s, cam);
    if (!isMain) return;

    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    let mx = 0, mxX = 0, mxY = 0;
    let nBright = 0;
    let bMinX = W, bMaxX = -1, bMinY = H, bMaxY = -1;

    for (let y = 0; y < H; y++) {
      const rowBase = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = rowBase + x * 4;
        // 亮度
        const l = buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722;
        if (l > mx) { mx = l; mxX = x; mxY = y; }
        if (l >= threshold) {
          nBright++;
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
          if (y < bMinY) bMinY = y;
          if (y > bMaxY) bMaxY = y;
        }
      }
    }

    lite.perFrame.push({
      f: lite.frames,
      mx: mx | 0, mxX, mxY,
      nb: nBright,
      // 只有存在亮像素时才记录边界框，省内存
      bb: nBright ? [bMinX, bMinY, bMaxX, bMaxY] : null,
      cam: [cam.position.x, cam.position.y, cam.position.z],
    });
    lite.frames++;
  };

  state = { renderer, origRender };
  return function detach() { uninstall(); };
}

export function uninstall() {
  if (!state) return;
  state.renderer.render = state.origRender;
  state = null;
}

export function result() {
  return window.__lite;
}
