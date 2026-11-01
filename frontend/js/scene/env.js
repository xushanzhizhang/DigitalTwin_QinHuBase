/**
 * 渲染环境：相机、天空、光照、雨
 * =============================
 * 天空不是一张静态贴图，而是跟着仿真时钟走的：日出日落会变色，
 * 夜里出星空、开路灯，阴雨天压低对比度。
 * 这一层让"数字孪生"和"真实时间"对得上，而不是永远正午。
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* 太阳位置（与后端 physics.py 同一套公式，保证光影与数据一致）           */
/* ------------------------------------------------------------------ */
export function solarPosition(latDeg, doy, hour) {
  const rad = Math.PI / 180;
  const decl = 23.45 * rad * Math.sin(2 * Math.PI * (284 + doy) / 365);
  const phi = latDeg * rad;
  const omega = 15 * (hour - 12) * rad;
  const sinH = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(omega);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinH))) / rad;
  const cosAz = (Math.sin(decl) - Math.sin(elev * rad) * Math.sin(phi)) /
    (Math.cos(elev * rad) * Math.cos(phi) + 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if (omega > 0) az = 360 - az;
  return { elev, az };
}

/* ------------------------------------------------------------------ */
/* 天空穹顶                                                            */
/* ------------------------------------------------------------------ */
function makeSky() {
  const geo = new THREE.SphereGeometry(700, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color('#2e6f9e') },
      uMid: { value: new THREE.Color('#a8c9d6') },
      uBot: { value: new THREE.Color('#dfe9e6') },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunColor: { value: new THREE.Color('#fff0cf') },
      uSunSize: { value: 0.9994 },
      uSunAmt: { value: 1.0 },
      uHaze: { value: 0.0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w;   // 永远贴在最远处
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uMid, uBot, uSunColor;
      uniform vec3 uSunDir;
      uniform float uSunSize, uSunAmt, uHaze;
      varying vec3 vDir;

      void main() {
        float h = clamp(vDir.y, -1.0, 1.0);
        // 三段渐变：地平线 → 中层 → 天顶
        vec3 col = mix(uBot, uMid, smoothstep(-0.05, 0.32, h));
        col = mix(col, uTop, smoothstep(0.22, 0.95, h));

        // 地平线附近的大气雾气
        float hz = exp(-abs(h) * 9.0);
        col = mix(col, uBot, hz * (0.35 + uHaze * 0.5));

        // 太阳光晕
        float d = dot(normalize(vDir), normalize(uSunDir));
        float glow = pow(max(d, 0.0), 26.0) * 0.55 + pow(max(d, 0.0), 4.0) * 0.10;
        col += uSunColor * glow * uSunAmt;
        float disc = smoothstep(uSunSize, 1.0, d);
        col += uSunColor * disc * 2.2 * uSunAmt;

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -1000;
  return m;
}

/* ------------------------------------------------------------------ */
/* 星空                                                                */
/* ------------------------------------------------------------------ */
function makeStars() {
  const N = 1400;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = Math.random(), v = Math.random() * 0.85 + 0.06;
    const theta = u * Math.PI * 2;
    const phi = Math.acos(1 - v);
    const r = 640;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi) * 0.75;
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color: '#dCEAF5', size: 2.2, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -900;
  return p;
}

/* ------------------------------------------------------------------ */
/* 雨                                                                  */
/* ------------------------------------------------------------------ */
function makeRain() {
  const N = 3600;
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 260;
    pos[i * 3 + 1] = Math.random() * 60;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 260;
    vel[i] = 24 + Math.random() * 20;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color: '#cfe6f0', size: 0.42, transparent: true, opacity: 0,
    depthWrite: false, sizeAttenuation: true,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.userData.v = vel;
  return p;
}

/* ------------------------------------------------------------------ */
/* 环境反射贴图                                                        */
/* ------------------------------------------------------------------ */
/**
 * 玻璃、薄膜、水面、镀锌钢这些材质能不能"看起来像真的"，
 * 很大程度上取决于有没有环境反射。这里用一张程序化的等高线天空贴图，
 * 经 PMREM 预卷积后挂到 scene.environment，材质就会自动获得柔和的
 * 天光反射，而不是靠 metalness 硬凑高光。
 */
function makeEnvMap(renderer) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#3f7ba8');
  g.addColorStop(0.30, '#8fb6cd');
  g.addColorStop(0.46, '#cfdfe4');
  g.addColorStop(0.50, '#e8eeea');
  g.addColorStop(0.54, '#93a081');
  g.addColorStop(0.78, '#6b7658');
  g.addColorStop(1.00, '#4a5140');
  c.fillStyle = g;
  c.fillRect(0, 0, 512, 256);
  // 一片暖色高光，模拟太阳那一侧的天空更亮
  const rg = c.createRadialGradient(150, 70, 10, 150, 70, 190);
  rg.addColorStop(0, 'rgba(255,244,214,0.85)');
  rg.addColorStop(1, 'rgba(255,244,214,0)');
  c.fillStyle = rg;
  c.fillRect(0, 0, 512, 200);

  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

/* ------------------------------------------------------------------ */
/* 环境构建                                                            */
/* ------------------------------------------------------------------ */
export function createEnvironment(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
    alpha: false, stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xc3d6da, 0.0012);
  scene.environment = makeEnvMap(renderer);
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.6, 1600);
  // 初始机位只是个占位，加载完模型后由 buildViews() 按实际包围盒重设
  camera.position.set(-120, 90, 130);
  const camTarget = new THREE.Vector3(30, 0, 0);

  /* ---- 天空 ---- */
  const sky = makeSky();
  scene.add(sky);
  const stars = makeStars();
  scene.add(stars);
  const rain = makeRain();
  scene.add(rain);

  /* ---- 光照 ---- */
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -150; sc.right = 150; sc.top = 140; sc.bottom = -140;
  sc.near = 40; sc.far = 560;
  // 关键：改完正交阴影相机的视锥必须手动更新投影矩阵。
  // 少了这一句，投影矩阵还是构造时的默认 ±5 m，整个场地几乎没有阴影，
  // 场景就会呈现"全是环境光"的塑料感。
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.12;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xbcd2de, 0x55603f, 0.42);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xdfeef2, 0.10);
  scene.add(ambient);

  // 补一盏很弱的反向光，避免背光面死黑
  const fill = new THREE.DirectionalLight(0xa8c6d2, 0.22);
  fill.position.set(80, 60, -120);
  scene.add(fill);

  return {
    renderer, scene, camera, camTarget,
    sky, stars, rain, sun, hemi, ambient, fill,
  };
}

/* ------------------------------------------------------------------ */
/* 按仿真时刻更新天空与光照                                             */
/* ------------------------------------------------------------------ */
const _c = h => new THREE.Color(h);

export function updateSky(env, state) {
  const { elev, az } = state;
  const cloud = state.cloud ?? 0.2;
  const rainAmt = state.rain ?? 0;

  // 太阳方向（世界坐标：+X 东，+Z 南，y 上）
  const er = elev * Math.PI / 180;
  const ar = az * Math.PI / 180;
  const sunDir = new THREE.Vector3(
    Math.cos(er) * Math.sin(ar),
    Math.sin(er),
    -Math.cos(er) * Math.cos(ar),
  ).normalize();

  // ---- 颜色随高度角过渡 ----
  const t = THREE.MathUtils.clamp((elev + 6) / 30, 0, 1);       // 0=夜 1=白天
  const dusk = Math.exp(-Math.pow((elev - 3) / 7, 2));          // 日出日落权重

  const nightTop = _c('#050c14'), nightBot = _c('#132530');
  const dayTop = _c('#2a6b99'), dayMid = _c('#8fb7ca'), dayBot = _c('#ccdcd8');
  const duskTop = _c('#2a3f63'), duskMid = _c('#c98a6a'), duskBot = _c('#f2c187');

  const top = nightTop.clone().lerp(dayTop, t);
  const mid = nightBot.clone().lerp(dayMid, t);
  const bot = nightBot.clone().lerp(dayBot, t);
  top.lerp(duskTop, dusk * 0.62);
  mid.lerp(duskMid, dusk * 0.75);
  bot.lerp(duskBot, dusk * 0.8);

  // 云量：整体去饱和、压暗、偏灰
  const gray = new THREE.Color('#8d9ba0');
  top.lerp(gray, cloud * 0.55 * t);
  mid.lerp(gray, cloud * 0.6 * t);
  bot.lerp(gray, cloud * 0.5 * t);

  const u = env.sky.material.uniforms;
  u.uTop.value.copy(top);
  u.uMid.value.copy(mid);
  u.uBot.value.copy(bot);
  u.uSunDir.value.copy(sunDir);
  const sunCol = new THREE.Color('#fff2d4').lerp(new THREE.Color('#ff9a52'), dusk);
  u.uSunColor.value.copy(sunCol);
  u.uSunAmt.value = THREE.MathUtils.clamp(elev / 12, 0, 1);
  u.uHaze.value = Math.min(1, cloud * 0.8 + rainAmt * 0.1);

  // ---- 星空 ----
  env.stars.material.opacity = THREE.MathUtils.clamp(-elev / 8, 0, 1) * (1 - cloud * 0.9);

  // ---- 雾 ----
  const fogCol = bot.clone().lerp(mid, 0.4);
  env.scene.fog.color.copy(fogCol);
  env.scene.fog.density = 0.0011 + cloud * 0.0011 + rainAmt * 0.0004;

  // ---- 太阳光 ----
  const sunUp = elev > 0;
  const intensity = sunUp
    ? THREE.MathUtils.clamp(Math.sin(er) * 3.1, 0.2, 3.1) * (1 - cloud * 0.6)
    : 0;
  env.sun.intensity = intensity;
  env.sun.color.copy(sunCol);
  env.sun.position.copy(sunDir).multiplyScalar(300);
  env.sun.target.position.set(-6, 0, 2);
  env.sun.target.updateMatrixWorld();
  env.sun.castShadow = intensity > 0.25;

  // ---- 环境光 ----
  env.hemi.intensity = 0.13 + 0.30 * t * (1 - cloud * 0.25);
  env.hemi.color.copy(top).lerp(new THREE.Color('#ffffff'), 0.35);
  env.hemi.groundColor.set('#4a5a38');
  env.ambient.intensity = 0.04 + 0.10 * t;
  env.fill.intensity = 0.08 + 0.16 * t;

  // ---- 雨 ----
  const rainOn = rainAmt > 0.3;
  env.rain.material.opacity = rainOn ? Math.min(0.55, 0.12 + rainAmt * 0.022) : 0;
  env.rain.visible = rainOn;

  env.renderer.toneMappingExposure = 0.82 + 0.14 * t;

  return { sunDir, t, dusk };
}

/** 雨滴下落动画（跟随相机，保证视野内始终有雨） */
export function updateRain(env, dt, camera) {
  if (!env.rain.visible) return;
  const pos = env.rain.geometry.attributes.position;
  const vel = env.rain.userData.v;
  const arr = pos.array;
  const cx = camera.position.x, cz = camera.position.z;
  for (let i = 0; i < vel.length; i++) {
    arr[i * 3 + 1] -= vel[i] * dt;
    if (arr[i * 3 + 1] < -2) {
      arr[i * 3 + 1] = 55 + Math.random() * 10;
      arr[i * 3] = cx + (Math.random() - 0.5) * 240;
      arr[i * 3 + 2] = cz + (Math.random() - 0.5) * 240;
    }
  }
  pos.needsUpdate = true;
}
