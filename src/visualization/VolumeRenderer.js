// Three.js 体渲染主视图: 透视相机 + OrbitControls + 光线步进 ShaderMaterial。
// 负责场景/相机/交互与 uniform 更新, 并提供探针视线拾取(相机射线∩单位立方体)。
import {
  Scene, PerspectiveCamera, WebGLRenderer, BoxGeometry, Mesh, ShaderMaterial,
  GLSL3, Vector3, Vector2, BackSide, DoubleSide, LineSegments, EdgesGeometry,
  LineBasicMaterial, BufferGeometry, Line, AdditiveBlending,
  Data3DTexture, RedFormat, RGBFormat, FloatType, NearestFilter, UnsignedByteType,
  MeshBasicMaterial, MeshStandardMaterial, AmbientLight, DirectionalLight, BufferAttribute, Float32BufferAttribute,
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35));
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
    this.interactionStepCount = 128;
    this.isInteracting = false;
    this.active = true;
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
      uClassSheet: { value: new Vector3(0.30, 0.55, 0.95) },
      uClassFilament: { value: new Vector3(0.48, 0.58, 1.00) },
      uClassNode: { value: new Vector3(0.95, 0.43, 0.65) },
      uClassVoid: { value: new Vector3(0.10, 0.12, 0.25) },
      uTopLow: { value: new Vector3(0.70, 0.36, 0.76) },
      uTopHigh: { value: new Vector3(0.96, 0.90, 1.00) },
      uHighlight: { value: new Vector3(0.92, 0.88, 1.00) },
      uVoidLow: { value: new Vector3(0.12, 0.18, 0.40) },
      uVoidHigh: { value: new Vector3(0.05, 0.06, 0.16) },
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

    this.cubeInterior = new Mesh(
      new BoxGeometry(1.001, 1.001, 1.001),
      new MeshBasicMaterial({ color: 0xf2f4f8, side: BackSide })
    );
    this.scene.add(this.cubeInterior);

    this.mesh = new Mesh(new BoxGeometry(1, 1, 1), this.material);
    this.scene.add(this.mesh);

    // 包围盒线框(定向参考)
    this.edges = new LineSegments(
      new EdgesGeometry(new BoxGeometry(1, 1, 1)),
      new LineBasicMaterial({ color: 0x2a496f, transparent: true, opacity: 0.5 })
    );
    this.scene.add(this.edges);

    // MC 真实网格(光照渲染)
    this.scene.add(new AmbientLight(0x4a6a9a, 0.9));
    this.keyLight = new DirectionalLight(0xe9ecff, 1.5); this.keyLight.position.set(1, 1.2, 0.8); this.scene.add(this.keyLight);
    this.rimLight = new DirectionalLight(0x7d8cff, 0.7); this.rimLight.position.set(-1, -0.5, -0.8); this.scene.add(this.rimLight);
    this.mcMaterial = new MeshStandardMaterial({
      color: 0xffcc66, metalness: 0.28, roughness: 0.48, side: DoubleSide,
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
  setActive(active) { this.active = active; }
  setControlsEnabled(enabled) { this.controls.enabled = enabled; }
  getCameraPose() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
    };
  }
  setCameraPose(position, target = [0, 0, 0]) {
    this.camera.position.fromArray(position);
    this.controls.target.fromArray(target);
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
  }
  setTheme(theme) {
    this.theme = theme;
    const v = theme.volume;
    this.cubeInterior.material.color.set(v.cubeInterior || "#f2f4f8");
    this.edges.material.color.set(v.edge);
    this.keyLight.color.set(v.key);
    this.rimLight.color.set(v.rim);
    this.mcMaterial.color.set(v.mesh);
    this.mcMaterial.emissive.set(v.emissive);
    if (this.probeLine) this.probeLine.material.color.set(v.probe);
    this.uniforms.uClassSheet.value.fromArray(v.classSheet);
    this.uniforms.uClassFilament.value.fromArray(v.classFilament);
    this.uniforms.uClassNode.value.fromArray(v.classNode);
    this.uniforms.uClassVoid.value.fromArray(v.classVoid);
    this.uniforms.uTopLow.value.fromArray(v.topLow);
    this.uniforms.uTopHigh.value.fromArray(v.topHigh);
    this.uniforms.uHighlight.value.fromArray(v.highlight);
    this.uniforms.uVoidLow.value.fromArray(v.voidLow);
    this.uniforms.uVoidHigh.value.fromArray(v.voidHigh);
  }
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
    this.cubeInterior.visible = !on;
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
    const m = new LineBasicMaterial({ color: this.theme?.volume?.probe || 0x8ea0ff, transparent: true, opacity: 0.95, blending: AdditiveBlending });
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
    if (!this.active) return;
    this.controls.update();
    this.uniforms.uCameraPos.value.copy(this.camera.position);
    this.uniforms.uTime.value = (performance.now() - this.clock0) / 1000;
    if (this.onFrame) this.onFrame();
    this.renderer.render(this.scene, this.camera);
  }
}
