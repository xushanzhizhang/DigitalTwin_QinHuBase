/**
 * 孪生数据绑定（模型版）
 * =====================
 * 把后端推来的 frame 映射到**用户建的 glb 模型**上：
 *
 *   分区气温/湿度/墒情 → 区域标签数值、作物色相
 *   通风/湿帘开度      → 该区域所有排风机叶片转速
 *   外遮阳开度         → 拱形棚膜变暗、变不透（模型里没有独立遮阳网）
 *   分区健康度         → 传感器状态灯颜色
 *
 * 与上一版最大的不同：不再自己造几何，而是驱动模型里已有的构件。
 * 构件靠**模型自身的命名**识别（site.js 已经建立索引），
 * 所以以后模型微调只要命名不变，绑定逻辑不受影响。
 */
import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;

/** 后端分区 → 模型区域 */
export const ZONE_TO_REGION = {
  Z1: 'lake',
  Z2: 'hort',
  Z3: 'peony',
  Z4: 'smart',
  Z5: null,          // 露地苗床：模型里没有独立构件，只在列表里体现
};

/** 健康度 → 颜色 */
function healthColor(h) {
  if (h >= 88) return new THREE.Color('#3ad6c2');
  if (h >= 75) return new THREE.Color('#8fd06a');
  if (h >= 60) return new THREE.Color('#f2b544');
  return new THREE.Color('#f2564d');
}

/* ------------------------------------------------------------------ */
/* 区域范围指示：地面上的一圈柔光 + 四角括号                            */
/* ------------------------------------------------------------------ */
function makeZoneMarker(box, color) {
  const g = new THREE.Group();
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const w = s.x * 1.12, d = s.z * 1.12;

  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const cx = cv.getContext('2d');
  const grd = cx.createRadialGradient(64, 64, 6, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.45)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = grd;
  cx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.14, color,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(c.x, box.min.y + 0.14, c.z);
  glow.renderOrder = 1;
  g.add(glow);

  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false });
  const bl = Math.min(w, d) * 0.13;
  const x0 = c.x - w / 2, x1 = c.x + w / 2, z0 = c.z - d / 2, z1 = c.z + d / 2;
  for (const [x, z, sx, sz] of [
    [x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1],
  ]) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(bl, 0.08, 0.26), mat);
    a.position.set(x + (sx * bl) / 2, box.min.y + 0.18, z);
    g.add(a);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, bl), mat);
    b.position.set(x, box.min.y + 0.18, z + (sz * bl) / 2);
    g.add(b);
  }
  g.userData = { glow, mat };
  return g;
}

/* ------------------------------------------------------------------ */
/* 主体                                                                */
/* ------------------------------------------------------------------ */
export function createBinding({ scene, site, labelLayer }) {
  const labels = new Map();
  const markers = new Map();

  // 只给有实体的四个区域做标签与框线
  for (const [id, region] of site.regions) {
    if (id === 'base') continue;

    const box = region.box;
    const y = box.max.y + (id === 'lake' ? 2.5 : 5.5);
    const item = labelLayer.add({
      pos: new THREE.Vector3(region.center.x, y, region.center.z),
      html: `<span class="t-name">${region.name}</span>
             <span class="t-data"><b data-f="t">--</b>℃&nbsp;
             <b data-f="h">--</b>%&nbsp;
             <b data-f="m">--</b>%</span>`,
      maxDist: 420,
      onClick: () => {
        const zid = Object.keys(ZONE_TO_REGION).find((k) => ZONE_TO_REGION[k] === id);
        if (zid && window.__twinFocusZone) window.__twinFocusZone(zid);
      },
    });
    item.el.dataset.region = id;
    labels.set(id, item);

    const mk = makeZoneMarker(box, new THREE.Color('#3ad6c2'));
    scene.add(mk);
    markers.set(id, mk);
  }

  const tmpColor = new THREE.Color();
  const cropDry = new THREE.Color('#d8c47a');
  const cropWet = new THREE.Color('#c9e6c8');

  function update(frame, agent) {
    const zones = frame.zones || {};

    for (const [zid, regionId] of Object.entries(ZONE_TO_REGION)) {
      if (!regionId) continue;
      const z = zones[zid];
      if (!z) continue;

      const act = z.actuators || {};

      // 通风/湿帘 → 风机转速（0.15 起步，避免"开了但叶片几乎不转"）
      const vent = z.vent_effective ?? act.vent ?? 0;
      const fanPad = act.fan_pad ?? 0;
      const fan = Math.max(vent, fanPad) / 100;
      site.setRegion(regionId, { fan: fan > 0.02 ? 0.25 + fan * 0.75 : 0 });

      // 外遮阳 → 棚膜变暗
      site.setRegion(regionId, { filmShade: clamp((act.shade ?? 0) / 100, 0, 1) });

      // 墒情 → 作物色相
      const cropMeta = z.crop ? window.__crops?.[z.crop] : null;
      const vwc = cropMeta?.vwc;
      if (vwc && typeof z.soil_moisture === 'number') {
        const n = clamp((z.soil_moisture - vwc.wilting) /
          Math.max(1, vwc.field_capacity - vwc.wilting), 0, 1);
        tmpColor.copy(cropDry).lerp(cropWet, clamp(n / 0.55, 0, 1));
        // 归一化到接近 1 的乘子，避免把模型颜色整体改掉
        site.setRegion(regionId, {
          cropTint: new THREE.Color(
            0.86 + tmpColor.r * 0.2,
            0.86 + tmpColor.g * 0.2,
            0.86 + tmpColor.b * 0.2,
          ),
        });
      }

      // 标签
      const it = labels.get(regionId);
      if (it && it.visible) {
        const tEl = it.el.querySelector('[data-f="t"]');
        const hEl = it.el.querySelector('[data-f="h"]');
        const mEl = it.el.querySelector('[data-f="m"]');
        if (tEl) tEl.textContent = z.air_temp?.toFixed(1) ?? '--';
        if (hEl) hEl.textContent = Math.round(z.air_humidity ?? 0);
        if (mEl) mEl.textContent = z.soil_moisture?.toFixed(0) ?? '--';
        const bad = (z.air_temp > (cropMeta?.temp?.opt_max ?? 99) + 2) ||
          (z.soil_moisture < (vwc?.lower ?? 0));
        it.el.classList.toggle('alert', bad);
      }
    }

    site.applyState();

    // 健康度 → 状态灯 + 区域框线
    if (agent?.zones) {
      for (const zc of agent.zones) {
        const regionId = ZONE_TO_REGION[zc.zone];
        if (!regionId) continue;
        const c = healthColor(zc.health);
        site.setRegion(regionId, { lamp: c });
        const mk = markers.get(regionId);
        if (mk) {
          mk.userData.glow.material.color.copy(c);
          mk.userData.glow.material.opacity = 0.08 + ((100 - zc.health) / 100) * 0.2;
          mk.userData.mat.color.copy(c);
        }
      }
      site.applyState();
    }
  }

  function updateNight(env, isNight) {
    // 模型自带的庭院灯：夜里给一点自发光
    if (env.lampMat) env.lampMat.emissiveIntensity = isNight ? 1.6 : 0;
  }

  return { update, updateNight, labels, markers };
}
