/* Character alignment for the OCR evaluation (docs/EVALUATION.md 8.1): edit distance for character accuracy,
   and a position map from OCR text to the text that was drawn, so findings can be compared on the same spans. */

/** Both sides of the character-accuracy comparison: NFKC, whitespace removed, punctuation kept. */
export const forCer = (s: string) => s.normalize("NFKC").replace(/\s+/gu, "");

/** Levenshtein distance over code points. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** For every boundary 0..hyp.length (UTF-16) of hyp, the matching boundary in ref, from a minimum-cost
    alignment (substitutions and matches map position to position; inserted characters map to the
    current ref position; deleted ref characters are skipped). */
export function boundaryMap(hyp: string, ref: string): number[] {
  const n = hyp.length;
  const m = ref.length;
  const cost = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 0; i <= n; i++) cost[at(i, 0)] = i;
  for (let j = 0; j <= m; j++) cost[at(0, j)] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = hyp.charCodeAt(i - 1) === ref.charCodeAt(j - 1) ? 0 : 1;
      cost[at(i, j)] = Math.min(cost[at(i - 1, j)] + 1, cost[at(i, j - 1)] + 1, cost[at(i - 1, j - 1)] + same);
    }
  }
  const map = new Array<number>(n + 1).fill(0);
  map[n] = m;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[at(i, j)] === cost[at(i - 1, j - 1)] + (hyp.charCodeAt(i - 1) === ref.charCodeAt(j - 1) ? 0 : 1)) {
      map[i - 1] = j - 1;
      i--;
      j--;
    } else if (i > 0 && cost[at(i, j)] === cost[at(i - 1, j)] + 1) {
      map[i - 1] = j; // an extra character in hyp sits at the current ref boundary
      i--;
    } else {
      j--;
    }
  }
  return map;
}

/** Map a [start, end) span of hyp into ref coordinates: from the first character's position to one past the
    furthest position any of its characters maps to. */
export function mapSpan(map: number[], start: number, end: number): [number, number] {
  const a = map[start];
  let b = a;
  for (let i = start; i < end; i++) b = Math.max(b, map[i] + 1);
  return [a, Math.min(b, map[map.length - 1])];
}
