import { compare } from "./core.js";
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({
      result: await compare(data.a, data.b, data.p, data.imported),
    });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
