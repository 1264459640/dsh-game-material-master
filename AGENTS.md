# AGENTS.md

给在本仓库里干活的编码 agent 的说明。

- 人看的入门文档 → [README.md](README.md)
- 算法细节、自检契约、历史踩坑 → [docs/ENGINEERING.md](docs/ENGINEERING.md)

本文不重复上面两份，只写**干活时必须知道的事**和**发布流程**。

---

## 这是什么

DSH 插件「游戏素材大师」：从一张角色设定图出发批量产出游戏素材。火山方舟 **Seedream** 生图、
**MiniMax** 图生视频，抠像 / 抽帧 / 像素量化 / 合图全部在本机用 `ffmpeg` + 内置 JS 完成。

| 模块 | key | 状态 |
|---|---|---|
| 八方向图生成 | `sprite` | 正式 |
| 图片生成 | `image` | 正式 |
| 序列帧生成 | `sequence` | 正式 |
| 骨骼动画生成 | `rig` | **实验性**（页签带角标、进入弹窗、模块内常驻提示条） |
| 45°地图地块生成 | `tile` | **实验性**（45° 等距地块 → 拼成地图；AI 生成地块） |
| 地图编辑器 | `map` | **实验性**（参照 AsLib 的 RPG Map Maker：一屏、纯图标、零术语；素材列表 + 新增（属性一次定死）、内置素材默认在列表且可删可恢复、地图环绕、自动连接、动画地块（翻页图）、一键生成；**全本地零计费**） |

---

## 硬约束（改错了不报错，只是静默坏掉）

| 约束 | 原因 |
|---|---|
| `src/client.ts` **必须是经典脚本**：不能有 `import` / `export`，React 元素一律 `React.createElement` | 它由宿主以 `/plugins/dsh-game-material-master/client.js` 直接发给浏览器，浏览器半区不参与打包。构建脚本 `scripts/strip-client-export.mjs` 会剥掉结尾的 `export`，但别指望它兜住真正的模块化写法 |
| 改完 `lib/` 里的**宿主半区**必须重启 DSH | 宿主半区是进程启动时冻结的模块图。开发时可另起测试宿主 + `scripts/dev-overlay.yml` 拿 `patchReload` 热重载，见 ENGINEERING.md「开发时的宿主半区热重载」 |
| 改完 `lib/client.js` 只需刷新浏览器 | 客户端束由宿主按请求从磁盘读，带 `rev` 指纹 |
| **没有任何运行时依赖** | `zod` / `cordis` / dsh-typert-protocol 等一律从 DSH 自身安装树解析；`node_modules` 与 lock 文件不入库 |
| `lib/` **入库**（不是构建产物目录） | 包直接以 `main: lib/index.js` 发布，`npm publish` 不触发构建 |
| 生成类调用必须带 loading 反馈，批量任务要按 `job.targets` 盖住**还没轮到**的方向 | 不盖遮罩时界面看着完全正常，只是「点了没反应」，用户会反复点——每次点击都真实计费。`verify-client.mjs` / `verify-feedback.mjs` 会拦 |
| 新增产物子目录时，`SERVABLE_DIRS`（`src/index.ts`）必须同步加一条 | 静态资源路由按**第一段路径**比对白名单，漏掉就 403。界面只表现为「图裂了」、不报错——转圈截帧的 `turn/` 就踩过。模块六是**四处**同步：`SERVABLE_MAP_DIRS` / `AssetScope` 类型 / `resolveAssetTarget` 分支 / `SCOPES` 数组，`verify-map-gateway.mjs` 会真调一遍路由 |
| 模块六：**客户端只能执行宿主下发的绘制计划**，不许自己算变体 / 形状 / chunk / 坐标变换 | 界面里唯一允许复刻的是 `MAP_pointToCell` / `MAP_cellAnchor` / `MAP_cellTopLeft` / `MAP_lineCells` 四个坐标函数（命中测试必需），且有黄金对照盯着；**连「哪些 chunk 可见」都由宿主算**（`mapPlan({view})` 回 `visibleKeys`）。多写一套口径就是旧模块「预览好看、导出位移」的老路，`verify-map-client.mjs` 会扫源码拦 |
| 模块六：**环绕（wrap）是默认行为**，凡涉及「邻居」的地方都必须先取模 | 网格、命中测试、绘制范围、脏块、自动连接的邻域判断都要 wrap。漏掉一处的表现是「接缝处形状不对 / 撤销后画面花掉」，只在贴边时看得出来 —— `verify-map.mjs` 里有「画第 0 行必须连带弄脏最后一行」这条断言，且配了非环绕的反向验证 |
| 模块六：**界面文案不许出现旧术语** | 用户对第一版的反馈就是「门槛太高、专业名词太多」。`verify-map.mjs` 与 `verify-map-client.mjs` 各扫一遍**模块六那一段**（`模块六 · 地图编辑器` 到下一个分节注释），`地形族 / 掩码 / 优先级 / 切分 / 图集 / 变体种子 / 高度偏移 / Tiled / 等距` 0 命中，`chunk` 按**词边界**判（所以协议字段 `"chunks"` 可以照实写 —— 曾经为了骗过这条自检写出过 `"chu" + "nks"`，那种写法比术语本身更坏）。⚠️ **只有模块六这一段**：`图集`（模块④ Spine 图集）与 `等距`（模块⑤ 45° 地块）在别处是正确的词，全文件扫会误伤 |
| 模块六：**派生数据不落盘**（形状判定 / 动画帧 / 视口范围 / chunk 一律现算） | 落盘的只有素材原图、`project.json`、`map.json`（每层每格的语义序号）。旧模块存了 `buildings` / `buildingGround` / `map.pixel` 三份缓存，各自都出过「过期后凭空多出一栋楼」这类 bug |
| 模块六：A2 素材在**图层数据里存的是「代表序号」**，一小格不是一笔 | 调色板对 A2 素材只出一个笔刷（`MapViewTileset.palette`），`maprender` 见到所属素材 `shape === "a2quad"` 就展开成 4 条象限 op。少了这条分支，用户拿自动连接笔刷刷下去只会画出一个 16px 小格 —— 不报错 |
| 界面文案一律写 `T("中文原文")`，并往 `src/client.ts` 的词条表补英文 | 中文原文就是 key；漏翻不会报错，只是那一条一直是中文。`verify-i18n.mjs` 会拦 |
| **模块级**（工厂顶层）出现 `T()` 的文案表要同步加进 `staticTextRebuilders` | 模块顶层的 `T()` 在插件 load 时就求值了，那时 locale 服务还没挂上，此后永远停在中文。实测表现：切英文后方向名 / 模块页签不动。函数体内的 `T()` 不受影响 |
| 浏览器半区往宿主加字段时，`src/wire.ts` 里那条方法的 `payload:` schema 必须同步加 | typert 按声明的 schema 校验 payload，**schema 里没有的键会被静默丢掉**。实测：给 `getProject` 带上 `lang` 却没进 schema，宿主永远读到 `undefined`，表现是「切了英文提示词还是中文」且不报任何错 |
| 新增配置字段必须同时在 `src/index.ts` 的 `saveConfig` `directKeys` 白名单里加一条 | 白名单外的键会被**静默丢掉**：界面显示已保存、`config.json` 没变、不报任何错。`comfy*` 那十个键是这么加的。⚠️ 唯一例外是**凭据类**字段（`arkApiKey` / `minimaxApiKey` / `comfyCookies`）：它们**不进**白名单——白名单是原样透传，凭据要先归一化 / trim，所以在 `saveConfig` 函数体里单独处理 |
| 视频**按节点上记的 `backend` 分派**（`src/videogen.ts`），两个后端的 taskId 都是字符串 | `comfyVideo` 是全局开关，用户可能中途改设置；按当前配置去查就会拿 MiniMax 的接口查 ComfyUI 的 `prompt_id`（表现：一边报「任务不存在」、另一边永远 pending）。新增视频字段时 `VideoNode` / `TurnVideoNode` 的 `backend?` 要一起写 |
| ComfyUI 工作流是**用户自己的 JSON**，注入前必须过 `parseComfyWorkflow` + `detectComfyBindings`，不许写死节点 id | 节点 id 与输入名由用户装的自定义节点决定。「首帧图」尤其危险：`LoadImage` 只代表一张图，首尾帧各用其一，搞错会**静默**把首帧顶掉（`verify-comfy.mjs` 盯这条） |
| 后台任务表（`pipeline` / `seqgen` / `riggen`）**每次 `apply` 都要复位**（`activatePipeline()` / `activateSequence()` / `activateRig()`） | DSH 重载插件时 `ctx.effect` 的清理会把模块级的 `disposed` 置为 true，而 Node 模块缓存留着**同一个模块对象**——不可逆。症状：**所有生成类调用**都只回一句「任务已在进行中」，按钮点了没反应、项目日志一条不加，而上传源图 / 查状态 / 测试连接全正常。`activate*()` 就是给重载留的复位入口；`kick()` 失败时用 `kickFailure()` 区分「真在跑」与「实例已废」 |
| 内置默认提示词（`src/directions.ts`）中英各一份，改一份必须改另一份 | 它会真的发给生图 / 视频模型，不是界面装饰。`verify-host.mjs` 的 5b 段按语言逐条比对两侧 |
| 起 ffmpeg / ffprobe 一律走 `src/media.ts` 的 `ffmpegPath()` / `ffprobePath()`，别写死 `"ffmpeg"`、也别只读 `process.env` | Windows 上 ffmpeg 常常「装了但不在 `PATH` 里」，而 `setx` 设的环境变量又继承不到已经在跑的进程。这两个函数会继续查注册表与 WinGet / Scoop / Chocolatey 的常见位置——绕过它们就是「自检全绿、真机报找不到 ffmpeg」 |

---

## 构建与自检

```bash
npm run build        # tsc → lib/，并剥掉浏览器束结尾的 export
npm run typecheck    # 只做类型检查
```

纯本地自检（不联网、不花钱），改完代码**至少跑这几个**：

```bash
node scripts/verify-host.mjs       # 宿主全链路（322 项）
node scripts/verify-client.mjs     # 浏览器半区契约（348 项）
node scripts/verify-tools.mjs      # 对话调用面（147 项）
node scripts/verify-pipeline.mjs   # 抽帧 / 抠像 / 合成（40 项）
node scripts/verify-feedback.mjs   # 浏览器半区真渲染（161 项，含功能管理、侧栏菜单与语义保存错误）
node scripts/verify-i18n.mjs       # 中英词条表契约（9 项）
node scripts/verify-comfy.mjs      # 本地 ComfyUI 后端（113 项，自起 mock ComfyUI，纯本地、不用装 ComfyUI）
node scripts/verify-rig-runtime.mjs  # 骨骼改动：官方 Spine 4.2 实际加载/IK/Path/FFD/顶点求值（开发依赖）
node scripts/verify-tile.mjs       # 地图地块几何内核（147 项，含反向验证）
node scripts/verify-tile-pipeline.mjs  # 地图地块数据层与流水线（115 项；⚠️ 需要先跑过 e2e-tile-live 生成过地块，否则会在拼图阶段直接抛）
node scripts/verify-tile-gateway.mjs   # 地图地块走真实网关（81 项：payload / 验收 / 作废边界 / 建筑 / 布局冻住 / 保存往返）
node scripts/verify-tile-client.mjs    # 地图地块界面真渲染（200 项，拦「遮罩没出现」「地图不显示」这类静默问题）

node scripts/verify-map.mjs            # 地图编辑器几何 / 环绕 / 自动连接内核（113 项，含反向验证与术语黑名单）
node scripts/verify-map-pipeline.mjs   # 地图编辑器数据层与流水线（235 项，含 A2 每格 4 条 op、动画循环、dropKeys、导出逐字段）
node scripts/verify-map-gateway.mjs    # 地图编辑器走真实网关（153 项，含资源路由 403 / 目录穿越 / 并发提交）
node scripts/verify-map-client.mjs     # 地图编辑器界面真渲染 + 黄金对照（220 项：坐标函数逐点一致、drawImage 序列 == 宿主计划、挂载首帧 == 同视口的计划）
```

`scripts/find-missing-i18n.mjs` 不是断言脚本，是**工具**：列出所有还没进词条表的
`T("…")` 原文，直接输出可粘贴的条目。加了新界面文案时先跑它。

`scripts/make-map-sample-tileset.mjs` 是模块六**内置素材**的生成器：默认纯程序化、确定性
（同一输入两次生成逐字节一致，`--check` 会断言形状/变体真的互不相同）；`--ark --yes` 会改用
火山引擎生成纹理再本地合成，**这一步真实计费**，别顺手跑。

其余脚本（`verify-rig*.mjs`、`e2e-*.mjs` 等）的覆盖范围见 ENGINEERING.md 的「自检脚本」表。
`e2e-map.mjs` 是模块六的**真实链路端到端**（不联网、不花钱）：它会**故意把产物留在**
`<DSH_HOME>/game-material-master/map-jobs/` 下并打印绝对路径，方便人眼验收。
`e2e-*.mjs` / `probe-redraw.mjs` 会**真实调 API 花钱**，不要顺手跑。

### ⚠️ 自检全绿 ≠ 界面对

界面 / 摆放口径的 bug **反复**出现「自检全绿、真机坏」。改界面或几何之后，
除了跑自检，必须照 ENGINEERING.md「真机视觉验证的四类盲区」逐条自查。
四个名字本身就够当清单：

1. **拿自己的公式验自己** —— 契约要和**宿主的真实产出**比，不是和我的推导比。
2. **只测了一个方向** —— 摆放是二维的，垂直对了不代表水平对。
3. **夹具选了不暴露问题的样本** —— 用**贴边**的格子，别总用正中。
4. **只在「已经存过」的状态试** —— 新建 / 已存 / 刚改未存 / 老数据缺字段，四个入口都要试。

另外：判断「有没有位移」要量 `getBoundingClientRect()` 或截图逐像素比，
别只读 `style.top` 这类字符串 —— `transform` 与贴图自然尺寸也参与定位，
数值一样、位置照样不同。

---

## 提交约定

Conventional Commits，中文描述：`feat(rig): …` / `docs: …` / `fix(sprite): …`。
仓库历史里能直接找到例子。改动要与代码同批提交，不要留「代码已改、文档待补」的半成品。

---

## 发布到 npm

包名 [`dsh-game-material-master`](https://www.npmjs.com/package/dsh-game-material-master)，
发布账号 **kuangthree**，`license: MIT`，`access: public`（默认）。

### 已发布版本

| 版本 | 发布时间（UTC） | 内容 |
|---|---|---|
| `0.1.0` | 2026-09-21 23:22 | 首个公开发布 |
| `0.1.1` | 2026-09-22 15:20 | README 重写为展示版（11 张 Playwright 实拍截图 + mermaid 流程图 + 「用对话驱动」章节）；`package.json` 补 `repository` / `homepage` / `bugs`。**无源码改动** |
| `0.2.0` | 2026-09-24 14:19 | 阶段①新增「**转圈截帧**」并设为默认（一段原地匀速转一整圈的绿幕视频 → 本机抽候选帧 → 时间轴八圆圈截出八个方向；逐方向生图保留为备选）；`fix(chroma)` 角色贴边时不再把自己的颜色当背景（实测 160/160 帧被吃掉最多 1.8 万像素角色）；数字输入框改为失焦/回车提交；序列帧缩略图双击看大图；`turn/` 进资源路由白名单 |
| `0.2.1` | 2026-09-30 14:18 | 合并 PR #2（来自 qiufl）：适配新版 DSH 的 strict codec `create()` 契约（`fix(typert)`，含 revert 后修正版）；阶段①「提取序列帧」新增**手动选帧**功能，15 文件 +1387 行 |
| `0.3.0` | 2026-10-05 12:56 | 新增**多语言支持**（界面文案与内置提示词跟随 DSH 语言设置，中 / 英，`feat(i18n)`，README 增加英文版）；新增模块五「**45°地图地块生成**」（实验性：等距地块 → 拼成整张地图，`feat(tile)`）；另有 `fix(tools)` 工具返回值统一过 `jsonSafe`、`fix(scripts)` verify-live-bundle 兼容 |
| `0.4.0` | 2026-10-09 14:12 | 设置页新增「**功能管理**」（`feat(settings)`）：逐个开关五个模块，隐藏后界面上不再出现它的页签与侧栏菜单项，**对话工具面同样拒绝调用**（`game_material_call` / `status` / `intake` / `upload` / `wait` / `review` / `approve`），且可见性只能由用户在设置页里改；侧栏「游戏素材大师」入口上新增**快捷菜单按钮**，点击直接弹出五个功能 |

下一次发布请**在表中追加一行**，写明版本、UTC 时间与内容。

### ⏳ 已改好版本号、**尚未发布**：`0.6.0`

`package.json` 已是 `0.6.0`，但**还没有** `npm publish`（发布由用户决定）。
（`0.5.0` 从未发布；它当初的模块六实现已被下面这次重做整体取代，所以这里只写 0.6.0 的内容。）内容：

> **模块六「地图编辑器」推倒重做**（`feat(map)`，实验性，**全本地零计费**）：参照
> [AsPJT/AsLib](https://github.com/AsPJT/AsLib/tree/master) 的 **RPG Map Maker** 改成**一屏、纯图标、零术语** ——
> 左侧素材调色板 + 12 个图标按钮，右侧画布，选一张素材图就能开画。
> 素材形态（RPG Maker A2 拼块 / 整格 16 块 / 普通图块）由尺寸**自动识别**，识别错了一个下拉改；
> **地图四周环绕**（相机、命中、绘制范围、脏块、邻域判断全部取模）；一格的 A2 自动连接由宿主
> 展开成 **4 条象限 op**（客户端仍然只 `drawImage`）；**动画地块**走 op 上的 `cycle` + 全局帧号；
> 自带一套**程序化生成的内置素材**（4 张 A2 + 1 张道具，水有 2 帧动画；AsLib 的 pipo 素材是第三方
> 版权，不打包）；新增**一键生成**（随机铺满 / 迷宫 / 大陆，同种子逐字节可复现）。
> 编辑协议新增 **`dropKeys`**：界面把缓存的 chunk key 报上来，宿主只回「真正失效的那几个」，
> 于是界面里连 chunk 计算都没有；`mapPlan` 改成按视口查询（`view` + `have`）。
> **删除**：2:1 等距、多地图、图层高度 / 不透明度 / 类型 / 锁定、地形族与掩码编辑器、掩码覆盖率、
> Tiled `.tmj`/`.tsj` 导出、带图例的自有 JSON、切片 contact sheet；`map-jobs/<id>/maps/` 目录消失
> （单张地图直接落 `map.json`）。wire 方法删 4 个（`saveMapFamilies` / `createMapDoc` /
> `deleteMapDoc` / `duplicateMapDoc`）、加 2 个（`runMapGenerate` / `importSampleTileset`）。
> 自检脚本同步重写：`verify-map` / `-pipeline` / `-gateway` / `-client` 四件 + `e2e-map.mjs`。
> ⚠️ **改完必须重启 DSH**（宿主半区），且对话面方法枚举会在重启后更新。
>
> **另含本地 ComfyUI 视频后端**（`feat(comfy)`，可选、不影响默认链路）：设置页新增「本地 ComfyUI
> （图生视频）」，勾选后**只有「图生视频」这一步**改走本机 ComfyUI（替代 MiniMax）——工作流用
> **API 格式** JSON，注入点（提示词 / 宽高 / 时长 / 种子 / 首尾帧）自动探测，工作流里没连的 optional
> `IMAGE` 输入按 `/object_info` 的节点定义自动补一个 `LoadImage`，内置模板就是 FreeVideo 那条链路；
> 新增 `src/comfy.ts`（客户端）、`src/videogen.ts`（后端分派，按**节点上记的** `backend` 查任务）、
> `scripts/verify-comfy.mjs`（113 项，自起 mock ComfyUI）、配置项 `comfy*` 十一个（多出的 `comfyCookies` 专供鉴权反代，不进 `directKeys`），wire 新增 `testComfy`
> （manifest 方法数 130 → 131）。生图 / 抠像 / 抽帧 / 合图不变。
>
> 两块内容一起发时版本按 minor 提（`0.7.0`）；只发模块六就仍是 `0.6.0`。

发布时按下面的流程走，并**把这段挪进上面的「已发布版本」表**（补上 UTC 时间）。

### 流程

```bash
# 0. 确认 lib/ 与 src/ 同步：build 之后 git status 不应出现 lib/ 的改动
npm run build
git status --short

# 1. 手工把 package.json 的 version 提上去
#    （纯文档 / 元数据改动走 patch；功能改动按 semver 判断，实验性模块的新功能也走 minor）

# 2. 提交并打 tag
git add -A
git commit -m "docs: …"
git tag v0.1.1
git push origin main
git push origin v0.1.1     # ← 必须显式推！--follow-tags 只推附注标签，不推轻量标签

# 3. 若 README 引用仓库内的图片，先确认线上绝对 URL 已经 200
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://raw.githubusercontent.com/universe-st/dsh-game-material-master/main/docs/images/gmm-00-workbench.png"

# 4. 预览将要发布的内容（files 白名单）
npm pack --dry-run

# 5. 发布
npm publish
```

### 发布后的验证

registry 有**分钟级传播延迟**，不要看到 404 就以为发布失败：

```bash
# 版本端点通常 1 分钟内从 404 变 200
curl -s "https://registry.npmjs.org/dsh-game-material-master/0.1.1" | head -c 200

# dist-tag 更慢，实测约 2 分钟后 latest 才切到新版本
npm view dsh-game-material-master dist-tags
```

实测时间线（0.1.1）：`npm publish` 返回 `+ dsh-game-material-master@0.1.1` 后，
版本端点约 1 分钟内 404 → 200，`latest` 约 2 分钟后从 `0.1.0` 切到 `0.1.1`。

### 发布相关的几个坑

- **`git push --follow-tags` 不会推轻量标签。** `git tag v0.1.1`（不带 `-a`）是轻量标签，
  必须 `git push origin v0.1.1` 单独推。漏了就出现「commit 在远端、tag 只在本地」。
- **README 里的图片必须用绝对 URL。** npmjs.com 不可靠地解析相对图片路径，用
  `docs/images/x.png` 在 GitHub 上正常、在 npm 包页面上是裂图。所以统一写
  `https://raw.githubusercontent.com/universe-st/dsh-game-material-master/main/docs/images/x.png`。
  代价是仓库内改图后要跟着改 URL，别写成相对路径「图方便」。
- **截图不进 npm tarball。** `files` 白名单只有 `lib` / `README.md` / `README.en.md` /
  `cordis.patch.yml`，`docs/` 不发布——这也是上一条必须用绝对 URL 的原因。
  tarball 约 415 kB / 32 个文件。
- **两份 README 要成对改。** `README.md` 是中文原文，`README.en.md` 是英文版，
  两边顶部各有一条指向对方的**绝对**链接（npm 包页面解析不了相对路径，理由同上一条）。
  改了结构或数字（自检项数、tarball 大小等）就两边一起改。
- **`npm publish` 不触发构建。** 忘了 `npm run build` 就会把旧的 `lib/` 发出去。
  第 0 步的 `git status` 检查就是防这个。

### README 截图怎么重拍

截图由 Playwright 对着真实运行的 DSH Web 界面拍摄，原图在 `docs/images/`，命名 `gmm-NN-<模块>-<阶段>.png`。
重拍时注意：

- 只截**插件面板**，不要把 DSH 侧栏 / 会话列表截进去：对 `.SPR_root` 做元素截图
  （设置页则裁到 `[role=dialog]` 的范围）。
- 深链接可以直接把界面切到目标页面：`http://127.0.0.1:<port>/?dsh-gmm=1&module=sprite&project=<id>&stage=videos`。
- **设置页截图必须处理 API Key 回显**（界面显示脱敏尾号），用局部模糊盖掉再入库。














