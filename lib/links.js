/**
 * 会话 → 界面的深链接（deep link）。
 *
 * 模型在回复里贴给用户一条 Markdown 超链接，用户点一下就把 Web GUI 切到
 * 「游戏素材大师」工作台，并直接落到对应的模块 / 项目 / 阶段上验收。
 *
 * 链接形态（故意做成普通 http(s) URL，理由见下）：
 *
 *   http://127.0.0.1:43120/?dsh-gmm=1&module=sprite&project=p1234&stage=videos
 *
 * 为什么必须是 http(s)：
 * 会话正文的 Markdown 渲染器对链接做了协议白名单（只放行 http/https/mailto，
 * 见 dsh-client-ui-primitives 的 sanitizeUrl），自定义 scheme 会被丢掉、
 * 连 <a> 都不生成，模型写了也点不动。
 *
 * 为什么带 origin：
 * 浏览器半区在 apply 时把自己真实的 `location.origin` 与 `location.pathname`
 * 报给宿主（reportClientOrigin），宿主据此拼出可点链接。宿主自己并不知道对外
 * origin（可能被反代改写过）；DSH 0.2.1 的 `--public-url` 还允许带路径前缀，
 * 所以 `pathname` 也要一起报。
 * 没收到过上报时退化成 http://localhost —— 即使 origin 不对也没关系：
 * 浏览器半区装了一个捕获阶段的点击拦截器，只按 **路径与查询参数** 匹配，
 * 命中就 preventDefault 并原地切面板，根本不会发生跳转。
 *
 * 兜底：用户若用中键 / Ctrl+点击 强制新开标签页，链接会真的被浏览器打开，
 * 应用在 `/?dsh-gmm=…` 上正常启动，浏览器半区读取查询参数完成同样的切换。
 * 两条路径共用同一份 `OpenIntent`，所以行为一致。
 */
/** 深链接的查询参数名。浏览器半区（src/client.ts）里有一份同名常量，改动要同步。 */
export const OPEN_QUERY_KEY = "dsh-gmm";
/** 工作台在 `main` 槽里的 key，也是侧栏 `sidebar.panellist` 的 id。 */
export const PANEL_KEY = "gameStudio";
/** 七个模块的 key。 */
export const STUDIO_MODULES = ["sprite", "image", "sequence", "rig", "tile", "map", "music"];
/** 八方向图的四个阶段。 */
export const SPRITE_STAGES = ["images", "videos", "frames", "sheet"];
/** 音乐生成编辑（模块七）的三个阶段：生成 / 编辑 / 导出。 */
export const MUSIC_STAGES = ["compose", "generate", "edit", "export"];
/**
 * 地图地块的四个阶段。
 *
 * ⚠️ 这里**故意不含 `template`**：模板（参考图）已经不是单独一步了，
 * 它在「生成地块」开始时按当前占格形状自动准备（见 `tilegen.ensureTemplates`）。
 * 老的 `stage=template` 深链接会被忽略（`TILE_STAGES.includes` 不通过）。
 */
export const TILE_STAGES = ["generate", "review", "map", "export"];
/**
 * 地图编辑器（模块六）的四个阶段。
 *
 * 与模块五（AI 生成地块）不同，这条链路**全本地**：导入素材 → 自动连接 → 画地图 →
 * 导出。所以阶段名是素材 / 自动连接 / 地图 / 导出；`rules`（自动连接）没有可配的
 * 东西、由宿主自动完成，界面里不显示它，但 key 保留 —— 对话面的
 * `stage=assets|rules|paint|export` 契约不能变。
 */
export const MAP_STAGES = ["assets", "rules", "paint", "export"];
/** 深链接里 `scale` 允许的取值范围（与 `maptiles.parseAssetScale` 同一套）。 */
export const OPEN_SCALE_MIN = 1;
export const OPEN_SCALE_MAX = 8;
/**
 * 深链接里整图占格的取值范围（与 `maptiles.STAMP_MIN_CELLS / STAMP_MAX_CELLS` 同一套）。
 * 真正的业务上限是**地图大小**，那条由宿主按项目校验；这里只挡明显离谱的值。
 */
export const OPEN_STAMP_MIN = 2;
export const OPEN_STAMP_MAX = 512;
/** 深链接里 `dialog` 允许的取值（别的值一律丢掉，别把链接当任意指令用）。 */
export const OPEN_DIALOGS = ["add"];
/** 深链接里 `shape` 允许的取值（与 `maptiles.TilesetShape` 同一套）。 */
export const OPEN_SHAPES = ["plain", "corner16", "a2quad", "stamp"];
/**
 * `asset` 必须是**项目资源目录下的相对路径**：不接受绝对路径、不接受 `..`
 * （资源路由另有目录穿越拦截，这里先把脏值挡在意图之外，免得把坏链接带进界面）。
 */
export function isSafeAssetPath(value) {
    if (typeof value !== "string")
        return false;
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.startsWith("/") || trimmed.startsWith("\\"))
        return false;
    if (trimmed.includes("..") || trimmed.includes("\\"))
        return false;
    return true;
}
let clientOrigin = "";
/**
 * 应用挂在哪个路径前缀下（DSH 0.2.1 的 `--public-url https://host/prefix/`）。
 *
 * 反代把 `/prefix/*` 剥掉再转给 DSH，所以浏览器看到的地址是
 * `https://host/prefix/`，而宿主只知道根路径。界面挂载时把自己的
 * `location.pathname` 一起报上来，宿主拼深链接与产物 URL 时补回去。
 * 空串 = 挂在根路径（本地默认）。
 */
let clientBasePath = "";
/** 把 `location.pathname` 收敛成「不带尾部斜杠、也不带 /index.html」的前缀。 */
function normalizeBasePath(value) {
    if (typeof value !== "string")
        return "";
    const raw = value.trim();
    if (raw === "" || raw === "/")
        return "";
    if (!raw.startsWith("/") || raw.includes("\\") || raw.includes(".."))
        return "";
    const path = raw.replace(/\/index\.html?$/iu, "").replace(/\/+$/u, "");
    return path === "" || path === "/" ? "" : path;
}
/**
 * 浏览器半区上报真实 origin（可选带应用路径前缀）。只接受 http(s)，其它一律忽略。
 *
 * `basePath` 省略时退回 `origin` 自带的路径：传 `https://host/prefix` 与
 * `{ origin: "https://host", basePath: "/prefix" }` 等价。
 */
export function rememberClientOrigin(origin, basePath) {
    if (typeof origin !== "string")
        return false;
    let parsed;
    try {
        parsed = new URL(origin);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return false;
    clientOrigin = parsed.origin;
    clientBasePath = normalizeBasePath(basePath === undefined ? parsed.pathname : basePath);
    return true;
}
/** 已上报的 origin；没有就返回空串。 */
export function clientOriginOf() {
    return clientOrigin;
}
/** 已上报的应用路径前缀（`""` = 根路径）。 */
export function appBasePath() {
    return clientBasePath;
}
/**
 * 把宿主里的根路径（`/dsh-game-material-master/...`）补上应用前缀。
 *
 * 所有回给浏览器的 `assetBase` 都走这里：反代只把 `/prefix/*` 转给 DSH，
 * 少了前缀就会 404（界面表现为「图裂了」）。
 */
export function assetBasePath(path) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${clientBasePath}${normalized}`;
}
/**
 * 拼链接用的 origin。
 *
 * 没收到上报时给 `http://localhost`：这个值只影响「链接看起来像什么」，
 * 点击仍然由浏览器半区的拦截器按路径匹配处理，所以错也无害。
 */
export function originForLinks() {
    return clientOrigin === "" ? "http://localhost" : clientOrigin;
}
/** 只保留有意义的字段，保证同一次意图生成同一条链接（便于断言与去重）。 */
export function normalizeIntent(intent) {
    const out = {};
    if (intent === undefined)
        return out;
    if (intent.module !== undefined && STUDIO_MODULES.includes(intent.module)) {
        out.module = intent.module;
    }
    if (typeof intent.projectId === "string" && intent.projectId !== "")
        out.projectId = intent.projectId;
    if (typeof intent.jobId === "string" && intent.jobId !== "")
        out.jobId = intent.jobId;
    if (typeof intent.stage === "string" && intent.stage !== "")
        out.stage = intent.stage;
    if (typeof intent.scoreId === "string" && intent.scoreId !== "")
        out.scoreId = intent.scoreId;
    if (typeof intent.direction === "string" && intent.direction !== "")
        out.direction = intent.direction;
    if (typeof intent.dialog === "string" && OPEN_DIALOGS.includes(intent.dialog))
        out.dialog = intent.dialog;
    if (isSafeAssetPath(intent.asset))
        out.asset = intent.asset.trim();
    if (typeof intent.frames === "number" && Number.isInteger(intent.frames) && intent.frames > 0)
        out.frames = intent.frames;
    if (typeof intent.shape === "string" && OPEN_SHAPES.includes(intent.shape))
        out.shape = intent.shape;
    if (typeof intent.scale === "number" && Number.isInteger(intent.scale) && intent.scale >= OPEN_SCALE_MIN && intent.scale <= OPEN_SCALE_MAX)
        out.scale = intent.scale;
    for (const key of ["cols", "rows"]) {
        const value = intent[key];
        if (typeof value === "number" && Number.isInteger(value) && value >= OPEN_STAMP_MIN && value <= OPEN_STAMP_MAX)
            out[key] = value;
    }
    if (intent.keyed === 1)
        out.keyed = 1;
    return out;
}
/** 意图 → 查询串（不含 `?`）。 */
export function intentQuery(intent) {
    const normalized = normalizeIntent(intent);
    const params = new URLSearchParams();
    params.set(OPEN_QUERY_KEY, "1");
    for (const key of ["module", "project", "job", "stage", "score", "direction", "dialog", "asset", "frames", "shape", "scale", "cols", "rows", "keyed"]) {
        const value = key === "project"
            ? normalized.projectId
            : key === "job"
                ? normalized.jobId
                : key === "score"
                    ? normalized.scoreId
                    : key === "frames"
                        ? normalized.frames === undefined
                            ? undefined
                            : String(normalized.frames)
                        : key === "scale"
                            ? normalized.scale === undefined
                                ? undefined
                                : String(normalized.scale)
                            : key === "cols" || key === "rows" || key === "keyed"
                                ? normalized[key] === undefined
                                    ? undefined
                                    : String(normalized[key])
                                : normalized[key];
        if (value !== undefined)
            params.set(key, value);
    }
    return params.toString();
}
/**
 * 拼出可点击的绝对链接。
 *
 * 默认用 `origin + 应用前缀`：DSH 0.2.1 的 `--public-url` 允许带路径前缀，
 * 只拼 origin 会让回链落到反代根路径而不是应用本身。显式传 `origin` 的
 * 调用点（自检 / 测试）保持原语义，不会额外补前缀。
 */
export function buildOpenLink(intent, origin = `${originForLinks()}${clientBasePath}`) {
    return `${origin}/?${intentQuery(intent)}`;
}
/**
 * 解析查询串回意图。宿主侧只用于自检与测试——浏览器半区另有一份等价实现
 * （client.ts 是经典脚本，不能 import），两边靠 scripts/verify-tools.mjs 的
 * 文本契约钉住同名参数。
 */
export function parseIntentQuery(query) {
    const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
    if (params.get(OPEN_QUERY_KEY) === null)
        return undefined;
    const intent = {};
    const module = params.get("module");
    if (module !== null && STUDIO_MODULES.includes(module))
        intent.module = module;
    const projectId = params.get("project");
    if (projectId !== null)
        intent.projectId = projectId;
    const jobId = params.get("job");
    if (jobId !== null)
        intent.jobId = jobId;
    const stage = params.get("stage");
    if (stage !== null)
        intent.stage = stage;
    const scoreId = params.get("score");
    if (scoreId !== null)
        intent.scoreId = scoreId;
    const direction = params.get("direction");
    if (direction !== null)
        intent.direction = direction;
    const dialog = params.get("dialog");
    if (dialog !== null)
        intent.dialog = dialog;
    const asset = params.get("asset");
    if (asset !== null)
        intent.asset = asset;
    const frames = Number(params.get("frames"));
    if (params.get("frames") !== null && Number.isFinite(frames))
        intent.frames = frames;
    const shape = params.get("shape");
    if (shape !== null)
        intent.shape = shape;
    const scale = Number(params.get("scale"));
    if (params.get("scale") !== null && Number.isFinite(scale))
        intent.scale = scale;
    for (const key of ["cols", "rows"]) {
        const value = Number(params.get(key));
        if (params.get(key) !== null && Number.isFinite(value))
            intent[key] = value;
    }
    if (params.get("keyed") === "1")
        intent.keyed = 1;
    return normalizeIntent(intent);
}
