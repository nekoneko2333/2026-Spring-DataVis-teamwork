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
uniform sampler3D uGradient;
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
uniform float uGradScale;
uniform vec3  uLightDir;
uniform float uTime;

uniform bool  uAtlasActive;
uniform float uAtlasOpacity;
uniform vec3  uClassOn;        // sheet, filament, node 开关(1/0)

const vec3 BMIN = vec3(-0.5);
const vec3 BMAX = vec3(0.5);
const int  MAX_STEPS = 1024;
const int  SHADOW_STEPS = 6;
const float TF_BIN = 1.0 / 255.0;
const float ADAPTIVE_MIN_SCALE = 0.5;
const float ADAPTIVE_MAX_SCALE = 1.75;
const float SHADOW_STEP_SCALE = 3.0;
const float SHADOW_DENSITY_SCALE = 1.15;

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
  return (texture(uGradient, uvw).xyz * (255.0 / 127.0) - 1.0) * uGradScale;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

float adaptiveStep(float baseDt, float sampleAlpha, vec3 grad, vec3 rayDir) {
  float predictedDelta = abs(dot(grad, rayDir)) * baseDt;
  float variationTerm = smoothstep(2.0 * TF_BIN, 10.0 * TF_BIN, predictedDelta);
  float opacityTerm = clamp(sampleAlpha * uDensityScale, 0.0, 1.0);
  float refine = max(variationTerm, opacityTerm);
  return baseDt * mix(ADAPTIVE_MAX_SCALE, ADAPTIVE_MIN_SCALE, refine);
}

float shadowTransmittance(vec3 pos, float stepLen, vec3 lightDir) {
  vec2 lightHit = intersectBox(pos + lightDir * 1e-3, lightDir);
  float tLightEnd = lightHit.y;
  if (tLightEnd <= 0.0) return 1.0;

  float shadowDt = stepLen * SHADOW_STEP_SCALE;
  float tShadow = shadowDt;
  float trans = 1.0;

  for (int j = 0; j < SHADOW_STEPS; j++) {
    if (tShadow >= tLightEnd || trans <= 0.03) break;
    vec3 shadowPos = pos + lightDir * tShadow;
    vec3 shadowUVW = shadowPos + 0.5;
    float shadowDensity = sampleVol(shadowUVW);
    float shadowAlpha = texture(uTF, vec2(shadowDensity, 0.5)).a;
    if (shadowAlpha <= 0.003) {
      tShadow += shadowDt;
      continue;
    }
    float stepAlpha = 1.0 - pow(
      1.0 - clamp(shadowAlpha * uDensityScale * SHADOW_DENSITY_SCALE, 0.0, 1.0),
      shadowDt * 256.0
    );
    trans *= (1.0 - stepAlpha);
    tShadow += shadowDt;
  }

  return clamp(trans, 0.0, 1.0);
}

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
  float maxIter = (uMode == 0)
    ? min(float(MAX_STEPS), ceil(steps / ADAPTIVE_MIN_SCALE))
    : min(float(MAX_STEPS), steps);

  vec3 L = normalize(uLightDir);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float maxd = 0.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= maxIter || t >= tEnd || alpha > 0.992) break;
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

    vec3 grad = gradient(uvw);
    vec3 N = normalize(-grad + vec3(1e-6));
    vec3 V = normalize(uCameraPos - pos);
    vec3 H = normalize(L + V);
    float diff = clamp(dot(N, L), 0.0, 1.0);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), 34.0);
    int atlasClass = 0;
    vec3 atlasColor = vec3(0.0);
    bool atlasOn = false;
    float atlasBoost = 0.0;

    if (uAtlasActive) {
      atlasClass = int(texture(uLabel, uvw).r + 0.5);
      atlasColor = classColor(atlasClass);
      atlasOn = true;
      if (atlasClass == 1) { atlasOn = uClassOn.x > 0.5; atlasBoost = 0.2; }
      else if (atlasClass == 2) { atlasOn = uClassOn.y > 0.5; atlasBoost = 0.8; }
      else if (atlasClass == 3) { atlasOn = uClassOn.z > 0.5; atlasBoost = 1.6; }
      if (atlasClass >= 1) {
        if (atlasOn) { src.a *= (1.0 + atlasBoost); }
        else { src.a *= 0.03; }
      }
    }

    float stepLen = min(adaptiveStep(dt, src.a, grad, rd), tEnd - t);
    float sampleOpacity = clamp(src.a * uDensityScale, 0.0, 1.0);
    float shadow = 1.0;
    if (gate > 0.0 && sampleOpacity > 0.03 && max(diff, spec * src.a) > 0.02) {
      shadow = shadowTransmittance(pos, stepLen, L);
    }

    vec3 ambient = src.rgb * 0.16;
    vec3 direct = src.rgb * (0.64 * diff);
    vec3 highlight = vec3(0.98, 0.93, 0.82) * spec * 0.16 * src.a;
    vec3 lit = ambient + shadow * (direct + highlight);
    if (uAtlasActive && atlasClass >= 1 && atlasOn) {
      lit = mix(lit, atlasColor * (0.20 + shadow * (0.35 + 0.65 * diff)), uAtlasOpacity);
    }

    float a = 1.0 - pow(1.0 - sampleOpacity, stepLen * 256.0);
    a *= gate;
    col += (1.0 - alpha) * a * lit;
    alpha += (1.0 - alpha) * a;
    t += stepLen;
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
