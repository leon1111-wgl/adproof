# Blind set v2: what the writer saw

`blind_v2.yaml` is the sequestered blind set for v1.2 (红队回合). It was written on 2026-11-10 by Claude Sonnet, a different
model family from the red-team generator (GLM-4-9B-0414) and the label auditor (Qwen3-4B-Instruct-2507). It is committed
before any rule change of v1.2, and the reviewer's author did not read its scripts before the runs recorded in
`docs/EVALUATION.md` (section 7).

The writer saw only the three inputs reproduced below: the category descriptions with their scope, the file format with the
annotation guidelines, and the fictional product sheets (`backend/seed/products.json`). It did not see the rule library, the
code, the earlier evaluation sets, the red-team rounds or the main session's probes. A validator (the evaluator's own loader)
checked that the file loads; it printed counts only.

Composition (validator output): 60 scripts, 18 clean, 6 SRT, 80 gold spans, 4 missing disclosures. absolute_terms 9,
authority_endorsement 5, disparagement 5, effect_claims 11, endorsement 5, fact_mismatch 18, guaranteed_returns 7,
medical_claims 8, patent_claims 6, unsourced_data 6. All data is fictional (SYNTHETIC).

---

## 违规分类（审查口径）

商品类目：`general` 通用、`cosmetics` 美妆个护、`food` 普通食品、`health_food` 保健食品、`digital` 数码家电、`home` 家居日用、`apparel` 服饰鞋包、`franchise` 招商加盟、`education` 课程培训

## `absolute_terms` 绝对化用语

最高级、排名第一、“天花板”等无法证明的极限表述。

## `authority_endorsement` 国家机关名义

使用或者变相使用国家机关、国家机关工作人员的名义或形象背书。

## `medical_claims` 疾病治疗与医疗用语

非医疗类商品宣称疾病治疗功能、使用医疗用语或与药品混淆。

适用范围：普通食品、保健食品、美妆、家居、服饰等非医疗商品。

## `effect_claims` 效果保证与虚构效果

对使用效果作出保证，或给出无法证明的量化效果。

## `unsourced_data` 数据无出处

使用数据、调查结果、实验结论作证明，但没有标明出处。

## `disparagement` 贬低其他经营者

贬低其他生产经营者的商品或者服务。

## `guaranteed_returns` 收益或结果保证

招商加盟承诺收益、保本，或教育培训承诺通过、就业、变现等结果。

适用范围：只适用于招商加盟（franchise）和课程培训（education）。其他类目里的“保证”类说法归入“效果保证与虚构效果”。

## `endorsement` 专业人士或代言人推荐

保健食品利用代言人作推荐、证明；教育培训利用学术、教育机构或专业人士的名义作推荐、证明。

适用范围：只适用于保健食品（health_food）和课程培训（education）。其他类目里的专家、医生推荐不在本分类内；含“医生推荐”“专家推荐”等医疗术语的归入“疾病治疗与医疗用语”。

## `patent_claims` 专利宣称

宣称专利产品、专利技术或专利配方，但没有标明专利号和专利种类。

## `fact_mismatch` 与商品资料不符

脚本中的价格、成分、规格等数字与商品资料不一致。

适用范围：只看与所选商品资料（products.json 的 facts）不一致的数字，例如价格、含量、规格、时长。

## 必要声明（文档级，不算片段）

- `DSC-01` 保健食品应标明“本品不能代替药物”（类目：health_food；出现以下任一说法即视为已提示：本品不能代替药物）
- `DSC-02` 招商广告应提示投资风险（类目：franchise；出现以下任一说法即视为已提示：投资有风险 / 存在风险 / 风险自担 / 亏损风险 / 经营风险）

---

## 文件格式（blind_v2.yaml）

```yaml
## SYNTHETIC blind set v2 ...（第一行写一句说明：谁写的、依据什么写的）
items:
  - id: b2-01            # b2-01 … b2-60，不重复
    split: test          # 全部写 test
    product: MIA-SERUM   # products.json 里的 sku
    marked: |-
      姐妹们，这款[[absolute_terms|示例违规片段]]的精华今天上车……
  - id: b2-02
    split: test
    product: IRIS-VC
    missing_disclosures: [DSC-01]   # 脚本缺少必要声明时写；没有缺少就不写这一行
    marked: |-
      ……
  - id: b2-03
    split: test
    product: MIA-SUNSCREEN
    input_type: srt                 # SRT 字幕；标记写在字幕文字里，不能跨越两条字幕
    marked: |-
      1
      00:00:00,000 --> 00:00:02,500
      第一条字幕

      2
      00:00:02,500 --> 00:00:05,000
      第二条字幕，含[[effect_claims|示例片段]]
```

- 标注直接写在原文里：`[[分类id|违规片段]]`。分类 id 见 categories.md。干净脚本（不含任何违规片段）就不写标记。
- 评测按“分类相同且字符 IoU ≥ 0.5”判定命中，所以片段边界要按下面的口径标，不要标整句。
- 写完后运行 the evaluator's loader，必须输出 OK。

## 标注口径

1. 显性违规只标**最小违规表述**（例如只标“全网最低价”这几个字，不标整句）。紧挨着的比较范围词（全网 / 史上 / 行业 / 同类）算在片段内。
2. 隐含违规标承载这层意思的**最短分句片段**（例如“喝了一个月血糖都稳了”）。
3. 与商品资料不符只标“数字 + 单位”（例如“30%”“99元”“12小时”）。
4. 含“副作用”“疗程”“医生推荐”等医疗术语的，归入“疾病治疗与医疗用语”。
5. 主观夸张但不构成明确违规的表述（例如“熬夜脸也能救回来”）不标。
6. 必要声明是文档级标注，写在 `missing_disclosures`，不算片段。
