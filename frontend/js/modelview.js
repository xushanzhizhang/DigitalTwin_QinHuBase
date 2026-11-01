/**
 * 纯模型预览页
 * ============
 * 只加载 glb 模型与材质，不接数据面板 —— 用来确认模型本身是否站得住。
 * 界面刻意做得很轻：一排视角、一个太阳高度滑杆。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createEnvironment, updateSky, solarPosition } from './scene/env.js';
import { loadSite, buildViews } from './scene/site.js';
import { createReflection, updateReflection } from './scene/water.js';

const canvas = document.getElementById('scene');
const loaderEl = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');

const env = createEnvironment(canvas);
const { renderer, scene, camera } = env;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.minDistance = 8;
controls.maxDistance = 600;
controls.maxPolarAngle = Math.PI * 0.492;
controls.minPolarAngle = 0.02;
controls.zoomSpeed = 0.85;

let site = null;
let views = null;
let refl = null;

const Q = new URLSearchParams(location.search);

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */
(async () => {
  try {
    site = await loadSite(scene, {
      // ?merge=0 关闭静态合并，用于按节点名排查原始结构
      merge: Q.get('merge') !== '0',
      onProgress: (p) => {
        loaderText.textContent = `正在载入模型… ${Math.round(p * 100)}%`;
      },
    });
  } catch (e) {
    console.error('[model] 模型加载失败', e);
    loaderText.innerHTML = `<span style="color:#b3402f">模型加载失败</span><br>
      <span style="font-size:11px">${String((e && e.message) || e)}</span>`;
    return;
  }

  views = buildViews(site);

  const v = views.entry || views.aerial;
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  controls.target.set(...v.target);
  camera.updateProjectionMatrix();

  // URL 可覆盖机位，便于定点核对
  const num = (k) => (Q.get(k) ? Q.get(k).split(',').map(Number) : null);
  const qCam = num('cam'), qTgt = num('tgt');
  if (qCam && qCam.length === 3) camera.position.set(qCam[0], qCam[1], qCam[2]);
  if (qTgt && qTgt.length === 3) controls.target.set(qTgt[0], qTgt[1], qTgt[2]);
  if (Q.get('fov')) { camera.fov = Number(Q.get('fov')); camera.updateProjectionMatrix(); }

  refl = createReflection(512);
  refl.planeY = site.waterY;
  if (site.water) refl.hide.push(site.water.mesh);

  loaderEl.classList.add('done');

  console.log('[model] 就绪', {
    三角面: renderer.info.render.triangles,
    网格数: (() => { let n = 0; scene.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
    合并掉的对象: site.mergedCount,
    风机: site.fans.length,
    作物行: site.crops.length,
  });
  window.__model = { scene, camera, renderer, site, views, env };
  window.__THREE = THREE;
})();

/* ------------------------------------------------------------------ */
/* 光照                                                                */
/* ------------------------------------------------------------------ */
const DOY = 300;
const LAT = 34.26;

function applyHour(hour) {
  const { elev, az } = solarPosition(LAT, DOY, hour);
  updateSky(env, { elev, az, cloud: 0.18, rain: 0 });

  const er = (elev * Math.PI) / 180, ar = (az * Math.PI) / 180;
  const sunDir = new THREE.Vector3(
    Math.cos(er) * Math.sin(ar), Math.sin(er), -Math.cos(er) * Math.cos(ar),
  ).normalize();
  const skyCol = new THREE.Color().lerpColors(
    new THREE.Color('#8fa6b4'), new THREE.Color('#c9dce2'),
    THREE.MathUtils.clamp(elev / 55, 0, 1),
  );
  if (site?.water) {
    const m = site.water.mat;
    m.uniforms.uSun.value.copy(sunDir);
    m.uniforms.uSky.value.copy(skyCol);
    m.uniforms.uSunColor.value.copy(env.sun.color);
    m.uniforms.uFog.value.copy(scene.fog.color);
    m.uniforms.uFogDensity.value = scene.fog.density;
  }
}

const hourEl = document.getElementById('hour');
const hourVal = document.getElementById('hourval');
hourEl.value = Q.get('hour') || hourEl.value;
hourVal.textContent = `${String(Math.floor(+hourEl.value)).padStart(2, '0')}:00`;
hourEl.addEventListener('input', () => {
  const h = parseFloat(hourEl.value);
  hourVal.textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  applyHour(h);
});
applyHour(parseFloat(hourEl.value));

/* ------------------------------------------------------------------ */
/* 视角                                                                */
/* ------------------------------------------------------------------ */
let fly = null;
function flyTo(name) {
  const v = views && views[name];
  if (!v) return;
  fly = {
    t0: performance.now(), dur: 1100,
    fromPos: camera.position.clone(),
    toPos: new THREE.Vector3(...v.pos),
    fromTar: controls.target.clone(),
    toTar: new THREE.Vector3(...v.target),
    fromFov: camera.fov, toFov: v.fov ?? camera.fov,
  };
  controls.enabled = false;
}

document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    flyTo(btn.dataset.view);
  });
});

const shadowBtn = document.getElementById('toggle-shadow');
shadowBtn?.addEventListener('click', () => {
  const on = !renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = on;
  env.sun.castShadow = on;
  shadowBtn.classList.toggle('on', on);
  scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
});

const KEYMAP = ['aerial', 'overview', 'top', 'lake', 'hort', 'peony', 'smart'];
window.addEventListener('keydown', (e) => {
  const i = parseInt(e.key, 10);
  if (i >= 1 && i <= KEYMAP.length) {
    document.querySelectorAll('[data-view]').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === KEYMAP[i - 1]);
    });
    flyTo(KEYMAP[i - 1]);
  }
});

/* ------------------------------------------------------------------ */
/* 尺寸与渲染循环                                                      */
/* ------------------------------------------------------------------ */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
let tWater = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());
  tWater += dt;

  if (site) {
    // 调试钩子：冻结水面相位，便于逐帧比对"闪烁"（见 _tools/flicker_step.js）
    if (window.__freezeWater) tWater = window.__waterT || 0;
    if (site.water) site.water.mat.uniforms.uTime.value = tWater;
    site.update(dt);
    updateReflection(renderer, scene, camera, refl,
      site.water ? [site.water.mat] : [], site.waterY);
  }

  if (fly) {
    const t = Math.min(1, (performance.now() - fly.t0) / fly.dur);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
    controls.target.lerpVectors(fly.fromTar, fly.toTar, e);
    camera.fov = THREE.MathUtils.lerp(fly.fromFov, fly.toFov, e);
    camera.updateProjectionMatrix();
    if (t >= 1) { fly = null; controls.enabled = true; }
  }

  controls.update();
  renderer.render(scene, camera);
}
tick();
