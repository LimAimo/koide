// CodeMirror 6 是 Diffusion 的正式编辑器。原生构建与启动脚本会先生成 apps/web/vendor/cm6.js；
// 加载失败必须显式报错，不能静默退回 textarea，否则会把打包问题伪装成“编辑器可用”。

let cached = null;

export function loadCM6() {
  if (!cached) {
    cached = Promise.resolve().then(async () => {
      // 测试环境可以注入同一适配器接口；产品运行时不会设置这个值。
      if (typeof globalThis.__DIFFUSION_CM6_FACTORY__ === "function") return globalThis.__DIFFUSION_CM6_FACTORY__;
      const mod = await import("/vendor/cm6.js");
      if (typeof mod.createCM6Editor !== "function") throw new Error("CodeMirror 6 构建产物缺少 createCM6Editor 导出");
      return mod.createCM6Editor;
    });
  }
  return cached;
}
