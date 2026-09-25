// 导入 / 导出。本地模式下的「上传」是把浏览器里选的文件复制进项目，「下载」是把文件或文件夹打成 zip。
// 大文件走事务式写入：分块上传、校验字节数和 SHA-256，提交之前原文件不会被替换。

import { toast } from "./dom.js";
import { confirmDialog } from "./overlays.js";
import { runtime, events, openWorkspace } from "../services/app.js";
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
  if (buf.length === 0) {
    await runtime.files.write({ path: dest, content: "", base_revision: cur.revision });
    return true;
  }
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


function safePart(part) {
  const cleaned = String(part || "").replace(/[\\/\0]/g, "_").trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

function chooseDirectoryFiles() {
  return new Promise((resolve) => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.webkitdirectory = true;
    picker.setAttribute("webkitdirectory", "");
    picker.style.display = "none";
    picker.addEventListener("change", () => {
      const files = [...(picker.files || [])];
      picker.remove();
      resolve(files);
    }, { once: true });
    picker.addEventListener("cancel", () => {
      picker.remove();
      resolve([]);
    }, { once: true });
    document.body.appendChild(picker);
    picker.click();
  });
}

/**
 * Android-safe directory import. Modern Android WebView exposes a user-granted directory through
 * webkitdirectory; Diffusion copies that tree into its private writable workspace and opens the
 * imported project immediately. This avoids pretending scoped shared storage is an ordinary POSIX path.
 */
export async function importDirectoryAsWorkspace() {
  const files = await chooseDirectoryFiles();
  if (!files.length) return null;

  const rels = files.map((file) => String(file.webkitRelativePath || file.name || ""));
  const first = rels.find(Boolean) || "导入项目";
  const rootSource = safePart(first.split("/")[0] || "导入项目");

  const locations = await runtime.workspace.browse({ path: null });
  const local = (locations.entries || []).find((entry) => entry.name === "Diffusion 本地工作区")
    || (locations.entries || [])[0];
  if (!local?.path) throw new Error("没有找到可写的 Diffusion 本地工作区");

  // Use the private workspace as a staging root. The final project becomes its own workspace.
  await runtime.workspace.open({ path: local.path });

  let root = rootSource;
  for (let n = 2; n < 100; n++) {
    try {
      await runtime.files.tree({ path: root, depth: 1, show_hidden: true });
      root = `${rootSource} (导入 ${n})`;
    } catch {
      break;
    }
  }
  await runtime.files.create({ path: root, kind: "dir" });

  const made = new Set([root]);
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = String(file.webkitRelativePath || file.name || "");
    const parts = rel.split("/").filter(Boolean).map(safePart);
    const tail = parts.length > 1 ? parts.slice(1) : [safePart(file.name)];
    if (!tail.length) continue;

    let parent = root;
    for (const part of tail.slice(0, -1)) {
      parent += "/" + part;
      if (!made.has(parent)) {
        await runtime.files.create({ path: parent, kind: "dir" });
        made.add(parent);
      }
    }

    const dest = parent + "/" + tail[tail.length - 1];
    toast(`正在导入 ${i + 1}/${files.length}：${rel || file.name}`, 60000);
    if (await uploadOne(file, dest)) done++;
  }

  const absolute = String(local.path).replace(/[\\/]$/, "") + "/" + root;
  await openWorkspace(absolute);
  events.emit("tree:refresh", { path: "x" });
  toast(`已导入并打开 ${done} 个文件`);
  return absolute;
}
