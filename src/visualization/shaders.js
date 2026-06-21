// WebGL2 (GLSL ES 3.00) 鍏夌嚎姝ヨ繘浣撴覆鏌撶潃鑹插櫒銆?
// 3D 绾圭悊瀛樺綊涓€鍖?log-density; 鏀寔 浣撴覆鏌?MIP/绛夊€奸潰/top楂樹寒/void 浜旀ā寮?
// 姊害鍏夌収銆佺浉绌洪棿鍒烽€夐棬鎺с€丆osmic Atlas 褰㈡€佸鍙犲姞銆?

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
uniform float uHiClip;        // top 楂樹寒闃堝€?(褰掍竴鍖?
uniform float uLoClip;        // void 闃堝€?
uniform bool  uBrushActive;
uniform float uBrushMin;
uniform float uBrushMax;
uniform float uBrushBoost;
uniform float uGradScale;
uniform vec3  uLightDir;
uniform float uTime;

uniform bool  uAtlasActive;
uniform float uAtlasOpacity;
uniform vec3  uClassSheet;
uniform vec3  uClassFilament;
uniform vec3  uClassNode;
uniform vec3  uClassVoid;
uniform vec3  uTopLow;
uniform vec3  uTopHigh;
uniform vec3  uHighlight;
uniform vec3  uVoidLow;
uniform vec3  uVoidHigh;
uniform vec3  uClassOn;        // sheet, filament, node 寮€鍏?1/0)

const vec3 BMIN = vec3(-0.5);
const vec3 BMAX = vec3(0.5);
const int  MAX_STEPS = 1024;
const int  SHADOW_STEPS = 4;
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

// 褰㈡€佸绫诲埆棰滆壊
vec3 classColor(int c) {
  if (c == 1) return uClassSheet;
  if (c == 2) return uClassFilament;
  if (c == 3) return uClassNode;
  return uClassVoid;
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

    // ---------- 绛夊€奸潰 ----------
    if (uMode == 2) {
      if (d >= uIso) {
        vec3 N = normalize(-gradient(uvw) + 1e-6);
        vec3 V = normalize(uCameraPos - pos);
        vec3 H = normalize(L + V);
        float diff = clamp(dot(N, L), 0.0, 1.0);
        float spec = pow(clamp(dot(N, H), 0.0, 1.0), 32.0);
        float rim = pow(1.0 - abs(dot(N, V)), 2.0);
        vec3 base = texture(uTF, vec2(uIso, 0.5)).rgb;
        col = base * (0.24 + 1.18 * diff) + vec3(1.0) * (spec * 1.12 + rim * 0.38);
        alpha = 1.0;
        break;
      }
      t += dt; continue;
    }

    // ---------- top 楂樹寒 ----------
    if (uMode == 3) {
      if (d >= uHiClip) {
        float k = clamp((d - uHiClip) / max(1.0 - uHiClip, 1e-3), 0.0, 1.0);
        vec3 glow = mix(uTopLow, uTopHigh, k);
        vec3 N = normalize(-gradient(uvw) + 1e-6);
        float diff = 0.5 + 0.5 * clamp(dot(N, L), 0.0, 1.0);
        float a = (0.12 + 0.55 * k);
        a = 1.0 - pow(1.0 - clamp(a, 0.0, 1.0), dt * 256.0);
        col += (1.0 - alpha) * a * glow * (0.55 + 1.35 * diff) * (2.15 + 1.8 * k);
        alpha += (1.0 - alpha) * a;
      }
      t += dt; continue;
    }

    // ---------- void ----------
    if (uMode == 4) {
      if (d <= uLoClip) {
        float k = clamp((uLoClip - d) / max(uLoClip, 1e-3), 0.0, 1.0);
        float shell = smoothstep(0.05, 1.0, k);
        vec3 mist = mix(uVoidLow, uVoidHigh, shell);
        float a = 0.040 + 0.125 * shell;
        col += (1.0 - alpha) * a * mist * (0.85 + 1.35 * shell);
        alpha += (1.0 - alpha) * a;
      }
      t += dt; continue;
    }

    // ---------- 浣撴覆鏌?(mode 0) ----------
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
    float brushBoost = (uBrushActive && gate > 0.0) ? uBrushBoost : 1.0;
    float sampleOpacity = clamp(src.a * uDensityScale * brushBoost, 0.0, 1.0);
    float shadow = 1.0;
    if (gate > 0.0 && sampleOpacity > 0.03 && max(diff, spec * src.a) > 0.02) {
      shadow = shadowTransmittance(pos, stepLen, L);
    }

    float densityGlow = smoothstep(0.54, 1.0, d);
    float rim = pow(1.0 - abs(dot(N, V)), 2.0);
    vec3 ambient = src.rgb * 0.12;
    vec3 direct = src.rgb * (0.72 * diff);
    vec3 glowTerm = src.rgb * densityGlow * (0.66 + 1.25 * densityGlow);
    vec3 rimTerm = src.rgb * rim * (0.18 + 0.58 * densityGlow);
    vec3 highlight = uHighlight * spec * (0.24 + 0.62 * densityGlow) * src.a;
    vec3 lit = ambient + shadow * (direct + highlight) + glowTerm + rimTerm;
    if (uAtlasActive && atlasClass >= 1 && atlasOn) {
      lit = mix(lit, atlasColor * (0.20 + shadow * (0.35 + 0.65 * diff)), uAtlasOpacity);
    }

    float a = 1.0 - pow(1.0 - sampleOpacity, stepLen * 256.0);
    a *= gate;
    lit *= mix(1.0, 1.28, clamp(brushBoost - 1.0, 0.0, 1.0));
    col += (1.0 - alpha) * a * lit;
    alpha += (1.0 - alpha) * a;
    t += stepLen;
  }

  if (uMode == 1) {
    if (maxd <= 0.001) { outColor = vec4(0.0); return; }
    float k = smoothstep(0.18, 0.96, maxd);
    vec3 tf = texture(uTF, vec2(maxd, 0.5)).rgb;
    vec3 base = mix(vec3(0.015, 0.018, 0.026), tf, 0.76);
    vec3 c = pow(max(base, vec3(0.0)), vec3(1.16)) * (0.18 + 0.95 * k);
    c += vec3(0.95, 0.98, 1.0) * pow(k, 4.0) * 0.20;
    outColor = vec4(c, 0.32 + 0.68 * k);
    return;
  }

  vec3 finalCol = pow(max(col * 1.18, vec3(0.0)), vec3(0.86));
  outColor = vec4(finalCol, alpha);
}
`;
