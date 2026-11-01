# 记忆层语义参考（personal-agent v1.4.1）

> 移植对照用的规范文本：数字 / 正则 / 文案全部照抄源码，不做「优化」。冲突以源码为准。
> 取证日 2026-11-01；实现 `dsh-plugin-personal-agent` v1.4.1（`index.js` 700 行）。设计契约 `references/first-principles.md`：D2/D3/D4/D5/D6 与本文一致，唯一偏差见 §6（整块上界 313 vs 契约「≤300」）。

| 短名 | 路径（相对 `default-workspace/`） | 内容 |
|---|---|---|
| recall.js | `plugins/personal-agent/lib/recall.js`（275 行） | 分词、别名、打分、预算、渲染 |
| store.js | `plugins/personal-agent/lib/store.js`（248 行） | 布局、entryId、写入、双时态取代、删除 |
| rules.js | `plugins/personal-agent/lib/rules.js`（46 行） | 预算常量 3/300、8/800 与纪律提示词 |
| index.js | `plugins/personal-agent/index.js`（700 行） | memory/profile 工具参数与文案（465–542） |
| data | `~/.dsh/storages/personal-agent/` | 实测 62 文件 = 50 active + 4 retired + 8 墓碑 |

## 1 存储

目录与 root 解析（store.js:68-82, 100-104；顺序：`DSH_HOME` → `DSH_PROFILE_DIR/../..` → cwd 命中 `profiles/<p>` 则 `cwd/../..` → `USERPROFILE/.dsh` → `cwd/.dsh`，再拼 `storages/personal-agent`，`entries/` 递归 mkdir）：

```
<root>/entries/<id>.json   一条一文件；删除后同路径变墓碑
<root>/profile.json        { schemaVersion, name?, timezone?, locale?, preferences?, notes?, updatedAt }
<root>/debug.jsonl         诊断日志（可删）；启动时 >512KB 清空（index.js:144-150）
```

**entryId**（唯一身份，store.js:45-51；put 中先 `normalize+slice(0,200)` 再参与哈希，store.js:160-162）：

```js
normalize(t) = String(t ?? '').replace(/\s+/g, ' ').trim()
id = sha1(`${kind}\u0000${normalize(text).toLowerCase()}`).hex.slice(0, 12)   // 12 位小写 hex
```

- 任意 `\s+` → 单空格再 trim；小写只影响 ASCII；kind 先归一（非法值变 `fact`）；200 字符截断发生在哈希之前（id 反映截断后文本）；实测 3/3 真实条目可复现：`5443d409a380`、`9f770e1d8e03`、`bdf830781116`。

**put 字段表**（store.js:158-196；`previous` = 同 id 旧记录）：

| 字段 | 取值 / 默认 | 行 |
|---|---|---|
| `kind` | `KINDS`（fact/preference/event/task/person）内，否则 `fact` | 159 |
| `text` | `normalize` → `slice(0,200)`；空串抛 `memory: \`text\` is required and must not be empty` | 160-161 |
| `tags` | 数组：每项 `normalize`→`slice(0,24)`→去空→`slice(0,8)`；非数组 = `[]` | 165-167 |
| `confidence` | 输入 ∈ {0,1,2} 用它，否则 `previous.confidence ?? 1` | 177 |
| `importance` | `clamp01(input) ?? clamp01(prev) ?? defaultImportance({kind,tags,confidence:input.confidence})` | 169-170 |
| `subject` | `normalize`→`slice(0,60)`；空则 `undefined`（JSON 不落盘） | 168,179 |
| `sourceSessionId` | 输入真值 → `String`；否则沿用 previous；无则不落盘 | 180 |
| `createdAt` / `validFrom` | 继承 previous，否则 `now` | 181-182 |
| `validUntil` / `supersededBy` / `supersedes` | 前两者写入恒 `null`；`supersedes = target?.id ?? previous?.supersedes ?? null` | 183-185 |
| `updatedAt` | `now` | 186 |

**同 id 去重（upsert）**：保留 `createdAt`/`validFrom`、`confidence`/`importance`（未显式给时继承 previous）、`sourceSessionId`；不合并其余字段——`tags`/`subject` 不继承，重写须重新提供。返回 `{record, created: !previous, superseded: target?.id}`，工具据此区分「已记住 / 已更新」（store.js:195；index.js:485）。代码推导（真实 62 条未出现）：同 id 重写时候选集含 previous 自身、Jaccard=1，`target` 可能是自己 → `supersedes` 与返回的 `superseded` 指向自身 id，但因 `target.id !== id` 不触发退休（store.js:184,190）。

**写入**：`<file>.<pid>.tmp` 写 `JSON.stringify(v, null, 2) + '\n'`，再 `rename`（同卷原子；store.js:84-88）。**读取**：只收 `typeof id === 'string' && typeof text === 'string'` 的 JSON（坏 JSON、墓碑自动跳过），Map 键是 `record.id` 而非文件名（store.js:105-109）。

**删除**：内存删 + 磁盘写墓碑 `{"deleted":true,"id":"<id>","deletedAt":<ms>}` 覆盖原文件（store.js:209-219）。墓碑不参与 list/recall，重载后不复活；同 id 再 put 会覆盖回正常记录。

**profile**：`profileGet` 原样返回磁盘对象（无则 `{schemaVersion:2}`）；`profileSet` 执行 `{...当前, ...patch, schemaVersion:2, updatedAt:now}`（store.js:221-230）。真实 `profile.json` 是 `schemaVersion:1`（旧写入，无迁移）、`timezone:"Asia/Shanghai"`、`locale:"zh-CN"`、`notes:""`。

## 2 取代（supersede）

触发（store.js:134-155，按优先级；候选恒为「同 kind 且 active」）：

| # | 条件 | 细节 |
|---|---|---|
| 1 | subject 精确匹配 | 须 `entry.subject` 非空且 `=== subject`；不看 tags；命中即返回 |
| 2 | Jaccard 回退 | 双方 tags 都非空且交集为空 → 跳过；`shared < 6` → 跳过；取 score 最大；`score >= 0.55` 才退休 |

- 常量：`SUPERSEDE_JACCARD = 0.55`（store.js:41）、`SUPERSEDE_MIN_SHARED = 6`（store.js:43）；Jaccard = `shared / (|A| + |B| - shared)`，输入 `tokenize(text)` 不含 tags（store.js:59-66）。⚠ store.js:130 注释「≥60%」是过期注释，以常量为准。
- 退休：旧条 `validUntil=now`、`supersededBy=新id`、`updatedAt=now`，其余字段原样保留（store.js:191-194）；新条 `supersedes=target.id`、`validUntil=null`（store.js:184）。
- 候选只含 active（`!validUntil`）：历史条不再被取代，链 A ← B ← C 只追加；单独导出的 `supersede(id, byId)`（store.js:198-207）在工具面无调用点。

## 3 分词（tokenize，recall.js:131-150）

```js
text = String(value ?? '').toLowerCase()
// ① ASCII：/[a-z0-9_.-]{2,}/g（≥2 字符；全角字母不匹配）
//    命中后在 ASCII_STOP 中 → 丢弃；否则整段算 1 个 token（'video-publish'、'v1.4.1' 各 1 个）
// ② CJK：/[\u4e00-\u9fff]+/g
//    run.length === 1 → 推入单字；否则每个相邻二元组，若在 STOP_BIGRAMS 丢弃
```

- 顺序：先 ASCII 后 CJK；返回数组**不去重**（调用方 Set 化）；单字只在 CJK run 长度为 1 时出现，2 字 run 只产 1 个二元组。
- 中文停用二元组（36 个，recall.js:13-17）：
  `的我 我的 你是 是我 了的 了。 就是 可以 这个 那个 什么 怎么 因为 所以 如果 然后 一个 我们 他们 自己 没有 不是 还是 这些 那些 这样 那样 一下 现在 时候 已经 需要 应该 可能 是不 在的`
  注：`了。` 含句号，CJK 类不含 `。`，**永不命中**；保留只为与源码逐字一致。
- 英文停用词（140 个，recall.js:117-128）：
  `the and for you your with that this these those was were are is it its to of in on at by from or as be been being not no yes has have had but if then than so what which who when where why how all any some more most other into over after before up down out just also very too only own same such do does did done doing can could would should will shall may might must let me my we our us he she him her they them their there here now new one two get got make made use used using about like want need see saw say said tell told well good ok okay hi hello thanks thank please sure still even because while during without within between through yet per via etc`
- 边界：纯标点 / 全角字母 / 空串 → `[]`；`expandWeights` 得到空签名时 recall 直接返回 `[]`（recall.js:199）。

## 4 同义词（recall.js:31-67, 99-110）

全表（18 组，中文 ↔ 英文双向）：

```
记忆: memory, remember, mem    偏好: preference, prefer    时区: timezone, tz
插件: plugin, bundle, extension    会话: session, conversation    任务: task, todo, job
提醒: reminder, schedule, cron    权限: permission, approval, access    模型: model, llm
成本: cost, budget, token    测试: test, check    报错: error, bug, fail
部署: deploy, install    文档: doc, documents, readme    项目: project, workspace
搜索: search, query    历史: history, past    版本: version, release
```

- 双向表由 `SYNONYMS` 派生（recall.js:52-64）；只展开一跳（对 additions 不再展开）；直接 token 权重 1，别名 = 源权重 × 0.6（`ALIAS_WEIGHT`，recall.js:67,106）；已存在的 token 不覆盖（先直后别名，recall.js:101,108）。
- **硬门槛**：`scoreEntry` 中 `directHits === 0 && tagHit === 0` 直接 `return 0`（recall.js:170-176）。别名只能抬高已命中条目的 `matched`，**不能单独制造命中**；实测 query=`记忆` 对 text=`memory layer storage` 返回 `[]`。

## 5 打分（recall.js:161-186）

```js
entryTokens = new Set(tokenize(`${entry.text} ${(entry.tags ?? []).join(' ')}`))
matched     = Σ weight   for token ∈ weights ∩ entryTokens
totalWeight = Σ weight   for token ∈ weights                 // 含别名权重
directHits  = |{token ∈ weights ∩ entryTokens : weight >= 1}|
tagHit      = (entry.tags ?? []).some(t => weights.has(String(t).toLowerCase())) ? 1 : 0
if (directHits === 0 && tagHit === 0) return 0               // 硬门槛
denominator = min(totalWeight, entryTokens.size)             // 对称归一化
relevance   = matched / denominator
recency     = 0.5 ** (max(0, now - (updatedAt ?? createdAt ?? now)) / halfLifeMs)
importance  = clamp01(entry.importance ?? defaultImportance(entry))
score       = relevance × (0.55 + 0.45·recency) × (0.6 + 0.4·importance)
```

- 保留条件 `score >= MIN_SCORE`（0.12，recall.js:19,208），按 score 降序（同分保持输入顺序 = `store.list()` 的 updatedAt 降序）；分母取 `min(查询权重和, 条目 token 数)`，除以整条 query 会让长用户消息永远达不到阈值（recall.js:177-180）。
- 半衰期（`HALF_LIFE_HOURS`，recall.js:71；未知 kind 用 60 天）：

| kind | person | preference | fact | event | task |
|---|---|---|---|---|---|
| 半衰期 | 4320 h (180 d) | 2880 h (120 d) | 2160 h (90 d) | 720 h (30 d) | 168 h (7 d) |

- `defaultImportance`（recall.js:84-89）= `round(clamp01(base + tagBonus + confBonus) × 100) / 100`；`base = KIND_IMPORTANCE[kind] ?? 0.5`（person .8 / preference .85 / fact .6 / task .5 / event .4）；`tagBonus = tags 非空 ? 0.1 : 0`；`confBonus = [0, 0.05, 0.1][confidence]`，confidence 不 ∈{0,1,2}（含 undefined）→ 0.05。例：fact + 1 tag + conf1 → 0.75；event 无 tag → 0.45；preference 无 tag + conf2 → 0.95；写入时 recency = 1。

## 6 预算与渲染（recall.js:191-251；rules.js:16-21）

- 默认：`k=3`、`budgetTokens=300`、`minConfidence=0`、`now=Date.now()`（recall.js:192-195）；`estimateTokens(t) = ceil(String(t ?? '').length / 1.6)`（recall.js:157-159，UTF-16 长度）。
- `WRAPPER_TOKENS = 48`；`available = max(0, budgetTokens - 48)`（recall.js:21,213）。wrapper 行 75 字符 → estimateTokens 47，48 即由此而来。预算只对**命中行**计费，换行与 `</long-term-memory>`（19 字符）未计：k=3、每行 134 字符时整块 estimateTokens = **313**（实测）。对照口径：设计契约「≤300」按典型条目成立，严格上界是 313。
- 贪心装填（recall.js:211-221）：

```js
for (hit of scored) {                            // score 降序
  cost = estimateTokens(renderLine(hit.entry))   // 只算行，不算换行
  if (picked.length >= k) break                  // 条数判断先于预算
  if (spent + cost > available) continue         // 放不下就跳过，继续试下一条（不是 break）
  picked.push(hit); spent += cost
}
```

- `renderLine`（recall.js:233-237）：`- [mem:${id}] (${KIND_LABEL[kind]}) ${text}`；`confidence === 0` 追加 `（待确认）`。KIND_LABEL：fact 事实 / preference 偏好 / event 事件 / task 任务 / person 人物，未知 kind 原样。空命中返回 `''`（零注入；context 以 `required:false` 注册，index.js:355-359）。
- 注入块原文（recall.js:243-251，三行，行间 `\n`）：

```
<long-term-memory note="可能过时或不准；与用户当前说法冲突时以用户为准，并调用 memory op=remember 更新">
<命中行…>
</long-term-memory>
```

- 注入 query = 最后一条 user 消息文本，**截断 2000 字符**（recall.js:254-262）；按 `(agentId, query, storeRevision)` 记忆化，remember/forget 递增 revision 使其失效（index.js:312-321, 487, 508）。记忆块之后可能再拼跨会话历史块（rules.js:27-30；index.js:363），历史块不属于记忆层。

## 7 注入面 vs 工具面

| 面向 | k | budgetTokens | minConfidence | 数据源 | 依据 |
|---|---|---|---|---|---|
| 自动注入 | 3 | 300 | **1**（confidence 0 不注入） | `store.list()` active | rules.js:17-18；index.js:318 |
| `memory op=recall` | `limit` 默认 8、上限 8 | 800 | 0（显式给 0 才含待确认） | `store.list()` active | index.js:497-502；rules.js:20-21 |
| `memory op=list` | 上限 `MAX_LIST = 20` | — | — | `list({includeInactive})` | index.js:53, 513-516 |

- 过滤式：`minConfidence === 0 || (entry.confidence ?? 1) >= minConfidence`（recall.js:206）；无 confidence 字段的旧条按 1 计。`include_superseded`（list）：`true` → 含 `validUntil != null` 的历史条，行尾加 ` ~~已被 [mem:<supersededBy>] 取代~~`；默认 false 只列 active；墓碑无 `text`，两种模式都不出现。
- list 顺序 = `updatedAt` 降序后 `slice(0, limit)`（store.js:115-120；index.js:516）；limit 非数字或 0 → 20，负数不校验（边界未防，勿当作输入校验范例）。`stats().total` = 非墓碑记录数（含 retired），`active`/`byKind` 只数 active（store.js:232-245）。

## 8 工具返回文案（原文；`TEXT_OUTPUT` 只把 `text` 字段交给模型，index.js:96-101）

```js
// memory op=remember（index.js:485-495）
`${created ? '已记住' : '已更新'} [mem:${record.id}]（${record.kind}，重要度 ${record.importance}${superseded ? `；已取代 [mem:${superseded}]` : ''}；活动 ${store.stats().active} 条）`
// memory op=recall（index.js:502；renderHits index.js:128-133）：无命中 / 有命中
'没有匹配的记忆。'
`${renderRecallBlock(hits)}\n\n命中明细：\n` + hits.map(h => `- [mem:${h.entry.id}] score=${h.score.toFixed(2)}`).join('\n')
// memory op=forget（index.js:504-512）：成功 / 失败 / 缺 id 抛错
`已删除 [mem:${raw}]（剩余 ${store.stats().total} 条）`
`未找到 [mem:${raw}]，可能已删除。`
'memory: `id` is required for op=forget'
// memory op=list（index.js:513-522；renderList index.js:116-126）：正常 / 空库 / 行格式
`${renderList(entries, includeInactive)}\n\n活动 ${stats.active} 条 / 历史 ${stats.superseded} 条；按类型：${JSON.stringify(stats.byKind)}`
'记忆库为空。'
`- [mem:${entry.id}] (${entry.kind}, imp ${importance}${entry.subject ? ` subject=${entry.subject}` : ''}) ${entry.text}${entry.validUntil ? ` ~~已被 [mem:${entry.supersededBy ?? '?'}] 取代~~` : ''}`
// profile（index.js:527-542）：op=get / op=update / 缺 patch 抛错
JSON.stringify(store.profileGet(), null, 2)
JSON.stringify(store.profileSet(input.patch), null, 2)
'profile: `patch` object is required for op=update'
// 未知 op（index.js:523, 540）
`memory: unknown op "${op}"（可用：remember / recall / forget / list）`
`profile: unknown op "${input.op}"（可用：get / update）`
```

## 9 不变量（改代码也不能破坏）

1. 只有 active（`!validUntil`）条目可作取代候选；已退休条目不可再被取代，链只能向后追加。
2. 别名（0.6）不得单独制造命中：`directHits` / `tagHit` 门槛是精度下限，拆掉它就会往无关回合注入噪声。
3. 取代 ≠ 删除：`validUntil` / `supersededBy` / `supersedes` 只追加；唯一物理删除是 forget，且留墓碑，重载后不复活。
4. `id = sha1(kind \0 normalize(text).toLowerCase()).slice(0,12)`：同文本必同 id、改文本必新 id；不得掺时间戳/随机数。
5. 注入面只花 confidence ≥ 1 的记忆；空命中返回空串（零 token），不得注入空包装块。
6. 插件与 CLI 必须互操作同一目录：路径、字段名、JSON 形态、墓碑格式都是磁盘契约。
7. 阈值与公式逐字一致：`MIN_SCORE 0.12`、`ALIAS_WEIGHT 0.6`、`SUPERSEDE_JACCARD 0.55`、`SUPERSEDE_MIN_SHARED 6`、`WRAPPER_TOKENS 48`、`estimateTokens /1.6`、`relevance × (0.55+0.45r) × (0.6+0.4i)`，均不可「调参优化」；结果确定性（score 降序、同分保持输入顺序、装填无随机、预算不足跳过而非截断）。
8. 源实现与移植实现必须能被同一套差分输入判定为等价（`tests/differential.test.mjs` 的口径），包括上面这条自我取代的怪癖行为。

## 10 移植核对清单（PowerShell 7；先设 `$LIB`，命令形如 `node --input-type=module -e "import * as R from '$LIB/recall.mjs'; <ASSERT>"`，`# →` 后期望值）

```powershell
$LIB = 'file:///C:/Users/2006L/Documents/deepseek-harness/default-workspace/agent-memory/lib'  # 对照源码时换成 .../plugins/personal-agent/lib 且 .mjs → .js
```

1. `console.log(R.tokenize('记住我的偏好，preference 与 Memory').join('|'))` # → `preference|memory|记住|住我|的偏|偏好|与`
2. `console.log(JSON.stringify([R.tokenize('中'),R.tokenize('因为所以'),R.tokenize('我的')]))` # → `[["中"],["为所"],[]]`
3. `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';const r=JSON.parse(readFileSync('C:/Users/2006L/.dsh/storages/personal-agent/entries/9f770e1d8e03.json','utf8'));const n=t=>String(t).replace(/\s+/g,' ').trim();console.log(createHash('sha1').update(r.kind+'\u0000'+n(r.text).toLowerCase()).digest('hex').slice(0,12))` # → `9f770e1d8e03`
4. `console.log(R.defaultImportance({kind:'fact',tags:['a'],confidence:1}),R.defaultImportance({kind:'event'}))` # → `0.75 0.45`
5. `const now=1800000000000;console.log(R.decayOf({kind:'fact',updatedAt:now-7776000000},now))` # → `0.5`
6. `console.log(JSON.stringify([...R.expandWeights('记忆')]))` # → `[["记忆",1],["memory",0.6],["remember",0.6],["mem",0.6]]`
7. `console.log(JSON.stringify(R.recall([{id:'z',kind:'fact',text:'memory layer storage',tags:['layer'],confidence:1,updatedAt:1}],'记忆',{now:1})))` # → `[]`（别名不得单独命中）
8. `const e={id:'a',kind:'fact',text:'时区',tags:[],confidence:0,updatedAt:1};console.log(R.recall([e],'时区',{now:1}).length,R.recall([e],'时区',{now:1,minConfidence:1}).length)` # → `1 0`
9. `const e={id:'a',kind:'fact',text:'时区',tags:[],confidence:1,updatedAt:1};console.log(R.recall([e],'时区',{now:1,k:3,budgetTokens:300}).length,R.recall([e],'时区',{now:1,k:3,budgetTokens:48}).length)` # → `1 0`（先扣 48 wrapper）
10. `console.log(R.renderLine({id:'a',kind:'fact',text:'x',confidence:0}),'|',JSON.stringify(R.renderRecallBlock([])))` # → `- [mem:a] (事实) x（待确认） | ""`
