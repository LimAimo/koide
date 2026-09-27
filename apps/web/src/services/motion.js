// UI motion only. Code Diffusion keeps its own engine and timing.
import { reducedMotion } from "./store.js";

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Use recent movement, never a stale last pointermove, to determine release intent. */
export function velocityTracker(position, time = performance.now()) {
  let samples = [{ position, time }];
  return {
    add(position, time = performance.now()) {
      samples.push({ position, time });
      samples = samples.filter((sample) => time - sample.time <= 100).slice(-12);
    },
    value(time = performance.now()) {
      const last = samples.at(-1), first = samples[0];
      if (time - last.time > 90 || last.time <= first.time) return 0;
      return clamp((last.position - first.position) / (last.time - first.time), -3, 3);
    },
  };
}

/** Critically damped spring, in pixels and px/ms; cancellation leaves the rendered value in place. */
export function springTo({ from, to, velocity = 0, update, complete = () => {} }) {
  let frame = 0, cancelled = false;
  const start = performance.now(), offset = from - to, omega = 24;
  const speed = clamp(velocity, -3, 3) * 1000;
  const tick = (now) => {
    if (cancelled) return;
    const t = Math.max(0, now - start) / 1000;
    const c = speed + omega * offset, decay = Math.exp(-omega * t);
    const distance = (offset + c * t) * decay;
    const currentSpeed = (speed - omega * c * t) * decay;
    if (reducedMotion() || t >= 0.65 || (Math.abs(distance) < 0.5 && Math.abs(currentSpeed) < 8)) {
      update(to); complete(); return;
    }
    update(to + distance);
    frame = requestAnimationFrame(tick);
  };
  if (reducedMotion() || (from === to && !velocity)) { update(to); complete(); }
  else frame = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}

export function sheetDestination(height, velocity, max, startedFull = false) {
  const projected = height + velocity * 160;
  if (velocity < -0.75) return startedFull && height > max * 0.5 ? max * 0.5 : 0;
  if (projected < max * 0.24) return 0;
  if (velocity > 0.52 || projected >= max * 0.88 || height >= max - 24) return max;
  if (Math.abs(projected - max * 0.5) < max * 0.07) return max * 0.5;
  return clamp(projected, max * 0.24, max - 1);
}
