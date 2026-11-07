/* Port of backend/app/law/snapshot.py. A citation that does not resolve to a paragraph of a
 * verified snapshot comes back as status "pending" (待核对) with no text, never filled in. */
import { pack, type LawArticle, type LawFile } from "./pack";

const DIGITS = "零一二三四五六七八九";

/** 1 → 一, 10 → 十, 13 → 十三, 28 → 二十八, 104 → 一百零四. */
export function cnNumber(n: number): string {
  if (n <= 0 || n >= 1000) throw new RangeError(String(n));
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const tens = Math.floor(rest / 10);
  const ones = rest % 10;
  let out = "";
  if (hundreds) {
    out += DIGITS[hundreds] + "百";
    if (rest && tens === 0) out += "零";
  }
  if (tens) out += (tens === 1 && !hundreds ? "" : DIGITS[tens]) + "十";
  if (ones) out += DIGITS[ones];
  return out;
}

export interface Citation {
  law_id: string;
  article: number;
  paragraph: number | null;
  item: number | null;
  kind: string;
  status: "verified" | "pending";
  label: string;
  law_title: string;
  short_label: string;
  lead: string;
  text: string;
  article_text: string;
  version: string;
  source_name: string;
  source_url: string;
  retrieved_at: string;
  note: string;
}

const articleLabel = (a: LawArticle) => `第${cnNumber(a.number)}条`;

function fullText(a: LawArticle): string {
  const lines: string[] = [];
  a.paragraphs.forEach((p, i) => {
    lines.push((i === 0 ? articleLabel(a) + "　" : "") + p.text);
    lines.push(...(p.items ?? []));
  });
  return lines.join("\n");
}

interface Law {
  file: LawFile;
  title: string;
  short_title: string;
  version: string;
  articles: Map<number, LawArticle>;
}

const LAWS = new Map<string, Law>(
  pack.laws.map((f) => [f.id, {
    file: f,
    title: f.title,
    short_title: f.short_title ?? f.title,
    version: `${f.promulgated ?? ""} 公布 · ${f.effective ?? ""} 施行 · ${f.validity ?? ""}`,
    articles: new Map(f.articles.map((a) => [a.number, a])),
  }]),
);

const blank = { lead: "", text: "", article_text: "", version: "", source_name: "", source_url: "", retrieved_at: "", note: "" };

export function resolve(lawId: string, article: number, paragraph: number | null = null, item: number | null = null, kind = "basis"): Citation {
  const law = LAWS.get(lawId);
  const labelLaw = law ? `《${law.title}》` : `《${lawId}》`;
  const art = law?.articles.get(article);
  if (!law || !art) {
    return {
      ...blank, law_id: lawId, article, paragraph, item, kind, status: "pending",
      label: `${labelLaw}第${cnNumber(article)}条`, law_title: law ? law.title : lawId,
      short_label: `第${cnNumber(article)}条`, note: `本地快照中没有该${law ? "条款" : "法规"}，原文待核对`,
    };
  }
  const pending = (note: string): Citation => ({
    ...blank, law_id: law.file.id, article: art.number, paragraph, item, kind, status: "pending",
    label: `《${law.title}》${articleLabel(art)}`, law_title: law.title, short_label: `${law.short_title}${articleLabel(art)}`,
    note: note + "，原文待核对", source_url: law.file.source?.url ?? "",
  });
  const pIndex = paragraph || 1;
  if (pIndex > art.paragraphs.length) return pending("本地快照中没有该款");
  const para = art.paragraphs[pIndex - 1];
  const items = para.items ?? [];
  if (item !== null && item > items.length) return pending("本地快照中没有该项");
  let suffix = articleLabel(art);
  if (art.paragraphs.length > 1 && paragraph !== null) suffix += `第${cnNumber(pIndex)}款`;
  if (item !== null) suffix += `第${cnNumber(item)}项`;
  return {
    law_id: law.file.id, article, paragraph, item, kind, status: "verified",
    label: `${labelLaw}${suffix}`, law_title: law.title, short_label: `${law.short_title}${suffix}`,
    lead: item !== null ? para.text : "", text: item !== null ? items[item - 1] : para.text, article_text: fullText(art),
    version: law.version, source_name: law.file.source?.name ?? "", source_url: law.file.source?.url ?? "",
    retrieved_at: law.file.source?.retrieved_at ?? "", note: "",
  };
}

export function containsText(lawId: string, article: number, fragment: string): boolean {
  const art = LAWS.get(lawId)?.articles.get(article);
  return Boolean(art && fragment && fullText(art).includes(fragment));
}

/** Every article in the verified snapshots, as "law_id:number". */
export function verifiedArticles(): string[] {
  return pack.laws.flatMap((f) => f.articles.map((a) => `${f.id}:${a.number}`));
}
