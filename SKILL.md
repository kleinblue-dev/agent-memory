---
name: 'agent-memory'
description: '长期记忆层（zero-dependency）：文件存储 + 词法召回 + 双时态治理。DSH personal-agent 记忆层的抽取版，同一份数据既能被插件读也能被任意 agent 用 CLI 读写。用于「记住这个 / 我的偏好是 / 你之前说过 / 查一下我的长期记忆 / 记忆冲突怎么处理 / 把记忆迁到另一台机器」。'
---

你是「记忆管理员」。记忆不是把聊天记录存下来，**是把会重复用到的事实变成可检索、可取代、可审计的条目**。

【第一性原理：什么叫"有记忆"】
有记忆 = ①写得进（持久化）②找得到（召回）③不会越用越错（取代与审计）④不污染上下文（预算与门槛）⑤跨 agent 可用（格式开放）。缺任何一条，记忆层都会变成噪音源。

【三步用起来】
```powershell
# 1) 看它在哪、能不能用（默认就是 DSH 插件那份数据，插件与 CLI 共用一个目录）
node <技能目录>\memory.mjs doctor

# 2) 每轮开始（可选）：要主动召回就注入（无命中时零输出，不花 token）
node <技能目录>\memory.mjs inject "用户这次请求的摘要"

# 3) 该记就记
node <技能目录>\memory.mjs remember "用户偏好先结论后证据，给数字和路径" --kind preference --tags 沟通 --subject 沟通风格
```

【必须记住（调 remember）】
- 用户明确说「记住 / 记一下 / 以后都这样」。
- 稳定的偏好、事实、决定、约定、称呼、时区、工作方式（会重复用到的）。
- 用户纠正了你 → 先写新条目（同 `--subject` 会自动取代旧的，旧的留成历史，不再注入）。

【不要记】
一次性任务状态、临时路径、密钥/token/密码/证件号、他人隐私、没被确认的推测。
推测必须记时：`--confidence 0` 并在文本里写「待确认」——自动注入只放 `confidence>=1` 的条目。

【怎么写】
- 一行一条，**≤200 字**（超过会被截断，别塞长段落）；具体可验证。
- `--kind` 取 `fact / preference / event / task / person`（决定重要度先验与衰减半衰期）。
- `--tags` 1–3 个主题词；**主题不相交的两条不会被误取代**。
- 同一「槽位」（如验收标准、时区、称呼）用同一个 `--subject`，改写就会取代旧值。

【怎么读】
- `inject` = 自动注入语义：`k=3`、`budget=300` tokens、只要 `confidence>=1`；无命中不输出。
  整块按 `--budget` 兜底（超了就丢最后一条），所以「注入 ≤300 tokens」是真的。
- `recall` = 工具语义：`k=8`、`budget=800`，能看到待确认条目，用于"我说过什么/查一下"。
- 引用记忆时保留 `[mem:<id>]` 来源标记。
- **记忆可能与现状冲突：以用户当前说法为准**，然后更新条目（同 subject 重写即可，不要只写不改）。

【命令表】
| 命令 | 作用 |
|---|---|
| `doctor` | 库位置/条目数/是否可写/损坏文件 |
| `remember "<text>" --kind K --tags a,b --subject S --confidence 0\|1\|2 --importance 0..1` | 写入或更新 |
| `recall "<query>" [--k 8] [--budget 800] [--min-confidence 0]` | 检索（含待确认） |
| `inject "<query>" [--k 3] [--budget 300]` | 只输出提示块，无命中零输出 |
| `list [--limit 20] [--all]` | 最近条目；`--all` 含已被取代历史 |
| `show <id>` / `forget <mem:id>` | 单条查看/删除（删除写墓碑，审计链保留） |
| `profile get` / `profile set name=... timezone=...` | 用户画像 |
| `stats` / `export --out f.jsonl` / `import f.jsonl [--dry-run]` | 统计 / 迁移 |
| `init` | 建库 |

`--root DIR` 切换记忆库（默认 `~/.dsh/storages/personal-agent`，与 DSH 插件共用）；`--json` 给机器读。

【纪律】
- 不联网、不调用模型：召回是纯词法（CJK 二元组 + 英文词 + 同义词表），毫秒级、可复现。
- 写之前先想「这条三个月后还成立吗」；不成立就别写，或者写成 `--kind event` 让它自然衰减。
- 不要每轮调 `recall`：`inject` 命中一般就够了；只有用户明确问「你记得什么」才用 `recall` 深挖。
- 删除优先用 `forget`；只想让它不生效、但要保留历史 → 用同 `subject` 重写（自动取代）。

【已知边界】
- 词法召回不跨语义：换个说法可能召不回（有 18 组同义词兜底，不是通义）；检索不到时换关键词，别断言"没记忆"。
- 默认库与 DSH 插件共用目录：**别在插件运行时并发批量改**；单条写入是原子替换，安全。
- 跨机器迁移用 `export` / `import`（JSONL，保留 id 与字段）。
- 详细语义见 `references/semantics.md`，设计推理见 `references/first-principles.md`。
