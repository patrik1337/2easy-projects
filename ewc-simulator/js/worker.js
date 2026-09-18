// Runs the engine off the main thread. Receives plain engine input (weights
// already calibrated on the main thread) and posts progress + aggregates.
import { compileModel, simulate, resultTransferables } from './engine.js';
import { createRng } from './rng.js';

self.onmessage = (ev) => {
  const { jobId, sets, runs, seed } = ev.data;
  try {
    const results = [];
    const total = runs * sets.length;
    sets.forEach((input, s) => {
      const model = compileModel(input);
      // Each parameter set gets the same seed, so A/B comparisons differ only by parameters.
      const res = simulate(model, {
        runs,
        rng: createRng(seed),
        progressEvery: Math.max(100, Math.floor(runs / 100)),
        onProgress: (done) => self.postMessage({ jobId, type: 'progress', done: s * runs + done, total }),
      });
      results.push(res);
    });
    self.postMessage({ jobId, type: 'done', results }, results.flatMap(resultTransferables));
  } catch (err) {
    self.postMessage({ jobId, type: 'error', message: String(err && err.message || err) });
  }
};
