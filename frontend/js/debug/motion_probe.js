/**
 * 运动监测器（白点排查用）
 * 每帧记录所有可见对象的世界包围盒中心，检测单帧位移异常大的对象，
 * 把"从地面快速移动到天空"的对象及其轨迹抓出来。
 *
 * 用法：
 *   const mp = await import('/js/debug/motion_probe.js');
 *   mp.start(); ... mp.stop(); mp.data();
 */
import * as THREE from 'three';

let running = false;
let origRender = null;

const data = {
  frames: 0,
  jumpThreshold: 1.5,        // 单帧中心位移超过该值（米）即记录
  movers: [],                // 异常对象轨迹
  centers: new Map(),        // uuid -> 上一帧中心
};

function snapshot(scene) {
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return;
    if (!o.visible) return;
    const bb = new THREE.Box3().setFromObject(o);
    if (bb.isEmpty()) return;
    const c = bb.getCenter(new THREE.Vector3());
    out.push({ o, c });
  });
  return out;
}

export function start(renderer, scene) {
  if (running) return data;
  const r = renderer || window.__model.renderer;
  const s = scene || window.__model.scene;
  origRender = r.render.bind(r);
  running = true;
  data.centers.clear();
  data.movers = [];

  r.render = function (sc, cam) {
    origRender(sc, cam);
    data.frames++;
    const cur = snapshot(s);
    const seen = new Set();
    for (const { o, c } of cur) {
      seen.add(o.uuid);
      const prev = data.centers.get(o.uuid);
      if (prev) {
        const d = c.distanceTo(prev);
        if (d > data.jumpThreshold) {
          data.movers.push({
            frame: data.frames,
            name: o.name || '(unnamed)',
            uuid: o.uuid,
            type: o.type,
            from: prev.toArray().map((v) => +v.toFixed(2)),
            to: c.toArray().map((v) => +v.toFixed(2)),
            jump: +d.toFixed(2),
          });
          if (data.movers.length > 400) data.movers.shift();
        }
      }
      data.centers.set(o.uuid, c.clone());
    }
    // 清除已消失对象
    for (const k of Array.from(data.centers.keys())) {
      if (!seen.has(k)) data.centers.delete(k);
    }
  };
  return data;
}

export function stop() {
  if (!running) return;
  const r = window.__model.renderer;
  r.render = origRender;
  running = false;
}

export function result() {
  return data;
}
