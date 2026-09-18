// Minimal SVG bar chart for placement probabilities. No dependencies.

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceMax(v) {
  if (v <= 0) return 0.1;
  const steps = [0.02, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
  return steps.find(s => s >= v * 1.08) || 1;
}

/**
 * series: [{ label, color, probs: number[B], actualBucket: number|null, outline?: bool }]
 * labels: string[B]
 */
export function placementChart({ series, labels, outsideIndex }) {
  const W = 980, H = 300, m = { l: 46, r: 12, t: 26, b: 44 };
  const B = labels.length;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ymax = niceMax(Math.max(...series.flatMap(s => s.probs)));
  const slot = iw / B, gap = Math.max(2, slot * 0.18), bw = (slot - gap) / Math.max(1, series.length);
  const y = p => m.t + ih - (p / ymax) * ih;
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Probability of each Club Championship placement">`);
  if (outsideIndex != null) {
    const x0 = m.l + outsideIndex * slot;
    parts.push(`<rect x="${x0}" y="${m.t}" width="${slot}" height="${ih}" fill="#f1f0ec"/>`);
    parts.push(`<text x="${x0 + slot / 2}" y="${m.t - 8}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#5a6068">outside paying bracket</text>`);
  }
  for (let i = 0; i <= 4; i++) {
    const p = (ymax * i) / 4, yy = y(p);
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="#e6e6e2" stroke-dasharray="${i ? '3 3' : ''}"/>`);
    parts.push(`<text x="${m.l - 6}" y="${yy + 3}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#5a6068">${(p * 100).toFixed(ymax < 0.1 ? 1 : 0)}%</text>`);
  }
  series.forEach((s, si) => {
    s.probs.forEach((p, b) => {
      if (p <= 0) return;
      const x = m.l + b * slot + gap / 2 + si * bw, yy = y(p), h = m.t + ih - yy;
      const title = `${s.label} — ${labels[b]}: ${p < 0.001 ? '<0.1' : (p * 100).toFixed(1)}%`;
      parts.push(s.outline
        ? `<rect x="${x + 0.75}" y="${yy + 0.75}" width="${Math.max(0, bw - 1.5)}" height="${Math.max(0, h - 0.75)}" fill="none" stroke="${s.color}" stroke-width="1.5"><title>${esc(title)}</title></rect>`
        : `<rect x="${x}" y="${yy}" width="${bw}" height="${h}" fill="${s.color}"><title>${esc(title)}</title></rect>`);
    });
  });
  labels.forEach((lab, b) => {
    parts.push(`<text x="${m.l + b * slot + slot / 2}" y="${m.t + ih + 14}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#15171a">${esc(lab)}</text>`);
  });
  series.forEach((s, si) => {
    if (s.actualBucket == null || s.noMarker) return;
    const cx = m.l + s.actualBucket * slot + slot / 2, top = m.t + ih + 20 + si * 11;
    parts.push(`<path d="M${cx} ${top} l-5 8 h10 z" fill="${s.color}"><title>${esc(s.label)}: actual 2026 placement</title></path>`);
  });
  parts.push(`<text x="${m.l}" y="${H - 4}" font-family="JetBrains Mono, monospace" font-size="10" fill="#5a6068">▲ actual 2026 placement</text>`);
  parts.push('</svg>');
  return parts.join('');
}
