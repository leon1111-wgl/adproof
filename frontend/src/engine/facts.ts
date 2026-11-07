/* Port of backend/app/rules/facts.py: numbers in the script must match the product sheet.
 * Conservative on purpose: a number is flagged only when its clause names an attribute from the
 * sheet, the units agree, and no fact with that unit carries the same value. */
import { pack } from "./pack";
import { finditer, normalize, pyFloat, pyRegex, toOriginal } from "./text";

const UNITS = pack.facts.units;
const NUM_UNIT = pyRegex(pack.facts.num_unit);
const PRICE_WORDS = pack.facts.price_words;
const SELF_DESCRIBING = new Set(pack.facts.self_describing);
const SKIP_WORDS = new Set(pack.facts.skip_words);
const CJK_RUN = /[一-鿿]{2,}/y;
const CJK_TAIL = /[一-鿿]{2,6}$/;
const CLAUSE_MARKS = ",。!?;\n:、";

export interface ProductFact {
  key: string;
  value: string;
}

interface Fact {
  key: string;
  value: string;
  number: number;
  unit: string;
  raw_number: string;
  keywords: string[];
}

function parseFacts(facts: ProductFact[]): Fact[] {
  const parsed: Fact[] = [];
  for (const fact of facts ?? []) {
    const key = String(fact.key ?? "").trim();
    const value = String(fact.value ?? "").trim();
    const normValue = normalize(value).text;
    for (const m of finditer(NUM_UNIT, normValue)) {
      const unit = UNITS[m[2]];
      const keywords = new Set<string>(key ? [normalize(key).text] : []);
      CJK_RUN.lastIndex = m.index + m[0].length;
      const after = CJK_RUN.exec(normValue);
      if (after) keywords.add(after[0].slice(0, 6));
      const before = CJK_TAIL.exec(normValue.slice(0, m.index));
      if (before) keywords.add(before[0]);
      const kept = [...keywords].filter((k) => k && !SKIP_WORDS.has(k));
      if (unit === "元") kept.push(...PRICE_WORDS.filter((w) => !kept.includes(w)));
      parsed.push({ key, value, number: pyFloat(m[1]), unit, raw_number: m[1], keywords: kept });
    }
  }
  return parsed;
}

export interface FactMismatch {
  start: number;
  end: number;
  quote: string;
  fact_key: string;
  fact_value: string;
  script_value: string;
  expected_value: string;
  script_number: string;
  expected_number: string;
}

export function checkFacts(text: string, facts: ProductFact[]): FactMismatch[] {
  const known = parseFacts(facts);
  if (!known.length) return [];
  const norm = normalize(text);
  const out: FactMismatch[] = [];
  for (const m of finditer(NUM_UNIT, norm.text)) {
    const unit = UNITS[m[2]];
    const sameUnit = known.filter((f) => f.unit === unit);
    if (!sameUnit.length) continue;
    const value = pyFloat(m[1]);
    if (sameUnit.some((f) => Math.abs(f.number - value) < 1e-9)) continue;
    const s = m.index;
    const e = s + m[0].length;
    const clauseStart = Math.max(...[...CLAUSE_MARKS].map((ch) => (s > 0 ? norm.text.lastIndexOf(ch, s - 1) : -1))) + 1;
    const ends = [...CLAUSE_MARKS].map((ch) => norm.text.indexOf(ch, e)).filter((i) => i >= 0);
    const clause = norm.text.slice(clauseStart, ends.length ? Math.min(...ends) : norm.text.length);
    let related = sameUnit.filter((f) => f.keywords.some((kw) => clause.includes(kw)));
    if (!related.length && SELF_DESCRIBING.has(unit) && sameUnit.length === 1) related = sameUnit;
    if (!related.length) continue;
    const fact = related[0];
    const [start, end] = toOriginal(norm, s, e);
    const quote = text.slice(start, end);
    out.push({
      start, end, quote, fact_key: fact.key, fact_value: fact.value, script_value: quote,
      expected_value: quote.replace(m[1], () => fact.raw_number), script_number: m[1], expected_number: fact.raw_number,
    });
  }
  return out;
}
