// WebGL2 (GLSL ES 3.00) 光线步进体渲染着色器。
// 3D 纹理存归一化 log-density; 支持 体渲染/MIP/等值面/top高亮/void 五模式,
// 梯度光照、相空间刷选门控、Cosmic Atlas 形态学叠加。

export const volumeVert = /* glsl */ `
out vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const volumeFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec3 vWorldPos;
out vec4 outColor;

uniform sampler3D uVolume;
uniform sampler3D uLabel;
uniform sampler2D uTF;

uniform vec3  uCameraPos;
uniform int   uMode;          // 0 vol 1 mip 2 iso 3 top 4 void
uniform float uStepCount;
uniform float uDensityScale;
uniform float uIso;
uniform float uHiClip;        // top 高亮阈值 (归一化)
uniform float uLoClip;        // void 阈值
uniform bool  uBrushActive;
uniform float uBrushMin;
uniform float uBrushMax;
uniform float uGradEps;
uniform vec3  uLightDir;
uniform float uTime;

uniform bool  uAtlasActive;
uniform float uAtlasOpacity;
uniform vec3  uClassOn;        // sheet, filament, node 开关(1/0)

const vec3 BMIN = vec3(-0.5);
const vec3 BMAX = vec3(0.5);
const int  MAX_STEPS = 512;

vec2 intersectBox(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (BMIN - ro) * inv;
  vec3 t1 = (BMAX - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(tn, tf);
}

float sampleVol(vec3 uvw) { return texture(uVolume, uvw).r; }

vec3 gradient(vec3 uvw) {
  float e = uGradEps;
  float dx = texture(uVolume, uvw + vec3(e,0,0)).r - texture(uVolume, uvw - vec3(e,0,0)).r;
  float dy = texture(uVolume, uvw + vec3(0,e,0)).r - texture(uVolume, uvw - vec3(0,e,0)).r;
  float dz = texture(uVolume, uvw + vec3(0,0,e)).r - texture(uVolume, uvw - vec3(0,0,e)).r;
  return vec3(dx, dy, dz);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

// 形态学类别颜色
vec3 classColor(int c) {
  if (c == 1) return vec3(0.30, 0.55, 0.95);   // sheet 蓝
  if (c == 2) return vec3(0.35, 0.95, 0.85);   // filament 青
  if (c == 3) return vec3(1.00, 0.82, 0.35);   // node 金
  return vec3(0.10, 0.12, 0.25);               // void
}

void main() {
  vec3 ro = uCameraPos;
  vec3 rd = normalize(vWorldPos - uCameraPos);
  vec2 hit = intersectBox(ro, rd);
  float tStart = max(hit.x, 0.0);
  float tEnd = hit.y;
  if (tEnd <= tStart) { outColor = vec4(0.0); return; }

  float steps = uStepCount;
  float dt = (tEnd - tStart) / steps;
  float jitter = hash(gl_FragCoord.xy) * dt;
  float t = tStart + jitter;

  vec3 L = normalize(uLightDir);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float maxd = 0.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= steps || alpha > 0.992) break;
    vec3 pos = ro + rd * t;
    vec3 uvw = pos + 0.5;
    float d = sampleVol(uvw);

    // ---------- MIP ----------
    if (uMode == 1) {
      float gate = (!uBrushActive || (d >= uBrushMin && d <= uBrushMax)) ? 1.0 : 0.0;
      maxd = max(maxd, d * gate);
      t += dt; continue;
    }

    // ---------- 等值面 ----------
    if (uMode == 2) {
      if (d >= uIso) {
        vec3 N = normalize(-gradient(uvw) + 1e-6);
        vec3 V = normalize(uCameraPos - pos);
        vec3 H = normalize(L + V);
        float diff = clamp(dot(N, L), 0.0, 1.0);
        float spec = pow(clamp(dot(N, H), 0.0, 1.0), 32.0);
        vec3 base = texture(uTF, vec2(uIso, 0.5)).rgb;
        col = base * (0.30 + 0.8 * diff) + vec3(0.9, 0.95, 1.0) * spec * 0.6;
        alpha = 1.0;
        break;
      }
      t += dt; continue;
    }

    // ---------- top 高亮 ----------
    if (uMode == 3) {
      if (d >= uHiClip) {
        float k = clamp((d - uHiClip) / max(1.0 - uHiClip, 1e-3), 0.0, 1.0);
        vec3 glow = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.97, 0.85), k);
        vec3 N = normalize(-gradient(uvw) + 1e-6);
        float diff = 0.5 + 0.5 * clamp(dot(N, L), 0.0, 1.0);
        float a = (0.12 + 0.55 * k);
        a = 1.0 - pow(1.0 - clamp(a, 0.0, 1.0), dt * 256.0);
        col += (1.0 - alpha) * a * glow * (0.6 + 0.7 * diff) * (1.3 + k);
        alpha += (1.0 - alpha) * a;
      }
      t += dt; continue;
    }

    // ---------- void ----------
    if (uMode == 4) {
      if (d <= uLoClip) {
        float k = clamp((uLoClip - d) / max(uLoClip, 1e-3), 0.0, 1.0);
        vec3 mist = mix(vec3(0.12, 0.18, 0.40), vec3(0.05, 0.06, 0.16), k);
        float a = 0.018 + 0.05 * k;
        col += (1.0 - alpha) * a * mist;
        alpha += (1.0 - alpha) * a;
      }
      t += dt; continue;
    }

    // ---------- 体渲染 (mode 0) ----------
    float gate = 1.0;
    if (uBrushActive && (d < uBrushMin || d > uBrushMax)) gate = 0.0;
    vec4 src = texture(uTF, vec2(d, 0.5));

    vec3 N = normalize(-gradient(uvw) + 1e-6);
    vec3 V = normalize(uCameraPos - pos);
    vec3 H = normalize(L + V);
    float diff = clamp(dot(N, L), 0.0, 1.0);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), 28.0);
    vec3 lit = src.rgb * (0.32 + 0.85 * diff) + vec3(0.85, 0.92, 1.0) * spec * 0.35 * src.a;

    if (uAtlasActive) {
      int c = int(texture(uLabel, uvw).r + 0.5);
      vec3 cc = classColor(c);
      bool on = true; float boost = 0.0;
      if (c == 1) { on = uClassOn.x > 0.5; boost = 0.2; }
      else if (c == 2) { on = uClassOn.y > 0.5; boost = 0.8; }
      else if (c == 3) { on = uClassOn.z > 0.5; boost = 1.6; }
      if (c >= 1) {
        if (on) { lit = mix(lit, cc * (0.5 + 0.8 * diff), uAtlasOpacity); src.a *= (1.0 + boost); }
        else { src.a *= 0.03; }
      }
    }

    float a = 1.0 - pow(1.0 - clamp(src.a * uDensityScale, 0.0, 1.0), dt * 256.0);
    a *= gate;
    col += (1.0 - alpha) * a * lit;
    alpha += (1.0 - alpha) * a;
    t += dt;
  }

  if (uMode == 1) {
    if (maxd <= 0.001) { outColor = vec4(0.0); return; }
    vec3 c = texture(uTF, vec2(maxd, 0.5)).rgb;
    c = pow(c, vec3(0.85)) * (0.6 + 1.1 * maxd);
    outColor = vec4(c, 1.0);
    return;
  }

  outColor = vec4(col, alpha);
}
`;
