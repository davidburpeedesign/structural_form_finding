import { runPipeline } from './pipeline.js';

self.onmessage = (ev) => {
  const { id, mesh, supports, params } = ev.data;
  try {
    let lastPost = 0;
    const result = runPipeline(mesh, supports, params, (it, total, J) => {
      const now = performance.now();
      if (now - lastPost > 60) { lastPost = now; self.postMessage({ id, type: 'progress', it, total, J }); }
      return true;
    });
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
