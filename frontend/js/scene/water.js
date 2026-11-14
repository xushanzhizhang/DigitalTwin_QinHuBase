/**
 * 水面材质与平面反射
 * ==================
 * 从原 world.js 里抽出来独立成模块：模型换成 glb 之后，程序化的场地不用了，
 * 但水面这套着色器仍然值得保留 —— glb 里的 "Pond water" 是个不透明的青色
 * 平面，一眼假，换成带反射的水才有池塘的感觉。
 */
import * as THREE from 'three';
import { getTextures } from './textures.js';

/* ================================================================== */
/* 水面材质                                                            */
/* ================================================================== */
export function makeWaterMaterial(normalTex) {
  const tex = normalTex || getTextures().waterN;
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uNormal: { value: tex },
      uDeep: { value: new THREE.Color('#29351c') },
      uShallow: { value: new THREE.Color('#5d622e') },
      uSky: { value: new THREE.Color('#9fbcc6') },
      uSun: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunColor: { value: new THREE.Color('#fff3d8') },
      uOpacity: { value: 0.94 },
      uFog: { value: new THREE.Color('#c3d4d6') },
      uFogDensity: { value: 0.0016 },
      uReflection: { value: null },
      uTexMatrix: { value: new THREE.Matrix4() },
      uReflAmt: { value: 0.0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform sampler2D uNormal;
      uniform vec3 uDeep, uShallow, uSky, uSunColor, uFog;
      uniform vec3 uSun;
      uniform float uOpacity, uFogDensity, uReflAmt;
      uniform sampler2D uReflection;
      uniform mat4 uTexMatrix;
      varying vec3 vWorld;

      void main() {
        // 两层波：大尺度风成波 + 小尺度涟漪。波长是米级，不能做成厘米级的噪声，
        // 否则水面会像一张水泥麻面。
        // 波纹推进速度放慢一半：水面是缓慢流动的，快节奏的相位变化在帧间
        // 会把高光"甩"到相邻像素上，看起来就是一串白点。
        vec2 uv1 = vWorld.xz * 0.0125 + vec2(uTime * 0.0040, uTime * 0.0025);
        vec2 uv2 = vWorld.xz * 0.046 - vec2(uTime * 0.0030, uTime * 0.0045);
        vec3 n1 = texture2D(uNormal, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uNormal, uv2).xyz * 2.0 - 1.0;
        vec3 nrm = normalize(vec3(n1.x + n2.x * 0.55, 0.0, n1.y + n2.y * 0.55));

        // 远处必须让波纹"平"下去。
        // 水面的高频法线在远处只占亚像素，逐帧变化就会变成一片跳动的白点
        // （典型的镜面走样）。按距离衰减法线强度与反射扰动，是成本最低的办法。
        float dist = length(cameraPosition - vWorld);
        float near = clamp(1.0 - dist / 190.0, 0.10, 1.0);
        vec3 N = normalize(vec3(nrm.x * 0.050 * near, 1.0, nrm.z * 0.050 * near));

        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);

        // 大尺度水色不匀：藻类、悬浮物
        float murk = texture2D(uNormal, vWorld.xz * 0.0032).b;
        vec3 base = mix(uDeep, uShallow, clamp(0.42 + murk * 0.5 + nrm.x * 0.18, 0.0, 1.0));
        base *= 0.90 + 0.18 * (nrm.x * 0.5 + 0.5);
        vec3 col = mix(base, uSky, 0.03 + fres * 0.22);

        // 太阳镜面高光。
        // 指数给到 900 时，高光只有一两个像素宽，帧间位置抖动就成了"闪白点"。
        // 收到 260 并把强度减半，远处再衰减一次，光路仍然是亮的，但不再抖。
        vec3 H = normalize(uSun + V);
        float spec = pow(max(dot(N, H), 0.0), 90.0);
        // 封顶 + 按距离快速衰减：近处仍有一条光路，远处完全收敛，
        // 不留任何"过曝白点"的可能。
        spec = min(spec, 0.30);
        col += uSunColor * spec * 0.70 * pow(near, 1.5);

        // 平面反射
        if (uReflAmt > 0.001) {
          vec4 rc = uTexMatrix * vec4(vWorld, 1.0);
          // 反射扰动同样按距离收敛，否则远处的倒影会"沸腾"
          vec2 ruv = rc.xy / max(rc.w, 0.0001) + vec2(nrm.x, nrm.z) * 0.008 * near;
          // 4 抽头均值：倒影边缘（岸石、栈桥）对比很强，逐像素采样会跳，
          // 模糊一点点反而更像水面，也顺手把走样压下去了。
          float bs = 0.0040 + 0.0045 * (1.0 - near);
          vec3 refl = texture2D(uReflection, clamp(ruv + vec2( bs,  bs), 0.002, 0.998)).rgb
                    + texture2D(uReflection, clamp(ruv + vec2(-bs,  bs), 0.002, 0.998)).rgb
                    + texture2D(uReflection, clamp(ruv + vec2( bs, -bs), 0.002, 0.998)).rgb
                    + texture2D(uReflection, clamp(ruv + vec2(-bs, -bs), 0.002, 0.998)).rgb;
          refl *= 0.25;
          refl *= vec3(0.42, 0.47, 0.42);
          col = mix(col, refl, clamp((0.06 + fres * 0.42) * uReflAmt, 0.0, 0.58));
        }

        float d = length(cameraPosition - vWorld);
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
        col = mix(col, uFog, clamp(fog, 0.0, 1.0));

        gl_FragColor = vec4(col, uOpacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

/* ================================================================== */
/* 平面反射                                                            */
/* ================================================================== */
export function createReflection(size = 512) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  return {
    rt,
    cam: new THREE.PerspectiveCamera(),
    texMatrix: new THREE.Matrix4(),
    enabled: true,
    hide: [],
    planeY: 0,
  };
}

const _rs = {
  n: new THREE.Vector3(0, 1, 0),
  pp: new THREE.Vector3(),
  camPos: new THREE.Vector3(),
  view: new THREE.Vector3(),
  look: new THREE.Vector3(),
  target: new THREE.Vector3(),
  rot: new THREE.Matrix4(),
};

/** 每帧调用。planeY = 水面高度；hide = 反射时要临时隐藏的物体（水面自己/水下） */
export function updateReflection(renderer, scene, camera, refl, waterMats, planeY) {
  if (!refl || !refl.enabled) return;
  const y = planeY ?? refl.planeY;

  camera.updateMatrixWorld();
  const camPos = _rs.camPos.setFromMatrixPosition(camera.matrixWorld);
  if (camPos.y <= y + 0.06) return;

  const n = _rs.n, pp = _rs.pp.set(0, y, 0);
  const view = _rs.view.subVectors(pp, camPos);
  if (view.dot(n) > 0) return;
  view.reflect(n).negate().add(pp);

  const rot = _rs.rot.extractRotation(camera.matrixWorld);
  const look = _rs.look.set(0, 0, -1).applyMatrix4(rot).add(camPos);
  const target = _rs.target.subVectors(pp, look).reflect(n).negate().add(pp);

  const vc = refl.cam;
  vc.position.copy(view);
  vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
  vc.lookAt(target);
  vc.near = camera.near;
  vc.far = camera.far;
  vc.fov = camera.fov;
  vc.aspect = camera.aspect;
  vc.updateProjectionMatrix();
  vc.updateMatrixWorld();
  vc.matrixWorldInverse.copy(vc.matrixWorld).invert();

  refl.texMatrix.set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0,
  );
  refl.texMatrix.multiply(vc.projectionMatrix);
  refl.texMatrix.multiply(vc.matrixWorldInverse);

  for (const m of refl.hide) { m.userData._vis = m.visible; m.visible = false; }
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(refl.rt);
  renderer.clear();
  renderer.render(scene, vc);
  renderer.setRenderTarget(prevTarget);
  for (const m of refl.hide) m.visible = m.userData._vis;

  for (const mat of waterMats) {
    mat.uniforms.uReflection.value = refl.rt.texture;
    mat.uniforms.uTexMatrix.value.copy(refl.texMatrix);
    mat.uniforms.uReflAmt.value = 1.0;
  }
}
