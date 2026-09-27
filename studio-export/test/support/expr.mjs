// A tiny evaluator for the subset of ffmpeg's expression language the render emits: numbers, + - * / and parentheses, variables, and the functions
// if(a,b,c), lt(a,b), gt(a,b), clip(x,lo,hi), min(a,b), max(a,b). It exists so the tests can check a generated expression against the curve function the
// preview uses, without running ffmpeg.
export function evalExpr(src, vars = {}) {
  let i = 0;
  const s = String(src);
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => { ws(); return s[i]; };
  const num = () => {
    ws();
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (m) { i += m[0].length; return Number(m[0]); }
    const id = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (!id) throw new Error(`unexpected "${s.slice(i, i + 12)}" at ${i} in ${s.slice(0, 80)}`);
    i += id[0].length;
    if (peek() === '(') {
      i++;
      const args = [];
      if (peek() !== ')') { do { args.push(sum()); } while (peek() === ',' && ++i); }
      if (peek() !== ')') throw new Error(`expected ) at ${i}`);
      i++;
      const f = { if: (a, b, c) => (a ? b : c), lt: (a, b) => (a < b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0), clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)), min: Math.min, max: Math.max }[id[0]];
      if (!f) throw new Error(`unknown function ${id[0]}`);
      return f(...args);
    }
    if (!(id[0] in vars)) throw new Error(`unknown variable ${id[0]}`);
    return vars[id[0]];
  };
  const atom = () => { if (peek() === '(') { i++; const v = sum(); if (peek() !== ')') throw new Error(`expected ) at ${i}`); i++; return v; } if (peek() === '-') { i++; return -atom(); } return num(); };
  const prod = () => { let v = atom(); while (peek() === '*' || peek() === '/') { const o = s[i++]; const r = atom(); v = o === '*' ? v * r : v / r; } return v; };
  const sum = () => { let v = prod(); while (peek() === '+' || peek() === '-') { const o = s[i++]; const r = prod(); v = o === '+' ? v + r : v - r; } return v; };
  const v = sum();
  ws();
  if (i < s.length) throw new Error(`trailing "${s.slice(i, i + 12)}"`);
  return v;
}
export const maxDepth = (src) => { let d = 0; let m = 0; for (const ch of String(src)) { if (ch === '(') m = Math.max(m, ++d); else if (ch === ')') d--; } return m; };
