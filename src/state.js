// 中央状态 + 轻量事件总线: 各模块通过 on/emit 协作, 避免相互直接依赖。

class EventBus {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.map.get(evt).delete(fn);
  }
  emit(evt, payload) {
    const s = this.map.get(evt);
    if (s) for (const fn of s) fn(payload);
  }
}

export const bus = new EventBus();

// 全局可变状态。修改后调用对应 emit 通知订阅者。
export const state = {
  meta: null,            // metadata.json
  stats: null,           // stats.json
  histograms: null,      // histograms.json
  power: null,           // powerspectrum.json
  morphology: null,      // morphology.json

  step: 0,               // 当前时间步
  playing: false,
  renderMode: 0,         // 0 体渲染 1 MIP 2 等值面 3 top1% 4 void

  // 刷选区间 (归一化 [0,1] 的 log-density)
  brush: { active: false, min: 0, max: 1, label: null },

  // 传递函数
  tf: { densityScale: 0.80, isoValue: 0.40, steps: 256 },

  // 形态学叠加 (Cosmic Atlas); method: 'proxy'(density-Hessian) | 'tweb'(严格 T-web)
  atlas: { active: false, opacity: 0.55, method: "tweb", classes: { sheet: false, filament: true, node: true } },

  // Probe
  probe: { active: false, line: null, beta: 1.6, A: 0.55 },

  // Story network overlay from T-web skeleton graph.
  network: { active: false, step: 99, opacity: 0.82 },

  story: { running: false, chapter: 0 },
};

// 归一化值 <-> log-density 互转
export function normToLog(n) {
  const { globalLogMin, globalLogMax } = state.meta;
  return globalLogMin + n * (globalLogMax - globalLogMin);
}
export function logToNorm(v) {
  const { globalLogMin, globalLogMax } = state.meta;
  return (v - globalLogMin) / (globalLogMax - globalLogMin);
}
