/**
 * 三维空间的 HTML 标签
 * ===================
 * 用 DOM 而不是 Sprite：文字永远清晰（不受贴图分辨率限制）、可以用 CSS 排版、
 * 点击事件天然可用，对中文界面尤其重要。
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class LabelLayer {
  constructor(container, camera, renderer) {
    this.container = container;
    this.camera = camera;
    this.renderer = renderer;
    this.items = [];
  }

  /**
   * @param {THREE.Vector3} pos   世界坐标
   * @param {string} cls          附加 class
   * @param {function} onClick
   */
  add({ pos, html, cls = '', onClick = null, maxDist = 420, minDist = 0 }) {
    const el = document.createElement('div');
    el.className = `tag3d ${cls}`;
    el.innerHTML = html;
    if (onClick) {
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    }
    this.container.appendChild(el);
    const item = { el, pos: pos.clone(), maxDist, minDist, visible: true };
    this.items.push(item);
    return item;
  }

  remove(item) {
    item.el.remove();
    this.items = this.items.filter(i => i !== item);
  }

  clear() {
    for (const i of this.items) i.el.remove();
    this.items = [];
  }

  /** 每帧更新投影位置 */
  update() {
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const camPos = this.camera.position;

    for (const it of this.items) {
      _v.copy(it.pos).project(this.camera);
      const dist = camPos.distanceTo(it.pos);
      // 相机背后或超出视锥
      const behind = _v.z > 1;
      const out = behind || Math.abs(_v.x) > 1.25 || Math.abs(_v.y) > 1.25;
      const tooFar = dist > it.maxDist;
      const tooNear = dist < it.minDist;

      if (out || tooFar || tooNear) {
        if (it.visible) { it.el.style.opacity = '0'; it.el.style.pointerEvents = 'none'; it.visible = false; }
        continue;
      }
      if (!it.visible) { it.el.style.opacity = '1'; it.el.style.pointerEvents = 'auto'; it.visible = true; }

      const x = (_v.x * 0.5 + 0.5) * w;
      const y = (-_v.y * 0.5 + 0.5) * h;
      it.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      // 远处的标签淡出，避免拥挤
      const fade = THREE.MathUtils.clamp(1 - (dist - it.maxDist * 0.6) / (it.maxDist * 0.4), 0.25, 1);
      it.el.style.opacity = String(fade);
    }
  }
}

/** 传感器脉冲点 */
export class DotLayer {
  constructor(container, camera, renderer) {
    this.container = container;
    this.camera = camera;
    this.renderer = renderer;
    this.items = [];
  }

  add(pos) {
    const el = document.createElement('div');
    el.className = 'sensor-dot';
    this.container.appendChild(el);
    const item = { el, pos: pos.clone() };
    this.items.push(item);
    return item;
  }

  update() {
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    for (const it of this.items) {
      _v.copy(it.pos).project(this.camera);
      if (_v.z > 1) { it.el.style.display = 'none'; continue; }
      const x = (_v.x * 0.5 + 0.5) * w;
      const y = (-_v.y * 0.5 + 0.5) * h;
      it.el.style.display = 'block';
      it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
