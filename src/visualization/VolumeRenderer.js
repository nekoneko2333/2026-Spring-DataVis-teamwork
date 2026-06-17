// Three.js 体渲染主视图: 透视相机 + OrbitControls + 光线步进 ShaderMaterial。
// 负责场景/相机/交互与 uniform 更新, 并提供探针视线拾取(相机射线∩单位立方体)。
import {
  Scene, PerspectiveCamera, WebGLRenderer, BoxGeometry, Mesh, ShaderMaterial,
  GLSL3, Vector3, Vector2, BackSide, DoubleSide, LineSegments, EdgesGeometry,
  LineBasicMaterial, BufferGeometry, Line, AdditiveBlending,
  Data3DTexture, RedFormat, RGBFormat, FloatType, NearestFilter, UnsignedByteType,
  MeshStandardMaterial, AmbientLight, DirectionalLight, BufferAttribute, Float32BufferAttribute,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { volumeVert, volumeFrag } from "./shaders.js";

function dummy3D() {
  const t = new Data3DTexture(new Float32Array(1), 1, 1, 1);
  t.format = RedFormat; t.type = FloatType;
  t.minFilter = t.magFilter = NearestFilter;
  t.needsUpdate = true;
  return t;
}

function dummyGradient3D() {
  const t = new Data3DTexture(new Uint8Array([127, 127, 127]), 1, 1, 1);
  t.format = RGBFormat; t.type = UnsignedByteType;
  t.minFilter = t.magFilter = NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class VolumeRenderer {
  constructor(canvas, meta, tfTexture) {
    this.meta = meta;
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    // R32F 线性插值
    this.renderer.getContext().getExtension("OES_texture_float_linear");

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(1.25, 0.95, 1.45);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.8;
    this.controls.minDistance = 0.7;
    this.controls.maxDistance = 6;
    this.baseStepCount = 256;
    this.interactionStepCount = 160;
    this.isInteracting = false;
    this.controls.addEventListener("start", () => {
      this.isInteracting = true;
      this._applyStepCount();
    });
    this.controls.addEventListener("end", () => {
      this.isInteracting = false;
      this._applyStepCount();
    });

    this.uniforms = {
      uVolume: { value: dummy3D() },
      uGradient: { value: dummyGradient3D() },
      uLabel: { value: dummy3D() },
      uTF: { value: tfTexture },
      uCameraPos: { value: new Vector3() },
      uMode: { value: 0 },
      uStepCount: { value: this.baseStepCount },
      uDensityScale: { value: 0.80 },
      uIso: { value: 0.40 },
      uHiClip: { value: 0.78 },
      uLoClip: { value: 0.30 },
      uBrushActive: { value: false },
      uBrushMin: { value: 0 },
      uBrushMax: { value: 1 },
      uGradScale: { value: 1.0 },
      uLightDir: { value: new Vector3(0.6, 0.8, 0.5).normalize() },
      uTime: { value: 0 },
      uAtlasActive: { value: false },
      uAtlasOpacity: { value: 0.55 },
      uClassOn: { value: new Vector3(0, 1, 1) },
    };

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: this.uniforms,
      vertexShader: volumeVert,
      fragmentShader: volumeFrag,
      transparent: true,
      side: BackSide,
      depthWrite: false,
    });

    this.mesh = new Mesh(new BoxGeometry(1, 1, 1), this.material);
    this.scene.add(this.mesh);

    // 包围盒线框(定向参考)
    const edges = new LineSegments(
      new EdgesGeometry(new BoxGeometry(1, 1, 1)),
      new LineBasicMaterial({ color: 0x2a496f, transparent: true, opacity: 0.5 })
    );
    this.scene.add(edges);

    // MC 真实网格(光照渲染)
    this.scene.add(new AmbientLight(0x4a6a9a, 0.9));
    const key = new DirectionalLight(0xfff0d8, 1.5); key.position.set(1, 1.2, 0.8); this.scene.add(key);
    const rim = new DirectionalLight(0x38e1d6, 0.7); rim.position.set(-1, -0.5, -0.8); this.scene.add(rim);
    this.mcMaterial = new MeshStandardMaterial({
      color: 0xffcc66, metalness: 0.35, roughness: 0.45, side: DoubleSide,
      emissive: 0x3a2a08, flatShading: false,
    });
    this.mcMesh = new Mesh(new BufferGeometry(), this.mcMaterial);
    this.mcMesh.visible = false;
    this.scene.add(this.mcMesh);

    // 探针线
    this.probeLine = null;
    this.picking = false;
    this._raycastPlane = new Vector3();
    canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));

    this._resize();
    window.addEventListener("resize", () => this._resize());

    this.clock0 = performance.now();
    this.onFrame = null;
    this._loop();
  }

  setVolumeTexture(t) { this.uniforms.uVolume.value = t; }
  setGradientTexture(t, scale) {
    this.uniforms.uGradient.value = t;
    if (scale != null) this.uniforms.uGradScale.value = scale;
  }
  setLabelTexture(t) { this.uniforms.uLabel.value = t; }
  setTF(t) { this.uniforms.uTF.value = t; }
  setMode(m) { this.uniforms.uMode.value = m; }
  setSteps(s) {
    this.baseStepCount = s;
    this._applyStepCount();
  }
  setDensityScale(s) { this.uniforms.uDensityScale.value = s; }
  setIso(v) { this.uniforms.uIso.value = v; }
  setHiClip(v) { this.uniforms.uHiClip.value = v; }
  setLoClip(v) { this.uniforms.uLoClip.value = v; }
  setBrush(active, min, max) {
    this.uniforms.uBrushActive.value = active;
    this.uniforms.uBrushMin.value = min;
    this.uniforms.uBrushMax.value = max;
  }
  setAtlas(active, opacity, classOn) {
    this.uniforms.uAtlasActive.value = active;
    if (opacity != null) this.uniforms.uAtlasOpacity.value = opacity;
    if (classOn) this.uniforms.uClassOn.value.set(classOn.sheet ? 1 : 0, classOn.filament ? 1 : 0, classOn.node ? 1 : 0);
  }

  // MC 真实三角网格模式
  setMeshMode(on) {
    this.mcMesh.visible = on;
    this.mesh.visible = !on;
  }
  setMesh(positions, indices) {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(positions, 3));
    g.setIndex(new BufferAttribute(indices, 1));
    g.computeVertexNormals();
    const old = this.mcMesh.geometry;
    this.mcMesh.geometry = g;
    if (old) old.dispose();
  }

  // ---- 探针拾取: 相机射线∩立方体 -> 视线弦 ----
  enablePicking(cb) { this.picking = true; this.pickCb = cb; this.canvas.style.cursor = "crosshair"; }
  disablePicking() { this.picking = false; this.canvas.style.cursor = ""; }

  _intersectBox(ro, rd) {
    const bmin = -0.5, bmax = 0.5;
    let tn = -Infinity, tf = Infinity;
    for (const ax of ["x", "y", "z"]) {
      const inv = 1 / rd[ax];
      let t0 = (bmin - ro[ax]) * inv;
      let t1 = (bmax - ro[ax]) * inv;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tn = Math.max(tn, t0); tf = Math.min(tf, t1);
    }
    return tf > Math.max(tn, 0) ? [Math.max(tn, 0), tf] : null;
  }

  _onPointerDown(e) {
    if (!this.picking || e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    );
    const ro = this.camera.position.clone();
    const rd = new Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(ro).normalize();
    const hit = this._intersectBox(ro, rd);
    if (!hit) return;
    const p0 = ro.clone().addScaledVector(rd, hit[0] + 1e-3);
    const p1 = ro.clone().addScaledVector(rd, hit[1] - 1e-3);
    this._drawProbe(p0, p1);
    const uvw0 = p0.clone().addScalar(0.5);
    const uvw1 = p1.clone().addScalar(0.5);
    if (this.pickCb) this.pickCb({ p0, p1, uvw0, uvw1 });
  }

  _drawProbe(p0, p1) {
    if (this.probeLine) { this.scene.remove(this.probeLine); this.probeLine.geometry.dispose(); }
    const g = new BufferGeometry().setFromPoints([p0, p1]);
    const m = new LineBasicMaterial({ color: 0x38e1d6, transparent: true, opacity: 0.95, blending: AdditiveBlending });
    this.probeLine = new Line(g, m);
    this.scene.add(this.probeLine);
  }
  clearProbe() {
    if (this.probeLine) { this.scene.remove(this.probeLine); this.probeLine.geometry.dispose(); this.probeLine = null; }
  }

  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  _applyStepCount() {
    const steps = this.isInteracting
      ? Math.min(this.baseStepCount, this.interactionStepCount)
      : this.baseStepCount;
    this.uniforms.uStepCount.value = steps;
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    this.controls.update();
    this.uniforms.uCameraPos.value.copy(this.camera.position);
    this.uniforms.uTime.value = (performance.now() - this.clock0) / 1000;
    if (this.onFrame) this.onFrame();
    this.renderer.render(this.scene, this.camera);
  }
}
