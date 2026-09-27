export function compareVisual(before, after, expected = []) {
  if (before.viewport.width !== after.viewport.width || before.viewport.height !== after.viewport.height || before.theme !== after.theme) return { compatible: false, changes: [], reason: "视口或主题不同，请与同一场景的基线比较" };
  const old = new Map(before.nodes.map((n) => [n.key, n])), changes = [];
  for (const node of after.nodes) {
    const prior = old.get(node.key); old.delete(node.key);
    if (!prior) { changes.push({ key: node.key, kind: "added", expected: expected.includes(node.key) }); continue; }
    const shift = Math.max(...["x", "y", "width", "height"].map((k) => Math.abs(node[k] - prior[k])));
    if (shift > 3 || (node.overflow && !prior.overflow)) changes.push({ key: node.key, kind: node.overflow && !prior.overflow ? "overflow" : "geometry", delta: Math.round(shift), before: prior, after: node, expected: expected.includes(node.key) });
  }
  for (const node of old.values()) changes.push({ key: node.key, kind: "removed", expected: expected.includes(node.key) });
  // Pixel changes alone are informational; geometry/overflow and declared intent determine review candidates.
  return { compatible: true, changes, unexpected: changes.filter((c) => !c.expected), screenshot_changed: !!(before.image && after.image && before.image !== after.image) };
}
export async function captureScreenshot() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("当前运行环境不支持屏幕截图授权；布局测量仍可使用，也可导入真机截图");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement("video"); video.muted = true; video.srcObject = stream;
  try {
    await video.play();
    await new Promise((resolve, reject) => {
      let frame; const timer = setTimeout(() => { if (frame != null) video.cancelVideoFrameCallback?.(frame); reject(new Error("未收到截图画面，请重新选择屏幕")); }, 5000);
      const done = () => { clearTimeout(timer); resolve(); };
      if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(done); else setTimeout(done, 100);
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error("截图画面为空，请重新选择屏幕");
    const canvas = document.createElement("canvas"), scale = Math.min(1, 1600 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally { stream.getTracks().forEach((track) => track.stop()); video.srcObject = null; }
}
