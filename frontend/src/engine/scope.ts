/* What a review did and did not check (default-deny).
 *
 * A script is never presented as compliant because no rule fired. Every review in the static demo
 * carries this statement: the rules, statements and product facts that actually ran, the areas the
 * rule library does not cover at all, and sentences of this script that make a claim of a kind the
 * library does not check (price and promotion, gifts, testimonials, certificates, comparisons,
 * regulated goods). Those are listed for a human, with no law citation: they are not findings.
 *
 * This layer is the demo's own; it does not change a finding, and the backend has no equivalent yet. */
import { pack } from "./pack";
import { applicableDisclosures, applicableRules, CATEGORIES } from "./rules";
import { clauseBounds, finditer, isCjk } from "./text";

export interface ScopeSignal {
  topic: string;
  quote: string;
  /** the clause around the match, and where the match sits in it */
  sentence: string;
  at: [number, number];
  start: number;
  end: number;
  note: string;
}

export interface ScopeReport {
  verdict: string;
  /** "flagged" | "no_hit" | "not_reviewable" */
  state: "flagged" | "no_hit" | "not_reviewable";
  input_notes: string[];
  checked: { label: string; detail: string }[];
  not_checked: { label: string; detail: string }[];
  signals: ScopeSignal[];
}

interface Topic {
  topic: string;
  re: RegExp;
  note: string;
}

// Patterns for claims the rule library does not judge. They only point a human at a sentence.
const TOPICS: Topic[] = [
  { topic: "价格与促销", re: /原价|划线价|专柜价|市场价|吊牌价|秒杀|限时|限量|仅剩|只剩|最后\s*\d+\s*[单件份]|库存不多|倒计时|错过(?:今天|这次)?(?:就)?没有/g, note: "原价、限时、库存等说法需要真实依据，规则库不核对价格与促销是否属实。" },
  { topic: "赠品", re: /(?:买|拍)[一二两三1-3](?:送|发)[一二两三1-3]|赠品|附赠|加赠|再送|送[^，。！？!?\n]{0,6}(?:小样|礼品|礼盒|一[瓶盒支件套])/g, note: "广告法第八条第二款要求写明赠品的品种、规格、数量、期限和方式；该款原文在本地快照里，但规则库没有检查它。" },
  { topic: "代言与证言", re: /明星|代言|网红|达人|专家|教授|博士|医生|主治|亲测|实测|用户反馈|买家秀|粉丝说/g, note: "代言人、证明人和使用体验：规则库只检查其中的医疗用语和效果保证，资格与真实性需要人工核对。" },
  { topic: "检测、认证与荣誉", re: /检测报告|检测合格|认证|获奖|荣获|金奖|大奖|备案号|批准文号|蓝帽子|SGS/gi, note: "检测、认证、获奖等宣称需要证明材料，规则库不核对其真实性。" },
  { topic: "比较", re: /比[^，。！？!?\n]{0,8}(?:更|还要?)(?:好|强|便宜|划算|有效|耐用|好用)|对比|pk/gi, note: "比较性说法需要可验证的依据；规则库只检查其中的贬低用语和绝对化用语。" },
  { topic: "特殊商品与服务", re: /药品|处方药|非处方药|医疗器械|医美|整形|玻尿酸注射|针剂|理财|贷款|分期免息|保险|收益率|彩票|楼盘|房产|电子烟|香烟|白酒|啤酒|奶粉|婴幼儿/g, note: "药品、医疗器械、医疗美容、金融、房地产、烟酒、婴幼儿食品等有专门的广告规定，规则库没有这些条款。" },
  { topic: "未成年人", re: /儿童|小朋友|中小学生|未成年/g, note: "面向未成年人的广告有专门要求，规则库没有检查。" },
];

const NOT_CHECKED: { label: string; detail: string }[] = [
  { label: "规则词表之外的说法", detail: "规则按词表和句式匹配，换一种说法（同义词、谐音、缩写、长句里的隐含意思）可能漏检；离线语义模式只覆盖少数隐含句式。" },
  { label: "说法是否属实", detail: "销量、好评、检测、产地等事实是否真实，需要证明材料；只有填了商品资料的数字会被核对。" },
  { label: "规则库之外的法规", detail: "只引用本地已核对的条款（广告法 15 条、食品安全法 2 条、化妆品监督管理条例 1 条）；其余依据标为待核对，不作为法条展示。" },
  { label: "画面与直播现场", detail: "只审查文字。画面、商品实物、口播语气、弹幕和评论区互动都不在范围内。" },
  { label: "平台规则", detail: "各平台自己的直播与短视频规范不在规则库内。" },
];

function cjkShare(text: string): number {
  let cjk = 0;
  let visible = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    visible++;
    if (isCjk(ch)) cjk++;
  }
  return visible ? cjk / visible : 0;
}

export function scopeOf(text: string, product: { category: string; facts?: { key: string; value: string }[] }, result: { findings: unknown[]; missing: number }): ScopeReport {
  const category = product.category || "general";
  const rules = applicableRules(category);
  const categories = [...new Set(rules.map((r) => r.category))].map((id) => CATEGORIES.get(id)!.label);
  const disclosures = applicableDisclosures(category);
  const facts = product.facts ?? [];
  const categoryName = pack.product_categories[category] ?? category;
  const checked = [
    { label: "规则审查", detail: `${rules.length} 条规则（类目「${categoryName}」适用）：${categories.join("、")}。` },
    { label: "离线语义模式", detail: `${pack.semantic_patterns.length} 个上下文句式，用于少数隐含宣称；它不是语言模型。` },
    disclosures.length
      ? { label: "必要声明", detail: disclosures.map((d) => d.name).join("；") + "。" }
      : { label: "必要声明", detail: `「${categoryName}」类目在规则库里没有必须出现的声明。` },
    facts.length
      ? { label: "商品资料核对", detail: `脚本中的数字与商品资料的 ${facts.length} 项核对（价格、成分、规格等）。` }
      : { label: "商品资料核对", detail: "未执行：没有提供商品资料，价格、成分、规格等数字没有核对。" },
    { label: "法条引用", detail: "每条结果只引用本地已核对的法条快照原文，并逐条复核引文与快照一致。" },
  ];
  const signals: ScopeSignal[] = [];
  for (const t of TOPICS) {
    for (const m of finditer(t.re, text)) {
      const start = m.index;
      const end = start + m[0].length;
      const [a, b] = clauseBounds(text, start, end);
      // one entry per topic and clause
      if (signals.some((s) => s.topic === t.topic && s.start >= a && s.end <= b)) continue;
      signals.push({ topic: t.topic, quote: m[0], sentence: text.slice(a, b), at: [start - a, end - a], start, end, note: t.note });
    }
  }
  signals.sort((x, y) => x.start - y.start);

  const notes: string[] = [];
  const share = cjkShare(text);
  const length = [...text.replace(/\s/g, "")].length;
  let state: ScopeReport["state"] = result.findings.length || result.missing ? "flagged" : "no_hit";
  if (share < 0.2) {
    notes.push("脚本里几乎没有中文。规则库只覆盖中文表述，这次审查不能说明任何问题。");
    state = "not_reviewable";
  } else if (share < 0.5) {
    notes.push("脚本里中文不到一半，规则只检查中文部分。");
  }
  if (length < 8) notes.push(`脚本只有 ${length} 个字，只检查了这几个字。`);

  let verdict: string;
  if (state === "not_reviewable") verdict = "未能有效审查：输入不是规则库能读懂的中文带货脚本。";
  else if (state === "flagged") verdict = `发现 ${result.findings.length} 处问题${result.missing ? `、缺少 ${result.missing} 项必要声明` : ""}，需要改写或由审核员逐条判定。`;
  else verdict = "规则库没有命中。这不等于合规：下面列出了没有检查的内容，是否发布仍由审核员决定。";
  if (signals.length && state !== "not_reviewable") verdict += ` 另有 ${signals.length} 处说法超出规则库范围，需要人工判断。`;
  return { verdict, state, input_notes: notes, checked, not_checked: NOT_CHECKED, signals };
}
