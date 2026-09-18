// Seeded PRNG (sfc32, seeded via splitmix32). Deterministic across browsers and Node.

function splitmix32(a) {
  return function () {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0);
  };
}

/** Returns a function producing uniforms strictly inside (0, 1). */
export function createRng(seed) {
  const sm = splitmix32(Number(seed) >>> 0);
  let a = sm(), b = sm(), c = sm(), d = sm();
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return ((t >>> 0) + 0.5) / 4294967296;
  };
}
