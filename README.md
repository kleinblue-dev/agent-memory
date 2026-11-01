# agent-memory

> 一个零依赖、单机、可审计的长期记忆层。给任意 agent 用：CLI 或 import 都行。

从 [dsh-plugin-personal-agent](https://github.com/kleinblue-dev) 1.4.1 的记忆层抽取而来：**同一份磁盘格式**，
插件和这个 CLI 可以共用一个记忆目录 —— 不需要迁移，也不会写出两份真相。

```bash
node memory.mjs doctor                                    # 在哪、能不能用
node memory.mjs remember "用户偏好先结论后证据" --kind preference --tags 沟通 --subject 沟通风格
node memory.mjs inject "回答风格"                          # 自动注入语义：3 条 / 300 tokens / 只要确认过的
node memory.mjs recall "我之前说过什么关于部署的"            # 工具语义：8 条 / 800 tokens
```

## 为什么不是「把聊天记录丢进向量库」

| 第一性原理 | 本项目的取舍 |
|---|---|
| 提示装配是**同步**的，网络调用会阻塞或变陈旧 | 纯本地词法召回，一次扫描 < 5 ms |
| 一个**错的**记忆比没有记忆更糟 | 硬门槛：同义词只能**排序**命中，不能**创造**命中（precision > recall） |
| 记忆会**变**，旧值不能凭空消失 | 双时态：`validFrom/validUntil` + `supersededBy` 审计链，从不物理删除 |
| 上下文是有限预算 | 逐条装入 + token 估算，装不下就跳过（不截断条目） |
| 用户可能说错、模型可能猜错 | `confidence 0/1/2`，自动注入只放 ≥1；猜测标「待确认」 |
| 一个 agent 的私有格式 = 锁死 | 一文件一条目 + JSONL 导出/导入 + 开放 schema |

## 特性

- **零依赖**：只用 Node 内置模块（`node:fs` / `node:crypto`），Node ≥ 18。
- **与插件互操作**：默认目录 `~/.dsh/storages/personal-agent`，和 DSH personal-agent 插件共用。
- **写安全**：写临时文件 + rename 原子替换；删除写墓碑；损坏的条目文件跳过而不拖垮整库。
- **双时态取代**：同 `subject` 重写自动取代旧条；无 subject 时用 Jaccard(≥0.55, ≥6 共享 token) 识别「同一句话说第二遍」。
- **词法召回**：CJK 二元组 + 英文词，18 组中英同义词（别名权重 0.6），类型先验 × 时间衰减 × 重要度。
- **三种读法**：`inject`（自动注入，安静时零输出）/ `recall`（工具检索）/ `list`（浏览）。
- **迁移**：`export` / `import`（JSONL）。按记录**原样落盘**：id、`createdAt/validFrom/updatedAt`、
  `validUntil/supersedes/supersededBy` 取代链、`profile` 全部保留；被取代的历史条目不会被复活，
  当前真相不会被旧值顶掉；墓碑不迁移（留在源库）。同 id 已存在默认跳过，`--force` 才覆盖。

## 存储格式

```
<root>/entries/<id>.json     # 一条一个文件
<root>/profile.json          # 用户画像：name / timezone / locale / preferences / notes
```

```jsonc
{
  "id": "9f770e1d8e03",        // sha1(kind \0 lower(text))[:12]
  "kind": "fact",               // fact | preference | event | task | person
  "text": "video-publish 技能已上线：repo …",
  "tags": ["video-publish", "skill"],
  "confidence": 1,              // 0=待确认 1=用户确认 2=用户明说
  "importance": 0.75,           // 0..1，检索权重
  "subject": "video-publish 技能", // 槽位键：同 subject 重写会取代
  "createdAt": 1793536500805,
  "validFrom": 1793536500805,
  "validUntil": null,           // null = active
  "supersedes": null,
  "supersededBy": null,
  "updatedAt": 1793536500805
}
```

## 召回算法（可以照着重写）

```
tokens   = CJK 二元组（去停用）+ 小写英文/数字词（去停用）
weights  = 直接命中 1.0 ，同义词命中 0.6
gate     = 必须 ≥1 个 direct hit 或 tag hit，否则 score=0   ← 别名不能单独创造命中
score    = relevance × (0.55 + 0.45 × recency) × (0.6 + 0.4 × importance)
relevance= matchedWeight / min(总权重, 条目 token 数)        ← 对称归一化
recency  = 0.5 ^ (年龄 / 半衰期)；半衰期：person 180d / preference 120d / fact 90d / event 30d / task 7d
预算     = 300 tokens（注入，k=3）或 800 tokens（工具，k=8）；wrapper 先扣 48
         注意：插件原实现的 300 只约束命中行，整块实测上界 313；CLI 的 inject 另加一层整块兜底，
         保证 `estimateTokens(block) <= --budget`（默认 300）
```

## CLI

| 命令 | 说明 |
|---|---|
| `doctor` | 库位置、活动/历史条数、可写性、损坏文件 |
| `remember <text> [--kind] [--tags a,b] [--subject] [--confidence 0\|1\|2] [--importance] [--session ID]` | 写入/更新（同内容幂等） |
| `recall <query> [--k N] [--budget N] [--min-confidence N]` | 检索，返回命中块 + score 明细 |
| `inject <query> [--k 3] [--budget 300]` | 只输出可注入块；无命中不输出（零 token） |
| `list [--limit 20] [--all]` | 最近条目；`--all` 显示被取代历史 |
| `show <id>` / `forget <mem:id>` | 单条查看 / 删除（墓碑） |
| `profile get` / `profile set k=v …` / `profile json '{...}'` | 用户画像 |
| `stats` / `export [--out f.jsonl]` / `import <f> [--dry-run] [--force]` | 统计 / 迁移 |
| `init` | 建库 |

全局：`--root DIR`（或环境变量 `PA_MEMORY_ROOT`）、`--json`。退出码：0 成功 / 1 用法错误 / 2 环境错误。

作为库用：

```js
import { openStore } from './lib/store.mjs'
import { recall, renderRecallBlock } from './lib/recall.mjs'

const store = openStore({ root: process.env.PA_MEMORY_ROOT })
const block = renderRecallBlock(recall(store.list(), userText, { k: 3, budgetTokens: 300, minConfidence: 1 }))
// block === '' 时不要拼进 prompt
```

## 测试

```bash
node --test
```

共 **63 条**，全部离线（真实记忆库只做只读校验，执行前后 SHA256 快照必须一致）：

- `tests/memory.test.mjs`（26 条）：分词/打分/治理/CLI 全链路，含「inject 整块不超预算」「同 id 重写不显示自取代」
  和「export→import 原样迁移（历史不复活、profile 跟着走）」。
- `tests/differential.test.mjs`（6 条）：**差分测试** —— 把插件原始实现与移植版跑同一批输入，断言 token、权重、分数、
  选中集合、取代链、统计逐项相同。插件源码不在本机时自动 skip（`PA_PLUGIN_DIR` 指向它即可跑）。
- `tests/adversarial.test.mjs`（31 条）：随机语料/随机写序列差分、真实库只读哈希、损坏文件、退出码、
  `--root` 优先级、迁移保真契约。

## 已知边界

- 词法召回不跨语义：18 组同义词是手工小表，换个说法可能召不回；检索不到时换关键词。
- 单机文件存储：适合 < 5k 条；不处理多进程同时写同一批条目（单条写入是原子替换）。
- 不存二进制/长文：`text` 上限 200 字，超长请拆条。
- 与 DSH 插件共用目录时，请避免在插件运行期间批量 import/export。

## License

MIT，见 [LICENSE](LICENSE)。
