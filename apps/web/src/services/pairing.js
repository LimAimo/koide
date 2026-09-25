// 扫码配对：电脑上显示的二维码里是 http://电脑地址:端口/#pair=6位配对码。
// 手机扫码打开后，页面读到 #pair=…，自动向桥接服务换取设备令牌并连接。

import { runtime } from "./runtime/index.js";

export function parsePairHash(hash) {
  const m = /(?:^|[#&])pair=(\d{6})(?:&|$)/.exec(hash || "");
  return m ? m[1] : null;
}

/** 如果当前地址带有配对码就完成配对，返回连接目标；没有配对码返回 null。 */
export async function pairFromLocation(loc, connect, deviceName = "手机或平板") {
  const code = parsePairHash(loc.hash);
  if (!code) return null;
  const tls = loc.protocol === "https:";
  const target = { host: loc.hostname, port: Number(loc.port) || (tls ? 443 : 80), tls };
  const token = await runtime.remote.pair(target, code, deviceName);
  await connect({ ...target, token });
  return target;
}
