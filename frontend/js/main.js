/**
 * 入口：把环境、模型、孪生绑定、界面、实时数据串起来
 *
 * 场景来自《场景图及建模要求/建模/qinhu_base_digital_twin.glb》，
 * 由 site.js 完成材质工程化、静态合并与构件索引；这里只负责编排。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createEnvironment, updateSky, updateRain } from './scene/env.js';
import { loadSite, buildViews } from './scene/site.js';
import { createReflection, updateReflection } from './scene/water.js';
import { LabelLayer, DotLayer } from './scene/labels.js';
import { createBinding, ZONE_TO_REGION } from './twin/binding.js';
import { HUD } from './ui/hud.js';

const canvas = document.getElementById('scene');
const labelHost = document.getElementById('labels');

/* ================================================================== */
/* 1. 渲染环境                                                         */
/* ================================================================== */
const env = createEnvironment(canvas);
const { renderer, scene, camera } = env;

// 调试：从第一帧开始监控白点（仅在带 ?ghost / ?lite 参数时启用，避免影响正常运行）
const _dbgQ = new URLSearchParams(location.search);
if (_dbgQ.has('ghost')) {
  const { attach } = await import('./debug/ghost_probe.js');
  const gTh = Number(_dbgQ.get('gth')) || 225;
  window.__detachGhost = attach(renderer, scene, camera, { threshold: gTh });
}
if (_dbgQ.has('lite')) {
  const { attach } = await import('./debug/lite_probe.js');
  const lTh = Number(_dbgQ.get('lth')) || 245;
  window.__detachLite = attach(renderer, scene, camera, { threshold: lTh });
}
if (_dbgQ.has('trace')) {
  window.__trace = [];
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 12;
controls.maxDistance = 620;
// 允许水平及极轻微俯视（约 91.8°），否则"站在门后水平看"的第一视角
// 会被 update() 钳到 86.8°，相机被抬高、看不到正常的人眼水平视线。
controls.maxPolarAngle = Math.PI * 0.51;
controls.minPolarAngle = 0.10;
controls.panSpeed = 0.8;
controls.zoomSpeed = 0.9;
controls.screenSpacePanning = false;

/* ================================================================== */
/* 2. 界面                                                             */
/* ================================================================== */
let ws = null;

const hud = new HUD({
  onCommand: (cmd) => send(cmd),
  onFocusZone: (zid) => focusZone(zid),
});

/* ================================================================== */
/* 3. 场景                                                             */
/* ================================================================== */
let site = null;
let views = null;
let refl = null;
let binding = null;
let siteData = null;

const labelLayer = new LabelLayer(labelHost, camera, renderer);
const dotLayer = new DotLayer(labelHost, camera, renderer);

function fatal(stageName, err) {
  const el = document.getElementById('loader-text');
  const bar = document.getElementById('loader-bar');
  if (el) {
    el.innerHTML = `<span style="color:#f2564d">构建失败：${stageName}</span><br>
      <span style="font-size:11px;color:#8fb3b2">${String((err && err.message) || err)}</span><br>
      <span style="font-size:11px;color:#5c7f80">按 F12 打开控制台查看完整堆栈</span>`;
  }
  if (bar) bar.style.background = '#f2564d';
}

/* ================================================================== */
/* 4. 相机运动                                                         */
/* ================================================================== */
let fly = null;

function flyTo(pos, target, fov = null, dur = 1300) {
  fly = {
    t0: performance.now(), dur,
    fromPos: camera.position.clone(),
    toPos: new THREE.Vector3(...pos),
    fromTar: controls.target.clone(),
    toTar: new THREE.Vector3(...target),
    fromFov: camera.fov,
    toFov: fov ?? camera.fov,
  };
  controls.enabled = false;
}

function updateFly(now) {
  if (!fly) return;
  const t = Math.min(1, (now - fly.t0) / fly.dur);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  window.__lastFlyT = { t0: fly.t0, dur: fly.dur, t, e, now };
  camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
  controls.target.lerpVectors(fly.fromTar, fly.toTar, e);
  camera.fov = THREE.MathUtils.lerp(fly.fromFov, fly.toFov, e);
  camera.updateProjectionMatrix();
  if (t >= 1) {
    fly = null;
    controls.enabled = true;
  }
}

/** 聚焦某个分区：按模型里该区域的实际包围盒取机位 */
function focusZone(zid) {
  hud.selectZone(zid);
  const regionId = ZONE_TO_REGION[zid];
  const region = regionId ? site?.regions.get(regionId) : null;

  if (region) {
    const c = region.center;
    const s = region.size;
    const d = Math.max(s.x, s.z) * 0.95 + 14;
    flyTo(
      [c.x - d * 0.55, Math.max(14, s.y * 2.2 + 10), c.z + d * 0.78],
      [c.x, region.focus.y, c.z], 44, 1200,
    );
  } else if (views) {
    const v0 = views.entry || views.overview;
    flyTo(v0.pos, v0.target, v0.fov, 1200);
  }
  hud.showZone(zid);
}

window.__twinFocusZone = focusZone;
window.__twinView = (name) => {
  const v = views && views[name];
  if (v) flyTo(v.pos, v.target, v.fov, 1500);
  if (name === 'overview') hud.closeDrawer();
};

/* ================================================================== */
/* 5. 实时数据                                                         */
/* ================================================================== */
function send(cmd) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(cmd));
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => hud.setConnection('ok', '已连接');
  ws.onclose = () => {
    hud.setConnection('bad', '连接断开，3 秒后重连');
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => hud.setConnection('bad', '连接异常');
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'frame') {
      latestFrame = msg;
      hud.updateFrame(msg);
      window.__latestFrame = msg;
    } else if (msg.type === 'agent') {
      latestAgent = msg.agent;
      hud.updateAgent(msg.agent);
    }
  };
}

let latestFrame = null;
let latestAgent = null;

/* ================================================================== */
/* 6. 首屏加载                                                         */
/* ================================================================== */
async function boot() {
  try {
    hud.setLoader(8, '正在载入基地模型…');
    site = await loadSite(scene, {
      onProgress: (p) => hud.setLoader(8 + p * 50, `正在载入基地模型… ${Math.round(p * 100)}%`),
    });
    views = buildViews(site);

    hud.setLoader(62, '正在准备水面与反射…');
    refl = createReflection(512);
    refl.planeY = site.waterY;
    if (site.water) refl.hide.push(site.water.mesh);

    // 初始相机直接落在大门第一视角（自东向西），不再先放到高空再俯冲，
    // 避免白色灯头/高光在俯冲过渡中沿屏幕快速划过，形成"一闪而过的白点"。
    const firstView = views.entry || views.overview;
    camera.position.set(...firstView.pos);
    controls.target.set(...firstView.target);
    camera.fov = firstView.fov;
    camera.updateProjectionMatrix();

    hud.setLoader(70, '正在读取基地配置…');
    const r = await fetch('/api/site');
    siteData = await r.json();
    hud.setSite(siteData);

    binding = createBinding({ scene, site, labelLayer });
    hud.setLoader(88, '正在接入实时数据…');
  } catch (e) {
    console.error('[twin] 启动失败', e);
    fatal('模型或配置加载', e);
  }

  connectWS();
  hud.refreshChart();
  setInterval(() => hud.refreshChart(), 60000);

  hud.setLoader(100, '场景就绪');
  setTimeout(() => hud.hideLoader(), 400);

  // 加载完成后不再做高空→大门的 flyTo 过渡：相机已在上面直接定位到大门视角，
  // 遮罩淡出后即为静止的第一视角，杜绝白点飞掠。flyTo 函数保留，
  // 分区定位（focusZone）与底部视角切换按钮仍在使用它。

  console.log('[twin] 场景就绪', {
    区域: site ? [...site.regions.keys()] : [],
    合并对象: site?.mergedCount,
    风机: site?.fans.length,
  });
}

/* ================================================================== */
/* 7. 渲染循环                                                         */
/* ================================================================== */
const clock = new THREE.Clock();
let waterTime = 0;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, clock.getDelta());
  const now = performance.now();

  const _tr = window.__trace;
  const _b0 = _tr ? camera.position.toArray() : null;
  const _flyActive = !!fly;

  updateFly(now);
  const _b1 = _tr ? camera.position.toArray() : null;
  const _t1 = _tr ? controls.target.toArray() : null;

  controls.update();
  const _b2 = _tr ? camera.position.toArray() : null;
  if (_tr) {
    _tr.push({
      now: Math.round(now),
      fly: _flyActive,
      flyT: window.__lastFlyT ? {t0: Math.round(window.__lastFlyT.t0), dur: window.__lastFlyT.dur, t: Number(window.__lastFlyT.t.toFixed(3)), e: Number(window.__lastFlyT.e.toFixed(3))} : null,
      b0: _b0.map(v => Math.round(v)),
      b1: _b1.map(v => Math.round(v)),
      b2: _b2.map(v => Math.round(v)),
      t1: _t1.map(v => Math.round(v)),
      up: camera.up.toArray().map(v => v.toFixed(2)),
    });
  }

  if (latestFrame) {
    const e = latestFrame.env;
    updateSky(env, {
      elev: e.solar_elevation,
      az: e.solar_azimuth,
      cloud: e.cloud,
      rain: e.rain,
    });
    if (binding) binding.updateNight(env, e.solar_elevation <= 0);
    updateRain(env, dt, camera);
  }

  if (site) {
    if (site.water) {
      waterTime += dt;
      const m = site.water.mat;
      m.uniforms.uTime.value = waterTime;
      m.uniforms.uSun.value.copy(env.sun.position).normalize();
      m.uniforms.uSunColor.value.copy(env.sun.color);
      m.uniforms.uFog.value.copy(scene.fog.color);
      m.uniforms.uFogDensity.value = scene.fog.density;
    }
    site.update(dt);
    updateReflection(renderer, scene, camera, refl,
      site.water ? [site.water.mat] : [], site.waterY);
  }

  if (binding && latestFrame) binding.update(latestFrame, latestAgent);

  labelLayer.update();
  dotLayer.update();

  renderer.render(scene, camera);
}

boot();
animate();

// 调试钩子：暴露运行时对象，供浏览器控制台/CDP 排查（与 model.html 一致）
window.__model = {
  renderer, scene, camera, env, controls,
  get site() { return site; },
  get views() { return views; },
  get refl() { return refl; },
  get binding() { return binding; },
};
window.__THREE = THREE;
