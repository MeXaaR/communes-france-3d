/// <reference lib="webworker" />
import { generate, clip } from './model';
const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e) => {
  try {
    const { id, input } = e.data;
    input.buildings = clip(input.buildings, input.boundary);
    const model = generate(input);
    ctx.postMessage({ id, model, buildings: input.buildings }, [
      model.positions.buffer,
      model.colors.buffer,
    ]);
  } catch (error) {
    ctx.postMessage({ id: e.data.id, error: String(error) });
  }
};
