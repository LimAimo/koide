// 导入 / 导出。本地模式下的「上传」是把浏览器里选的文件复制进项目，「下载」是把文件或文件夹打成 zip。
// 大文件走事务式写入：分块上传、校验字节数和 SHA-256，提交之前原文件不会被替换。

import { toast } from "./dom.js";
import { confirmDialog } from "./overlays.js";
import { runtime, events } from "../services/app.js";
import { sha256Hex } from "../services/sha256.js";

const CHUNK = 192 * 1024;

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}

async function uploadOne(file, dest) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const cur = await runtime.files.hash({ path: dest }).catch(() => ({ revision: "absent" }));
  if (cur.revision !== "absent" && !(await confirmDialog({ title: `覆盖 ${file.name}？`, message: "目标位置已经有同名文件，导入后会替换它，原来的内容无法恢复。", confirmLabel: "覆盖", danger: true }))) return false;
  const { write_id } = await runtime.files.beginWrite({ path: dest, base_revision: cur.revision });
  try {
    for (let i = 0, seq = 0; ; i += CHUNK, seq++) {
      await runtime.files.writeChunk({ write_id, seq, data: b64(buf.subarray(i, i + CHUNK)), encoding: "base64" });
      if (i + CHUNK >= buf.length) break;
    }
    await runtime.files.commitWrite({ write_id, total_bytes: buf.length, sha256: await sha256Hex(buf) });
  } catch (e) {
    await runtime.files.abortWrite({ write_id }).catch(() => {});
    throw e;
  }
  return true;
}

export { uploadOne as uploadFile };

export function importFiles(dir = ".") {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.addEventListener("change", async () => {
    const files = [...picker.files];
    let done = 0;
    for (const f of files) {
      try {
        toast(`正在导入 ${done + 1}/${files.length}：${f.name}`, 60000);
        if (await uploadOne(f, dir === "." ? f.name : `${dir}/${f.name}`)) done++;
      } catch (e) { toast(`导入 ${f.name} 失败：${e.message}`); return; }
    }
    events.emit("tree:refresh", { path: dir === "." ? "x" : `${dir}/x` });
    toast(`已导入 ${done} 个文件`);
  });
  picker.click();
}

export async function exportPath(path = ".") {
  try {
    const { url, name } = await runtime.files.export({ path });
    const t = bridge.target;
    const base = t ? `${t.tls ? "https" : "http"}://${t.host.includes(":") ? `[${t.host}]` : t.host}:${t.port}` : "";
    const a = document.createElement("a");
    a.href = base + url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`正在下载 ${name}`);
  } catch (e) { toast(e.message); }
}
