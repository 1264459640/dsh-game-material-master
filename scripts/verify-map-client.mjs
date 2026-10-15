#!/usr/bin/env node
/**
 * 地图编辑器（模块六）· **浏览器半区真渲染 + 黄金对照**自检。纯本地，不花钱。
 *
 * 这条自检盯三类事：
 *
 * ① **界面复刻的那点几何是对的**。模块六的原则是「宿主算计划、界面只执行」，
 *    界面里唯一自己写的几何就是 `MAP_pointToCell` / `MAP_cellAnchor` /
 *    `MAP_cellTopLeft` / `MAP_lineCells`。这四个函数拿宿主 `mapgeom` / `mapdoc`
 *    的**真实现**逐点比对 —— 不是拿我推的公式比（推导错了断言照样绿）。
 *    环绕开 / 关两组各整张地图采样 + 图外点，另配两条反向验证证明比对有区分力。
 *
 * ② **预览 = 导出**。把面板真渲染起来，抓它发给 canvas 的 `drawImage` 调用序列，
 *    与宿主 `mapgen.mapPlan` 对**同一视口**给出的计划逐项比对：条数、顺序、
 *    目标像素、源矩形，以及 `__mapDrawStats`（画了几条 / 缺图源几条）。
 *    A2 拼块的「一格 4 条」、动画的「同格不同帧取不同矩形」、环绕接缝的负数 chunk
 *    都在这条链路上验。
 *
 * ③ **界面结构与纪律**。左列调色板（8 列 / 可选中 / 可滚动）、12 个图标按钮、
 *    顶栏没有阶段条、空态两个按钮、实验性弹窗、术语黑名单、每个 `SPR_` 类都有 CSS。
 *
 * 用法：node scripts/verify-map-client.mjs [lib/client.js]
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// 整个脚本跑在一个 mkdtemp 出来的临时 DSH_HOME 里，结束连同项目一起删掉。
const HOME = await mkdtemp(join(tmpdir(), "dsh-map-client-"));
process.env.DSH_HOME = HOME;

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
/** 诊断输出：不作为断言（用来把「已知缺陷」的量级摆出来，而不是猜）。 */
function note(text) {
  console.log(`  · ${text}`);
}

const target = process.argv[2] ?? fileURLToPath(new URL("../lib/client.js", import.meta.url));
const G = await import("../lib/mapgen.js");
const GEOM = await import("../lib/mapgeom.js");
const DOC = await import("../lib/mapdoc.js");
const TILES = await import("../lib/maptiles.js");
const { encodePng } = await import("../lib/png.js");

// ══ 0. 夹具：宿主真跑一份数据，界面读同一份 ════════════════════════════════
section("0) 夹具（宿主真跑：建项目 → 装内置素材 → 画几笔）");

/** 每块一个可辨色的素材图（普通形态，用于 corner16 / plain 的另一条路）。 */
function makeTilesetPng(tileSize, columns, rows) {
  const width = tileSize * columns;
  const height = tileSize * rows;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < columns * rows; index++) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const offset = ((row * tileSize + y) * width + column * tileSize + x) * 4;
        rgba[offset] = (index * 53) % 256;
        rgba[offset + 1] = (index * 29) % 256;
        rgba[offset + 2] = (index * 83) % 256;
        rgba[offset + 3] = 255;
      }
    }
  }
  return encodePng(rgba, width, height);
}

let projectId = "";
let propBrush = 0;
let a2Brush = 0;
let a2TilesetId = "";
let propTilesetId = "";
try {
  const project = await G.createMapProject("客户端自检", { grid: { tileWidth: 32, tileHeight: 32, wrap: true }, cols: 32, rows: 32 });
  projectId = project.id;
  check("宿主侧项目建好（32×32、环绕开）", projectId !== "" && project.cols === undefined && project.grid.wrap === true && project.grid.tileWidth === 32, JSON.stringify(project.grid));

  const sample = await G.importSampleTileset(projectId);
  check("内置素材装进来了（4 张 A2 拼块 + 1 张道具网格）", sample.tilesets.filter((ts) => ts.shape === "a2quad").length === 4 && sample.tilesets.filter((ts) => ts.shape === "plain").length === 1, sample.tilesets.map((ts) => `${ts.name}:${ts.shape}`).join(" / "));

  const view0 = await G.mapView(await G.readMapProject(projectId));
  const a2 = view0.tilesets.find((ts) => ts.shape === "a2quad");
  const prop = view0.tilesets.find((ts) => ts.shape === "plain");
  a2TilesetId = a2.id;
  propTilesetId = prop.id;
  a2Brush = a2.palette[0].index;
  propBrush = prop.palette[0].index;
  check("A2 素材在**宿主视图**的调色板里只有一个条目（点它 = 自动连接笔刷）", a2.palette.length === 1 && a2.palette[0].rect.width === 32 && a2.palette[0].rect.height === 32, JSON.stringify(a2.palette));
  check("普通素材的调色板是一格一条（道具网格 8 列 × 5 行 = 40 条）", prop.palette.length === 40, `${prop.palette.length}`);

  // 画一片：A2 的 2×2 方块（验「一格 4 条 op」与自动连接）+ 两个道具格；
  // 第二层再画两笔 —— 单层预览要能证明「过滤真的发生了」。
  await G.applyMapOps(projectId, [
    {
      kind: "paint",
      layerId: "l0",
      cells: [
        { r: 8, c: 8, tile: a2Brush },
        { r: 8, c: 9, tile: a2Brush },
        { r: 9, c: 8, tile: a2Brush },
        { r: 9, c: 9, tile: a2Brush },
        { r: 3, c: 3, tile: propBrush },
        { r: 3, c: 4, tile: propBrush }
      ]
    }
  ]);
  await G.applyMapOps(projectId, [{ kind: "paint", layerId: "l1", cells: [{ r: 20, c: 20, tile: propBrush }, { r: 21, c: 20, tile: propBrush }] }]);
  const doc0 = await G.readTheDoc(projectId);
  check("地图上真的画了东西（两层各自有内容）", DOC.filledCount(doc0, "l0") === 6 && DOC.filledCount(doc0, "l1") === 2, `l0=${DOC.filledCount(doc0, "l0")} l1=${DOC.filledCount(doc0, "l1")}`);

  // ══ 1. 浏览器束与假 React ════════════════════════════════════════════════
  section("1) 浏览器束与假 React（有状态、会重渲染）");
  const source = readFileSync(target, "utf8");

  /**
   * 迷你 React：真的**有状态、会重渲染**。
   *
   * 模块六的面板挂载后要异步拉数据（项目列表 → 视图 → 计划 → 画布），
   * 只渲染一次的桩根本走不到画布，黄金对照也就无从谈起。
   * 每个 Hook 按槽位存状态，`setState` 排一次重渲染，`useEffect` 在提交后跑，
   * 依赖数组相同就跳过（与 React 语义一致，避免无限循环）。
   */
  let cursor = 0;
  let cells = [];
  function resetHooks() {
    cells = [];
  }
  /**
   * 用**临时的一份 Hook 存储**渲染别的组件，结束后原样换回来。
   *
   * ⚠️ 直接 `resetHooks()` 会把正在测的面板状态一起清掉（表现是「后面全变空态」）。
   * 单独渲染弹窗这类子组件时必须用这个。
   */
  async function withFreshHooks(render) {
    const saved = cells;
    cells = [];
    try {
      return await render();
    } finally {
      cells = saved;
    }
  }
  let pendingRender = false;
  let effects = [];
  const HOOK_MISMATCH = [];
  /**
   * 还有几次宿主调用没回来。
   *
   * ⚠️ 这个计数器是**必须的**：面板的 async effect 要经过好几个 await 才把状态写回来
   * （读 project.json → 读 map.json → 算计划），只盯 `pendingRender` 的话，
   * 中间那几轮「还没回来、也没有新 setState」会被判成「已经稳定」而提前收工 ——
   * 表现是「刚拖完视口 / 刚点完撤销，断言读到的是上一步的状态」，**随机**失败。
   */
  let inFlight = 0;
  /**
   * 面板的防抖定时器（op 批量提交 40ms / 计划查询 32ms）。
   *
   * ⚠️ 这里**不能**像旧版那样让 `setTimeout` 同步跑掉：真机上 effect 的 cleanup
   * 会在下一次提交时 `clearTimeout`，于是「挂载时按还没缩放的视口查的那一次」
   * 根本不会发生。同步跑掉的话那道查询会真的发出去，还会把按旧视口裁的 chunk
   * 灌进缓存 —— 表现是「自检里首帧缺一大片」（真实浏览器没有这个问题），
   * 白白诬告一处代码。所以改成**可取消的定时器队列**：先渲染、先跑 effect
   * （cleanup 已经执行），稳定之后才把还活着的定时器放出来（见 renderTree）。
   */
  const timers = new Map();
  let timerSeq = 0;
  function pumpTimers() {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  }
  /**
   * 面板的轮询定时器（`view.busy === true` 时每 1.5s 重读一次项目）。
   *
   * ⚠️ 必须有真的实现：导出 / 预览是**宿主后台作业**，提交那次读到的还是「进行中」，
   * 界面靠这个轮询才把新产物读回来（ENGINEERING.md 里记过这条：真机导出约 2s 后
   * 文件列表自己冒出来）。以前这里返回 0 什么都不做，于是「提交完界面不刷新」这条
   * 路径在自检里**根本走不到**。这里只登记、由测试显式 `tickTimers()` 放出来。
   */
  const intervals = new Map();
  let intervalSeq = 0;
  /** 放一次轮询（与真机的「又过了 1.5s」等价），再等宿主调用落地。 */
  async function tickIntervals() {
    const due = [...intervals.values()];
    if (due.length === 0) return false;
    for (const fn of due) fn();
    let quiet = 0;
    for (let tick = 0; tick < 240; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
      if (inFlight > 0) quiet = 0;
      else if (++quiet >= 3) break;
    }
    return true;
  }
  /** 把队列里还活着的定时器放出来，再等宿主调用落地（模拟「又过了 40ms」）。 */
  async function tickTimers() {
    const polled = await tickIntervals();
    if (timers.size === 0) {
      if (!polled) return;
      return;
    }
    pumpTimers();
    let quiet = 0;
    for (let tick = 0; tick < 240; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
      if (inFlight > 0) quiet = 0;
      else if (++quiet >= 3) break;
    }
  }

  /**
   * 画布调用抓取。
   *
   * ⚠️ 按 `clearRect` 切帧：面板每次重渲染都会**整幅重画**，把调用累在一个数组里
   * 再 `slice` 只能碰运气（多跑一轮 pass 就多一份）。每帧一份数组，
   * 「最后一帧」就是这一帧画面真正执行的 `drawImage` 序列。
   */
  const drawFrames = [];
  let currentFrame = null;
  const fillRects = [];
  let clears = 0;
  let lastFillStyle = "";
  /** 动画帧号：面板用 rAF + Date.now 推时钟，这里把 rAF 排队、由测试推进。 */
  const rafQueue = new Map();
  /** 「等待稳定超时」的记号每次 renderTree 最多说一次（它每轮都会触发，不然刷屏）。 */
  let settleNotes = 0;
  let rafSeq = 0;

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
  const frameOf = () => (drawFrames.length === 0 ? [] : drawFrames[drawFrames.length - 1]);
  /** 帧序列里的一条：9 参数形式的 drawImage。 */
  const isDrawImage = (call) => call.args.length >= 9;

  let fileClicks = 0;
  function makeNode(type) {
    const node = {
      type,
      style: {},
      children: [],
      width: 0,
      height: 0,
      dataset: {},
      /**
       * 视口量出来就是整张地图大小（32×32×32px = 1024）：
       * 黄金对照要求「计划覆盖到的每一格」都在可见范围内。
       */
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 900, height: 520, right: 900, bottom: 520 };
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      appendChild() {},
      remove() {},
      click() {
        fileClicks++;
      }
    };
    if (type === "canvas") {
      const ctx = {
        __isContext: true,
        canvas: node,
        globalAlpha: 1,
        imageSmoothingEnabled: true,
        setTransform() {},
        clearRect() {
          clears++;
          currentFrame = [];
          drawFrames.push(currentFrame);
        },
        fillRect(x, y, w, h) {
          fillRects.push({ fillStyle: lastFillStyle, x, y, w, h });
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        fill() {},
        drawImage(...args) {
          if (currentFrame === null) {
            currentFrame = [];
            drawFrames.push(currentFrame);
          }
          currentFrame.push({ args, sx: args[1], sy: args[2], sw: args[3], sh: args[4], dx: args[5], dy: args[6], dw: args[7], dh: args[8], tilesetId: args[0]?.dataset?.tilesetId ?? null });
        }
      };
      // fillStyle 是普通属性：单层预览的绿底靠它认（`rgb(56,170,68)`）。
      Object.defineProperty(ctx, "fillStyle", {
        get: () => lastFillStyle,
        set: (value) => {
          lastFillStyle = String(value);
        }
      });
      node.getContext = () => ctx;
    }
    return node;
  }

  const ReactStub = {
    Fragment: Symbol.for("react.fragment"),
    createElement(type, props, ...children) {
      // ⚠️ 真 React 会把 children 放进 `props.children`，函数组件靠它取子节点。
      // 只挂在元素上（不放进 props）的话，`Btn` 这类组件渲染出来**全是空按钮**。
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      const element = { type, props: merged, children };
      // 对象 ref（useRef 的返回值）在提交后指向真实节点；函数 ref 走 __pendingRefs。
      if (element.props.ref !== null && typeof element.props.ref === "object") {
        element.props.ref.current = makeNode(type === "canvas" ? "canvas" : "div");
      }
      if (typeof element.props.ref === "function") {
        const node = makeNode(type === "canvas" ? "canvas" : "div");
        node.dataset = { ...(element.props["data-tileset"] ? { tilesetId: element.props["data-tileset"] } : {}) };
        globals.__pendingRefs.push({ element, node });
      }
      return element;
    },
    /**
     * ⚠️ 每个 Hook 都要**捕获当前那份存储**（`const store = cells`）。
     * 直接用模块级 `cells` 的话，`withFreshHooks` 换回来之后，迟到的 `setState`
     * 会写进**别人的存储**（表现是「面板上一堆断言突然全错位」）。
     */
    useState(initial) {
      const index = cursor++;
      const store = cells;
      if (!(index in store)) store[index] = typeof initial === "function" ? initial() : initial;
      return [
        store[index],
        (next) => {
          const value = typeof next === "function" ? next(store[index]) : next;
          /**
           * ⚠️ 必须和 React 一样**值没变就跳过重渲染**（`Object.is`）。
           *
           * 无脑 `pendingRender = true` 的后果有两个：
           * ① 每个 effect 里那句「设置成同一个值」（`setMeasured(true)` 之类）都会让
           *    「等界面稳定」的循环永远静不下来，每轮白跑 220 个 tick 才被硬截断 ——
           *    自检里满屏 `⚠️ 等待稳定超时`，而且是**半渲染**的树，偶发误报就来自这里；
           * ② 组件里为了省一次重画而故意返回同一个对象（`setHover(prev => …)`）在自检里
           *    完全体现不出来，跟真机不一致。
           */
          if (Object.is(value, store[index])) return;
          store[index] = value;
          pendingRender = true;
        }
      ];
    },
    useRef(initial) {
      const index = cursor++;
      const store = cells;
      if (!(index in store)) store[index] = { current: initial };
      return store[index];
    },
    useMemo(fn, deps) {
      const index = cursor++;
      const store = cells;
      const slot = store[index];
      if (slot === undefined || slot === null || !sameDeps(slot.deps, deps)) store[index] = { deps, value: fn() };
      return store[index].value;
    },
    useCallback(fn, deps) {
      const index = cursor++;
      const store = cells;
      const slot = store[index];
      if (slot === undefined || slot === null || !sameDeps(slot.deps, deps)) store[index] = { deps, value: fn };
      return store[index].value;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const store = cells;
      const slot = store[index];
      if (slot === undefined || slot === null || !sameDeps(slot.deps, deps)) {
        store[index] = { deps };
        effects.push(fn);
      }
    },
    useLayoutEffect(fn, deps) {
      ReactStub.useEffect(fn, deps);
    },
    useContext() {
      return undefined;
    }
  };

  /** 系统「减少动态效果」开关：动画那一段要能翻转它。 */
  let reduceMotion = false;
  const globals = { __pendingRefs: [], __cleanups: [] };
  const LOADED = [];
  const windowStub = {
    // 打开面板自带的帧统计（默认关）：画不出东西时靠它区分「没计划 / 缺图源 / 坐标飞了」
    __mapDebug: true,
    __ModuleLoader__: { load: (registration) => LOADED.push(registration) },
    location: { origin: "http://127.0.0.1:19387", search: "", href: "http://127.0.0.1:19387/" },
    devicePixelRatio: 1,
    /**
     * ⚠️ 原生 prompt 的**假实现**：记录下来，断言模块六一次都没碰它。
     *
     * 真机坏在这里：DSH 桌面端是 Electron，`window.prompt` 存在但一调用就抛错
     * （`typeof` 判断看不出来），于是「新建项目」点了毫无反应。面板必须自带对话框，
     * 这条桩就是用来钉住「不许再依赖原生 prompt」的 —— 返回 null 会让旧写法什么都不建。
     */
    __promptCalls: [],
    __confirmCalls: [],
    confirm(message) {
      windowStub.__confirmCalls.push(message);
      return true;
    },
    prompt(message, defaultValue) {
      windowStub.__promptCalls.push({ message, defaultValue });
      return null;
    },
    history: {
      replaceState(_state, _title, url) {
        const next = new URL(url, windowStub.location.href);
        windowStub.location.href = next.toString();
        windowStub.location.search = next.search;
      }
    },
    matchMedia: (query) => ({
      matches: query.includes("prefers-reduced-motion") ? reduceMotion : false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }),
    requestAnimationFrame: (fn) => {
      const id = ++rafSeq;
      rafQueue.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafQueue.delete(id);
    },
    /**
     * 面板里的 setTimeout 用来做 op 批量提交 / 计划查询的防抖。
     * 入库但**不自动执行**：由 renderTree 在「effect 都跑完、状态稳定」之后统一放出来，
     * 这样 effect 的 cleanup（clearTimeout）语义与真机一致（见上面的 timers 注释）。
     */
    setTimeout: (fn) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: (fn) => {
      const id = ++intervalSeq;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
    document: undefined
  };
  globalThis.window = windowStub;
  globalThis.setTimeout = windowStub.setTimeout;
  globalThis.clearTimeout = windowStub.clearTimeout;
  globalThis.setInterval = windowStub.setInterval;
  globalThis.clearInterval = windowStub.clearInterval;
  globalThis.document = {
    head: { appendChild() {}, removeChild() {} },
    createElement: (type) => makeNode(type),
    addEventListener() {},
    removeEventListener() {},
    hidden: false
  };
  globalThis.URL = URL;

  try {
    new Function("window", "require", source)(windowStub, (name) => {
      if (name === "react") return ReactStub;
      throw new Error(`未预期的 require(${name})`);
    });
    check("浏览器束可加载（经典脚本 + 假 React）", true);
  } catch (error) {
    check("浏览器束可加载（经典脚本 + 假 React）", false, String(error?.message ?? error));
    throw error;
  }
  check("注册了唯一插件体", LOADED.length === 1, `${LOADED.length} 个`);

  let bundle;
  try {
    bundle = LOADED[0].factory((name) => {
      if (name === "react") return ReactStub;
      throw new Error(`未预期的 require(${name})`);
    });
    check("factory 可执行", true);
  } catch (error) {
    check("factory 可执行", false, String(error?.message ?? error));
    throw error;
  }

  const REGISTERED = {};
  const fakeCtx = {
    effect: (fn) => fn(),
    get: () => undefined,
    slots: {
      register: (options, component) => void (REGISTERED[options.name] = component),
      inject: (name, fn) => fn()
    },
    remote: { $mount: () => Promise.resolve() }
  };
  bundle.apply(fakeCtx);
  check("apply 可执行", true);

  const test = bundle.__test ?? {};
  const { MapModule, MapExperimentalDialog, MAP_pointToCell, MAP_cellAnchor, MAP_cellTopLeft, MAP_lineCells } = test;
  check("产物带出 MapModule 与实验性弹窗", typeof MapModule === "function" && typeof MapExperimentalDialog === "function");
  check(
    "产物带出四个黄金对照函数（命中测试必需的那份复刻）",
    typeof MAP_pointToCell === "function" && typeof MAP_cellAnchor === "function" && typeof MAP_cellTopLeft === "function" && typeof MAP_lineCells === "function"
  );
  check(
    "产物里不再有 MAP_visibleChunks / MAP_chunkKey（chunk 计算全在宿主）",
    test.MAP_visibleChunks === undefined && test.MAP_chunkKey === undefined,
    Object.keys(test).filter((key) => /chunk|visible/i.test(key)).join(",")
  );
  if (typeof MapModule !== "function") throw new Error("没有 MapModule，后面没法测");

  // ══ 2. 黄金对照：界面复刻的几何 vs 宿主真实现 ════════════════════════════
  section("2) 黄金对照：四个坐标函数 vs 宿主 mapgeom / mapdoc");

  /** 客户端那份 layout 与宿主同形（自己造的字段它不读）。 */
  const layoutFor = (grid, cols, rows) => {
    const host = GEOM.layoutOf(grid, cols, rows);
    return { ...host, grid };
  };

  /**
   * 采样点：格中心 / 四角内侧 / 45% 偏移 / 贴边（左、上边线正好落在格上）。
   * 「贴边」是刻意选的：夹具总取正中时，`floor` 与 `round` 的差别看不出来。
   */
  function samplePoints(layout, cols, rows) {
    const points = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * layout.stepX;
        const y0 = r * layout.stepY;
        const center = GEOM.cellCenter(layout, r, c);
        points.push({ x: center.x, y: center.y, why: `center ${r},${c}` });
        points.push({ x: x0 + 0.5, y: y0 + 0.5, why: `topleft ${r},${c}` });
        points.push({ x: x0 + layout.stepX - 0.5, y: y0 + 0.5, why: `topright ${r},${c}` });
        points.push({ x: x0 + 0.5, y: y0 + layout.stepY - 0.5, why: `bottomleft ${r},${c}` });
        points.push({ x: x0 + layout.stepX - 0.5, y: y0 + layout.stepY - 0.5, why: `bottomright ${r},${c}` });
        points.push({ x: x0 + layout.stepX * 0.45, y: y0 + layout.stepY * 0.45, why: `45% ${r},${c}` });
        points.push({ x: x0, y: y0, why: `edge ${r},${c}` });
      }
    }
    return points;
  }
  /** 图外点：负数、超尺寸、远在天边、以及带小数的。 */
  function outsidePoints(layout) {
    return [
      { x: -1, y: -1 },
      { x: -0.5, y: -0.5 },
      { x: -layout.stepX * 3.5, y: -layout.stepY * 2.5 },
      { x: -1, y: layout.height / 2 },
      { x: layout.width / 2, y: -1 },
      { x: layout.width + 0.5, y: layout.height + 0.5 },
      { x: layout.width + layout.stepX * 2.3, y: layout.height + layout.stepY * 4.7 },
      { x: layout.width * 2, y: layout.height * 3 }
    ];
  }

  for (const grid of [
    { tileWidth: 32, tileHeight: 32, wrap: true },
    { tileWidth: 32, tileHeight: 32, wrap: false }
  ]) {
    const cols = 11;
    const rows = 7;
    const layout = layoutFor(grid, cols, rows);
    const hostLayout = GEOM.layoutOf(grid, cols, rows);
    const label = `32×32 wrap=${String(grid.wrap)}`;

    let anchorMismatch = 0;
    let anchorSamples = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const host = GEOM.cellAnchor(hostLayout, r, c);
        const client = MAP_cellAnchor(layout, r, c);
        anchorSamples++;
        if (host.x !== client.x || host.y !== client.y) anchorMismatch++;
      }
    }
    check(`${label}：cellAnchor 与宿主逐格一致（${anchorSamples} 格）`, anchorMismatch === 0, `${anchorMismatch} 格不同`);

    let topLeftMismatch = 0;
    let topLeftSamples = 0;
    for (const [w, h, ax, ay] of [[32, 32, undefined, undefined], [64, 96, 0.5, 1], [24, 24, 0.5, 0.5], [16, 40, 0, 0]]) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const host = ax === undefined ? GEOM.cellTopLeft(hostLayout, r, c, w, h) : GEOM.cellTopLeft(hostLayout, r, c, w, h, ax, ay);
          const client = ax === undefined ? MAP_cellTopLeft(layout, r, c, w, h) : MAP_cellTopLeft(layout, r, c, w, h, ax, ay);
          topLeftSamples++;
          if (host.x !== client.x || host.y !== client.y) topLeftMismatch++;
        }
      }
    }
    check(`${label}：cellTopLeft 逐格一致（含默认锚点 / 大贴图 / 自定义锚点，${topLeftSamples} 组）`, topLeftMismatch === 0, `${topLeftMismatch} 组不同`);

    let pointMismatch = 0;
    const points = [...samplePoints(layout, cols, rows), ...outsidePoints(layout)];
    for (const point of points) {
      const host = GEOM.pointToCell(hostLayout, point.x, point.y);
      const client = MAP_pointToCell(layout, point.x, point.y);
      if (host.r !== client.r || host.c !== client.c || host.inMap !== client.inMap) pointMismatch++;
    }
    check(`${label}：pointToCell 逐点一致（${points.length} 个点，含格中心 / 四角 / 贴边 / 图外）`, pointMismatch === 0, `${pointMismatch}/${points.length} 个点不同`);

    if (grid.wrap === true) {
      let inside = 0;
      for (const point of outsidePoints(layout)) {
        const client = MAP_pointToCell(layout, point.x, point.y);
        if (client.inMap === true && client.r >= 0 && client.r < rows && client.c >= 0 && client.c < cols) inside++;
      }
      check(`${label}：环绕下**图外点**折回图内（inMap 恒 true、坐标落在 0..rows/cols）`, inside === outsidePoints(layout).length, `${inside}/${outsidePoints(layout).length}`);
    } else {
      let outside = 0;
      for (const point of outsidePoints(layout)) {
        const client = MAP_pointToCell(layout, point.x, point.y);
        if (client.inMap === false) outside++;
      }
      check(`${label}：非环绕下**图外点**如实返回 inMap=false（不静默折回）`, outside === outsidePoints(layout).length, `${outside}/${outsidePoints(layout).length}`);
    }
  }

  // 反向验证：这两条证明上面的逐点比对**真的能抓错**，不是自证。
  {
    const wrapLayout = layoutFor({ tileWidth: 32, tileHeight: 32, wrap: true }, 11, 7);
    const flatLayout = layoutFor({ tileWidth: 32, tileHeight: 32, wrap: false }, 11, 7);
    const flatHost = GEOM.layoutOf({ tileWidth: 32, tileHeight: 32, wrap: false }, 11, 7);
    const crossing = [{ x: -1, y: -1 }, { x: 11 * 32 + 5, y: 7 * 32 + 5 }, { x: 400, y: 400 }];
    check(
      "反向验证：跨边界点上 wrap / 非 wrap 的结果确实不同（否则那条比对没有区分力）",
      crossing.every((point) => {
        const wrapped = MAP_pointToCell(wrapLayout, point.x, point.y);
        const flat = MAP_pointToCell(flatLayout, point.x, point.y);
        return wrapped.r !== flat.r || wrapped.c !== flat.c || wrapped.inMap !== flat.inMap;
      })
    );
    // 把 wrap 写死成 true 的错实现，在非环绕布局上必然与宿主不一致 —— 这就是上面那条比对能抓的东西。
    const hardcodedWrap = (x, y) => {
      const r0 = Math.floor(y / 32);
      const c0 = Math.floor(x / 32);
      return { r: ((r0 % 7) + 7) % 7, c: ((c0 % 11) + 11) % 11, inMap: true };
    };
    check(
      "反向验证：若把 wrap 写死成 true，非环绕布局上就会与宿主不一致（逐点比对能抓出来）",
      crossing.some((point) => {
        const wrong = hardcodedWrap(point.x, point.y);
        const host = GEOM.pointToCell(flatHost, point.x, point.y);
        const client = MAP_pointToCell(flatLayout, point.x, point.y);
        return (wrong.r !== host.r || wrong.c !== host.c || wrong.inMap !== host.inMap) && client.inMap === host.inMap && client.r === host.r && client.c === host.c;
      })
    );
    // 把锚点当中心（少半格）是 mapgeom 头部注释点名的老坑：这条证明 cellAnchor 的比对能抓它。
    const wrongAnchor = (layout, r, c) => ({ x: c * layout.stepX + 16, y: r * layout.stepY + 16 });
    check(
      "反向验证：把锚点当中心（y 少半格）会与宿主 cellAnchor 不同 —— 逐格比对能抓住",
      [0, 3, 6].every((r) => {
        const host = GEOM.cellAnchor(GEOM.layoutOf({ tileWidth: 32, tileHeight: 32, wrap: true }, 11, 7), r, 2);
        const client = MAP_cellAnchor(wrapLayout, r, 2);
        const wrong = wrongAnchor(wrapLayout, r, 2);
        return client.y === host.y && wrong.y !== host.y;
      })
    );
  }

  {
    let lineMismatch = 0;
    let lineTotal = 0;
    const cases = [[0, 0, 7, 7], [7, 0, 0, 7], [3, 3, 3, 9], [1, 8, 6, 1], [4, 4, 4, 4], [0, 0, 6, 6]];
    for (const [r0, c0, r1, c1] of cases) {
      const host = DOC.lineCells(r0, c0, r1, c1);
      const client = MAP_lineCells(r0, c0, r1, c1);
      lineTotal += host.length;
      if (JSON.stringify(host) !== JSON.stringify(client)) lineMismatch++;
    }
    check(`MAP_lineCells 与宿主 mapdoc.lineCells 逐点一致（${cases.length} 组、含 45° 斜线与同点，共 ${lineTotal} 格）`, lineMismatch === 0 && lineTotal > 20, `${lineMismatch} 组不同`);
    check(
      "反向验证：拖动补间不是「只连两端」（45° 斜线的中间格必须在结果里）",
      DOC.lineCells(0, 0, 4, 4).length === 5 && MAP_lineCells(0, 0, 4, 4).length === 5
    );
  }

  // ══ 3. 真渲染：面板 vs 宿主计划 ══════════════════════════════════════════
  section("3) 真渲染面板（宿主数据 + 真实 api 桥）");

  const apiLog = {
    plans: [],
    applies: [],
    undos: 0,
    redos: 0,
    saves: [],
    samples: 0,
    imports: 0,
    generates: [],
    exports: 0,
    exportPayloads: [],
    reveals: [],
    approvals: []
  };
  const apiRaw = {
    listMapProjects: async () => ({ projects: await G.listMapProjects() }),
    createMapProject: async ({ name, cols, rows }) => G.mapView(await G.createMapProject(name, { cols, rows })),
    getMapProject: async ({ projectId: id }) => G.mapView(await G.readMapProject(id)),
    deleteMapProject: async ({ projectId: id }) => {
      await G.deleteMapProject(id);
      return { ok: true };
    },
    saveMapProject: async ({ projectId: id, name }) => {
      await G.patchMapProject(id, (project) => {
        project.name = name;
      });
      return { ok: true };
    },
    importMapTileset: async (payload) => {
      apiLog.imports++;
      return G.importMapTileset(payload.projectId, payload.name, payload.data);
    },
    importSampleTileset: async ({ projectId: id }) => {
      apiLog.samples++;
      return G.importSampleTileset(id);
    },
    saveMapTileset: async ({ projectId: id, tilesetId, ...patch }) => G.saveMapTileset(id, tilesetId, patch),
    removeMapTileset: async ({ projectId: id, tilesetId }) => G.removeMapTileset(id, tilesetId),
    saveMapDoc: async ({ projectId: id, ...patch }) => {
      apiLog.saves.push(patch);
      return G.saveMapDocStructure(id, patch);
    },
    applyMapOps: async (payload) => {
      apiLog.applies.push({ ops: payload.ops, stroke: payload.stroke, have: [...(payload.have ?? [])] });
      return G.applyMapOps(payload.projectId, payload.ops, { stroke: payload.stroke, have: payload.have });
    },
    mapUndo: async ({ projectId: id, have }) => {
      apiLog.undos++;
      return G.undoMap(id, have);
    },
    mapRedo: async ({ projectId: id, have }) => {
      apiLog.redos++;
      return G.redoMap(id, have);
    },
    mapPlan: async (payload) => {
      const result = await G.mapPlan(payload.projectId, {
        view: payload.view,
        have: payload.have,
        layerIds: payload.layerIds,
        // 预览是宿主侧的能力（盖在克隆上算计划、不落盘）：夹具必须原样透传，
        // 否则「拖动期间看得见」这条契约在自检里根本测不到
        pending: payload.pending
      });
      apiLog.plans.push({
        view: { ...payload.view },
        have: [...(payload.have ?? [])],
        pending: payload.pending === undefined ? undefined : [...payload.pending],
        layerIds: payload.layerIds === undefined ? undefined : [...payload.layerIds],
        result
      });
      return result;
    },
    runMapGenerate: async (payload) => {
      apiLog.generates.push(payload);
      return G.runMapGenerate(payload.projectId, payload);
    },
    runMapPreview: async (payload) => G.runPreviewStage(payload.projectId),
    runMapExport: async (payload) => {
      apiLog.exports++;
      apiLog.exportPayloads.push({ scale: payload.scale, formats: { ...(payload.formats ?? {}) } });
      return G.runExportStage(payload.projectId, { scale: payload.scale, formats: payload.formats });
    },
    cancelMapJob: async () => ({ ok: true }),
    setMapApproved: async (payload) => {
      apiLog.approvals.push(payload);
      return { ok: true };
    },
    revealMapProject: async (payload) => {
      const { dir, fallback } = await G.mapRevealDir(payload.projectId, payload.target ?? "");
      apiLog.reveals.push({ ...payload, dir, fallback });
      return { ok: true, dir, fallback };
    }
  };
  /** 每个宿主调用都计一次「在飞」，供 renderTree 判断真的静下来了。 */
  const api = Object.fromEntries(
    Object.entries(apiRaw).map(([name, fn]) => [
      name,
      async (...args) => {
        inFlight++;
        try {
          return await fn(...args);
        } finally {
          inFlight--;
        }
      }
    ])
  );

  /**
   * 收集元素。
   *
   * ⚠️ 只展开 `Btn`（无状态）：在面板的 hook 存储里调用带 Hook 的组件会把槽位读串，
   * 表现是后面每个断言都莫名其妙地错位。
   */
  function collect(node, predicate, out = [], seen = new Set()) {
    if (node === null || node === undefined || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const child of node) collect(child, predicate, out, seen);
      return out;
    }
    if (seen.has(node)) return out;
    seen.add(node);
    if (typeof node.type === "function" && node.type.name === "Btn") {
      collect(node.type(node.props), predicate, out, seen);
      return out;
    }
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out, seen);
    return out;
  }
  const byClass = (tree, className) => collect(tree, (node) => typeof node.props?.className === "string" && node.props.className.split(" ").includes(className));
  /**
   * 重新挂载面板，直到**视图真的加载出来**为止（最多 3 次）。
   *
   * ⚠️ 挂载时要「读项目列表 → 读视图 → 问计划」，全是真的文件系统往返；本 harness
   * 偶尔会在那一串异步还没落地时就判定「已经稳定」，于是这个全新面板停在空态。
   * 那不是界面坏了（真机上刷新一次就好），但会让**后面每条断言连环崩**
   * （`byTool(freshTree, "eraser")[0]` 直接 undefined，整个脚本挂掉、后半个文件的
   * 覆盖全丢 —— 本机实测三次跑，分别死在第 10 / 15 / 16 节）。重挂一次即可。
   */
  async function freshPanel(apiImpl = api, tries = 3) {
    let mounted = await renderTree(() => MapModule({ api: apiImpl }), { fresh: true });
    for (let i = 1; i < tries && textOf(mounted).includes("还没有地图项目"); i++) {
      mounted = await renderTree(() => MapModule({ api: apiImpl }), { fresh: true });
    }
    return mounted;
  }
  const byTool = (tree, key) => collect(tree, (node) => node.props?.["data-tool"] === key);
  /**
   * 地图格 → 客户端坐标。
   *
   * ⚠️ 不要写死 `clientX: 40` 这类数字：相机被夹在地图里之后，硬编码的坐标很容易落到
   * 地图外（按新约定不算命中 → 不画也不悬停），断言就会莫名其妙地失败。
   * 相机口径取客户端最近一次计划查询的 `view`（= `{x: pan.x, y: pan.y, width: w/zoom}`）；
   * 画布桩的 `getBoundingClientRect()` 是 900×520、left/top = 0。
   */
  const clientOf = (r, c, step = 32) => {
    // 相机用面板自己暴露的那一份（`__mapDebug` 打开时随每次绘制刷新）——
    // 拿「最近一次计划查询的 view」推会读到过期相机（切项目 / 自适应缩放之后）。
    const cam = windowStub.__mapCamera;
    if (cam === undefined) throw new Error("拿不到 __mapCamera：面板还没画过？");
    return { x: ((c + 0.5) * step - cam.pan.x) * cam.zoom, y: ((r + 0.5) * step - cam.pan.y) * cam.zoom };
  };
  const textOf = (node) => {
    if (node === null || node === undefined) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    return (node.children ?? []).map(textOf).join("");
  };
  /** 递归展开函数组件（**只用于独立渲染的子树**：展开会消耗 Hook 槽位）。 */
  function expandComponents(node, depth = 0) {
    if (node === null || node === undefined || typeof node !== "object" || depth > 8) return node;
    if (Array.isArray(node)) return node.map((child) => expandComponents(child, depth));
    if (typeof node.type === "function") return expandComponents(node.type(node.props), depth + 1);
    return { ...node, children: (node.children ?? []).map((child) => expandComponents(child, depth)) };
  }

  /**
   * 渲染 → 跑 effect → 有 setState 就再来一轮（最多 30 轮，防死循环）。
   *
   * 一轮 = 「渲染 + 跑 effect + 等宿主调用落地」，**先不放定时器**。
   * 只有在这一轮彻底稳定（没有新 setState、没有在飞的宿主调用）之后，
   * 才把还活着的防抖定时器放出来 —— 那时 effect 的 cleanup 都已经执行过，
   * 与真机「32ms 后定时器才响，而 React 早就重渲染并清掉了旧定时器」一致。
   */
  async function renderTree(element, options = {}) {
    if (options.fresh === true) resetHooks();
    settleNotes = 0;
    let tree = null;
    for (let pass = 0; pass < 40; pass++) {
      cursor = 0;
      pendingRender = false;
      effects = [];
      globals.__pendingRefs = [];
      tree = element;
      const rendered = typeof element === "function" ? element() : element;
      for (const { element: nodeElement, node } of globals.__pendingRefs) {
        nodeElement.props.ref(node);
      }
      for (const effect of effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") globals.__cleanups.push(cleanup);
      }
      /**
       * 让异步 effect 真正落地。
       *
       * ⚠️ 必须等**真实的事件循环轮次**：面板挂载后要读宿主数据（真走文件系统），
       * 只 await 微任务的话读盘还没回来就判「没有 setState」而提前收工 ——
       * 表现是「面板一直停在空态」或「刚点完撤销断言读到旧状态」，看着像界面坏了。
       * 判据是「连续 3 轮既没有新 setState、也没有在飞的宿主调用」。
       */
      let quiet = 0;
      for (let tick = 0; tick < 240; tick++) {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.resolve();
        if (pendingRender || inFlight > 0) {
          quiet = 0;
          if (tick > 220) {
            /**
             * 多数情况下这是**本 harness 的已知特性**，不是界面在死循环：
             * 它每轮重跑**所有** effect（不认依赖数组），而面板里那句「按视口查绘制计划」
             * 的 effect 每次都会真的发起一次宿主查询 → `inFlight` / `pendingRender` 永远不为 0。
             * （真机上不会：React 只在依赖变化时重跑。实测界面空闲 3 秒重画 0 次。）
             * 留一条记号是为了万一真的读到半渲染的树、断言开始莫名其妙地报错时有个抓手。
             */
            if (settleNotes++ === 0) note(`⚠️ 等待稳定超时（本 harness 每轮重跑所有 effect，属已知特性；tick=${tick}，inFlight=${inFlight}）`);
            break;
          }
        } else if (++quiet >= 3) {
          break;
        }
      }
      if (pendingRender) continue; // 还没稳定：先让 React 提交，别急着放定时器
      if (timers.size === 0) return rendered;
      pumpTimers();
      let quietAfter = 0;
      for (let tick = 0; tick < 240; tick++) {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.resolve();
        if (pendingRender || inFlight > 0) {
          quietAfter = 0;
          if (tick > 220) {
            if (settleNotes++ === 0) note(`⚠️ 等待稳定超时（定时器后；同上，属已知特性；tick=${tick}，inFlight=${inFlight}）`);
            break;
          }
        } else if (++quietAfter >= 3) {
          break;
        }
      }
      // 定时器放出来的工作也落地了、也没有新状态 → 这一帧就是终态
      if (!pendingRender && inFlight === 0) {
        if (timers.size === 0) return rendered;
        continue; // 定时器里又排了新的（例如批量提交后续），再走一轮
      }
    }
    HOOK_MISMATCH.push("渲染超过 40 轮（可能有 setState 死循环）");
    return tree;
  }

  let tree = await renderTree(() => MapModule({ api }));
  check("面板能渲染（无异常、不是空态）", tree !== null && tree !== undefined && !textOf(tree).includes("还没有地图项目"), textOf(tree).slice(0, 60));

  /**
   * ⚠️ 别在面板树里展开 `MapExperimentalDialog`：它自己有 Hook，跑在面板的存储上
   * 会把槽位读串。这里只看「面板挂出了这个元素」，内容另开一份独立存储渲染。
   */
  const gateElement = collect(tree, (node) => typeof node.type === "function" && node.type.name === "MapExperimentalDialog")[0];
  check("进入模块⑥会弹实验性说明（实验性模块不能没有标记）", gateElement !== undefined);

  // ── 顶栏 ────────────────────────────────────────────────────────────────
  const projButton = byClass(tree, "SPR_mapEdProj")[0];
  check("顶栏有项目名（可展开菜单）", projButton !== undefined && textOf(projButton).includes("客户端自检"), textOf(projButton));
  const topButtons = byClass(tree, "SPR_mapEdTopBtn").map((node) => textOf(node).trim());
  check("顶栏有「素材」与「导出」两个入口（没有阶段条）", topButtons.includes("素材") && topButtons.includes("导出"), topButtons.join(" / "));
  check("顶栏没有「已通过」这类阶段向导按钮", !topButtons.some((text) => /阶段|下一步|①②③④/.test(text)), topButtons.join(" / "));
  // 用户反馈：画的时候那个「已自动保存」一直闪，不需要 —— 整块拿掉了
  check("顶栏不再显示保存状态（那颗会闪的字去掉了）", byClass(tree, "SPR_mapEdSave").length === 0 && !/已自动保存|还没有改动|正在保存/.test(textOf(tree)));
  check("**没有阶段条**：渲染结果里一个 .SPR_step 元素都没有", byClass(tree, "SPR_step").length === 0 && byClass(tree, "SPR_steps").length === 0, `${byClass(tree, "SPR_step").length}`);
  if (projButton !== undefined) {
    projButton.props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const menuText = textOf(byClass(tree, "SPR_mapEdMenu")[0] ?? null);
    check("点项目名展开菜单（新建 / 重命名 / 删除项目 / 切换项目）", ["新建项目", "重命名", "删除项目", "切换项目"].every((text) => menuText.includes(text)), menuText.slice(0, 60));
    const projButton2 = byClass(tree, "SPR_mapEdProj")[0];
    projButton2.props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check("再点一下菜单收回（菜单不是只能开不会关）", byClass(tree, "SPR_mapEdMenu").length === 0);
  }

  // ── 左列：素材调色板 ────────────────────────────────────────────────────
  const paletteGrid = byClass(tree, "SPR_mapEdPaletteGrid")[0];
  const paletteTiles = byClass(tree, "SPR_mapEdTile");
  const hostView = await G.mapView(await G.readMapProject(projectId));
  const expectedBrushes = hostView.tilesets.reduce((sum, ts) => sum + ts.palette.length, 0);
  check("左侧有素材调色板（8 列的网格）", byClass(tree, "SPR_mapEdPalette").length === 1 && paletteGrid !== undefined);
  check(`调色板条目数 = 宿主 palette 的总和（${expectedBrushes} 条：4 张 A2 各 1 条 + 道具 40 条）`, paletteTiles.length === expectedBrushes, `渲染 ${paletteTiles.length} vs 宿主 ${expectedBrushes}`);
  check("调色板里 A2 素材只有一个条目（不是把 16px 小格摊出来）", paletteTiles.filter((node) => hostView.tilesets.find((ts) => ts.id === a2TilesetId).palette.some((item) => String(item.index) === node.props["data-index"])).length === 1);
  if (paletteTiles.length > 0) {
    const chosen = paletteTiles[4];
    const chosenIndex = chosen.props["data-index"];
    chosen.props.onClick({ shiftKey: false, ctrlKey: false, metaKey: false });
    tree = await renderTree(() => MapModule({ api }));
    const active = byClass(tree, "SPR_mapEdTile").filter((node) => node.props["data-on"] === "true");
    check("点调色板一块能选中（恰好一块带 data-on，红框由 CSS 画）", active.length === 1 && active[0].props["data-index"] === chosenIndex, `${active.length} 块选中`);
  }

  // ── 左列：12 个图标按钮 ─────────────────────────────────────────────────
  const toolNodes = collect(tree, (node) => typeof node.props?.className === "string" && node.props.className.split(" ").includes("SPR_mapEdTool"));
  check("左列正好 12 个工具格（6 列 × 2 行）", toolNodes.length === 12, `${toolNodes.length} 个`);
  const toolKeys = [...collect(tree, (node) => typeof node.props?.["data-tool"] === "string")].map((node) => node.props["data-tool"]);
  const wantKeys = ["undo", "redo", "pen", "eraser", "bucket", "pipette", "hand", "single", "grid", "gen", "settings"];
  check(`11 个具名图标按钮都在（${wantKeys.join(" / ")}）`, wantKeys.every((key) => toolKeys.includes(key)) && toolKeys.filter((key) => wantKeys.includes(key)).length === 11, toolKeys.join(","));
  const layerBtn = byClass(tree, "SPR_mapEdLayerBtn")[0];
  const layerNum = byClass(tree, "SPR_mapEdLayerNum")[0];
  check("图层按钮上有层号「1」", layerBtn !== undefined && layerNum !== undefined && textOf(layerNum) === "1", textOf(layerNum ?? null));
  const layerHalves = byClass(tree, "SPR_mapEdLayerHalf");
  check(
    "图层按钮有上 / 下两个半块，且当前是第 1 层（下一层禁用）",
    layerHalves.length === 2 && layerHalves.find((node) => node.props["data-dir"] === "down").props.disabled === true && layerHalves.find((node) => node.props["data-dir"] === "up").props.disabled === false
  );

  // ── 工具格上方的小标签（名称 + 快捷键 + 介绍）────────────────────────────
  // 真机反馈：只有原生 `title` 时，说明要等一秒、样式不受控；自绘标签若用 absolute
  // 又会被祖先的 overflow 裁掉「按钮正上方」那一段。两条都在这里钉住。
  {
    const rect = () => ({ left: 120, top: 400, width: 40, height: 40, right: 160, bottom: 440 });
    const tipOf = (current) => byClass(current, "SPR_mapEdTip")[0];
    check(
      "工具格不再挂原生 title（否则会和自绘标签叠成两个框）",
      toolNodes.every((node) => node.props.title === undefined),
      toolNodes.filter((node) => node.props.title !== undefined).map((node) => node.props["data-tool"]).join(",")
    );
    check(
      "每个具名工具格的 aria-label 是「名称：介绍（快捷键）」（图层那个是复合容器，由两个半块各自带名字）",
      byTool(tree, "pen").length === 1 &&
        [...collect(tree, (node) => typeof node.props?.["data-tool"] === "string")].every(
          (node) => typeof node.props["aria-label"] === "string" && node.props["aria-label"].includes("：")
        ) &&
        byClass(tree, "SPR_mapEdLayerHalf").every((node) => ["上一层", "下一层"].includes(node.props["aria-label"])),
      String(byTool(tree, "undo")[0]?.props["aria-label"])
    );
    check("没悬浮时不渲染小标签", tipOf(tree) === undefined);
    const penNode = byTool(tree, "pen")[0];
    penNode.props.onMouseEnter({ currentTarget: { getBoundingClientRect: rect } });
    tree = await renderTree(() => MapModule({ api }));
    let tip = tipOf(tree);
    const tipText = tip === undefined ? "" : textOf(tip);
    check("悬浮「画笔」弹出小标签", tip !== undefined, tipText.slice(0, 40));
    check("小标签里有名称、快捷键与介绍", tipText.includes("画笔") && tipText.includes("B") && tipText.includes("按住左键涂抹"), tipText);
    check(
      "小标签挂在被悬浮按钮的正上方（坐标是 hover 时现算的）",
      tip !== undefined && tip.props.style.left === "140px" && tip.props.style.top === "392px",
      tip === undefined ? "" : `${tip.props.style.left} / ${tip.props.style.top}`
    );
    // 键盘聚焦也要能看到（只用鼠标的话键盘用户永远没有说明）
    penNode.props.onMouseLeave();
    tree = await renderTree(() => MapModule({ api }));
    check("移开鼠标后小标签收起", tipOf(tree) === undefined);
    byTool(tree, "bucket")[0].props.onFocus({ currentTarget: { getBoundingClientRect: rect } });
    tree = await renderTree(() => MapModule({ api }));
    check("键盘聚焦也弹小标签（介绍里有「连通区」）", textOf(tipOf(tree) ?? null).includes("连通区"), textOf(tipOf(tree) ?? null));
    // 图层按钮是复合控件（上下两个半块 + 层号），它的说明也走同一张标签
    byClass(tree, "SPR_mapEdLayerBtn")[0].props.onMouseEnter({ currentTarget: { getBoundingClientRect: rect } });
    tree = await renderTree(() => MapModule({ api }));
    check("图层按钮也有小标签（讲清上下半块与层号）", textOf(tipOf(tree) ?? null).includes("上一层") && textOf(tipOf(tree) ?? null).includes("层号"), textOf(tipOf(tree) ?? null));
    byClass(tree, "SPR_mapEdLayerBtn")[0].props.onMouseLeave();
    tree = await renderTree(() => MapModule({ api }));
    check("图层按钮移开后也收起", tipOf(tree) === undefined);
  }
  // 切到第 2 层：层号变 2，且「下一层」变成禁用、「上一层」变可用
  layerHalves.find((node) => node.props["data-dir"] === "up").props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  check("点「上一层」真的换层（层号变 2）", textOf(byClass(tree, "SPR_mapEdLayerNum")[0] ?? null) === "2", textOf(byClass(tree, "SPR_mapEdLayerNum")[0] ?? null));
  byClass(tree, "SPR_mapEdLayerHalf").find((node) => node.props["data-dir"] === "down").props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  check("点「下一层」换回第 1 层", textOf(byClass(tree, "SPR_mapEdLayerNum")[0] ?? null) === "1");
  check("底部显示当前层 / 总层数", textOf(byClass(tree, "SPR_mapEdFootText")[0] ?? null).includes("第 1 层 / 共 2 层"), textOf(byClass(tree, "SPR_mapEdFootText")[0] ?? null));
  // 网格线 / 单层预览 / 一键生成 / 设置：点一下要能切 data-on（按钮是开关）
  for (const [key, label] of [["grid", "网格线"], ["single", "单层预览"], ["gen", "一键生成"], ["settings", "设置"]]) {
    const button = byTool(tree, key)[0];
    button.props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check(`点「${label}」会切换按钮状态（data-on）`, byTool(tree, key)[0].props["data-on"] === "true", `data-on=${String(byTool(tree, key)[0].props["data-on"])}`);
    byTool(tree, key)[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
  }
  check("隐藏的素材上传入口还在（data-testid=map-tileset-input）", collect(tree, (node) => node.props?.["data-testid"] === "map-tileset-input").length === 1);
  const fileInput = collect(tree, (node) => node.props?.["data-testid"] === "map-tileset-input")[0];
  check("上传入口是 file input 且只收图片", fileInput !== undefined && fileInput.props.type === "file" && String(fileInput.props.accept).includes("image"));

  // 素材卡片 / 导出卡片（顶栏两个入口拉出来的面板）
  byClass(tree, "SPR_mapEdTopBtn")[0].props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  const assetsCard = byClass(tree, "SPR_mapEdCard")[0];
  check(
    "点「素材」先看到的是**素材列表**（加「新增素材 / 恢复默认素材」两个按钮）",
    assetsCard !== undefined && /新增素材/.test(textOf(assetsCard)) && /恢复默认素材/.test(textOf(assetsCard)) && byClass(assetsCard, "SPR_mapEdTsRow").length > 0,
    textOf(assetsCard).slice(0, 80)
  );
  check(
    "列表里每张素材都写着尺寸与块数，内置的带「自带」徽章",
    /\d+×\d+ · \d+ 块/.test(textOf(assetsCard)) && /自带/.test(textOf(assetsCard)),
    textOf(assetsCard).slice(0, 120)
  );
  check(
    "会动的素材在列表上直接标出帧数（变体=帧 / 翻页图的行=帧）",
    /会动 \d+ 帧/.test(textOf(assetsCard)),
    textOf(assetsCard).match(/会动 \d+ 帧/)?.[0] ?? ""
  );
  check("列表里没有「改格子 / 改形态」这类入口（属性只能在新增时定）", !/改格子|改形态|这块素材怎么用/.test(textOf(assetsCard)));
  /**
   * ── 导出卡片：**选择 / 执行 / 拿文件**三件事分开 ──────────────────────────
   *
   * 用户对这一版的原始抱怨：「导出 PNG 是选项卡，导出 JSON 怎么就点击直接操作了？
   * 而且还不能选择导出位置。而且多个文件应该打 zip」。所以这里逐条钉住：
   * ① 内容是三只复选框（不是像页签的按钮），执行只有一个「导出」；
   * ② 倍率只在勾了 PNG 时出现；
   * ③ 导完给的是**一个 zip 的下载链接**（多产物自动打包），并写清文件落在哪；
   * ④ 「另存为…」走原生保存框（有才显示），拿到的就是那个 zip。
   */
  byClass(tree, "SPR_mapEdTopBtn")[1].props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  const exportCard = byClass(tree, "SPR_mapEdCard")[0];
  const exportBox = (key) => collect(exportCard, (node) => node.props?.["data-testid"] === `map-export-${key}`)[0];
  check(
    "点「导出」拉出导出卡片（三只复选框 + 一个「导出」按钮）",
    exportCard !== undefined && ["png", "json", "tilesets"].every((key) => exportBox(key) !== undefined) && /导出内容/.test(textOf(exportCard)),
    textOf(exportCard).slice(0, 80)
  );
  check(
    "★ 不再有「导出图片 PNG / 导出存档 JSON」这种点一下就执行的按钮（选择与执行分开）",
    !/导出图片 PNG|导出存档 JSON/.test(textOf(exportCard)) && byClass(exportCard, "SPR_btn").filter((node) => textOf(node) === "导出").length === 1,
    textOf(exportCard).slice(0, 120)
  );
  check("默认勾上 PNG 与存档 JSON、不勾素材原图", exportBox("png").props.checked === true && exportBox("json").props.checked === true && exportBox("tilesets").props.checked !== true);
  check("导出卡片给定倍率档位 1×–4×（只在勾了 PNG 时出现）", collect(exportCard, (node) => node.type === "option").length === 4 && /倍率/.test(textOf(exportCard)));
  check("卡片上写清「多产物自动打包」这条规则", /自动打成一个 ZIP/.test(textOf(exportCard)), textOf(exportCard).match(/产出[^。]*。/)?.[0] ?? "");
  check("还没导出过时给空态文案（不是一份假清单）", /还没有导出过/.test(textOf(exportCard)));

  // 取消勾选 PNG：倍率跟着消失（倍率只对 PNG 有意义）
  exportBox("png").props.onChange({ target: { checked: false } });
  tree = await renderTree(() => MapModule({ api }));
  const cardNoPng = byClass(tree, "SPR_mapEdCard")[0];
  check("取消勾选 PNG 后倍率那一行消失", !/倍率/.test(textOf(cardNoPng)), textOf(cardNoPng).slice(0, 100));
  // 三只都取消：导出按钮变灰（点了也没东西可导）
  collect(cardNoPng, (node) => node.props?.["data-testid"] === "map-export-json")[0].props.onChange({ target: { checked: false } });
  tree = await renderTree(() => MapModule({ api }));
  const cardNone = byClass(tree, "SPR_mapEdCard")[0];
  const runButton = collect(cardNone, (node) => node.props?.["data-testid"] === "map-export-run")[0];
  check("一个都不勾时「导出」是禁用的", runButton !== undefined && runButton.props.disabled === true);

  // 勾回 PNG + JSON，真导一次
  collect(cardNone, (node) => node.props?.["data-testid"] === "map-export-png")[0].props.onChange({ target: { checked: true } });
  tree = await renderTree(() => MapModule({ api }));
  collect(byClass(tree, "SPR_mapEdCard")[0], (node) => node.props?.["data-testid"] === "map-export-json")[0].props.onChange({ target: { checked: true } });
  tree = await renderTree(() => MapModule({ api }));
  const exportsBefore = apiLog.exports;
  collect(byClass(tree, "SPR_mapEdCard")[0], (node) => node.props?.["data-testid"] === "map-export-run")[0].props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  check("点「导出」真的调了一次 runMapExport", apiLog.exports === exportsBefore + 1);
  check(
    "提交的 formats 就是勾选的那三项（png/json/tilesets），界面不自作主张",
    JSON.stringify(apiLog.exportPayloads[apiLog.exportPayloads.length - 1]?.formats) === JSON.stringify({ png: true, json: true, tilesets: false }),
    JSON.stringify(apiLog.exportPayloads[apiLog.exportPayloads.length - 1])
  );

  /**
   * ⚠️ 导出是**宿主后台作业**：`runMapExport` 立刻回 `{started:true}`，文件是几轮之后才落盘的。
   * 所以先等宿主 `mapBusy` 落下去（不然断言读到的是上一帧的清单，会以「随机失败」的形式报出来）。
   *
   * 不能只 `setImmediate` 空转：那是**真写盘**（PNG + zip），要给它真实的挂钟时间，
   * 而本 harness 把 `setTimeout` 换成了可取消定时器队列 —— 所以用 `node:timers/promises`。
   *
   * 落盘之后靠**面板自己的刷新路径**把新清单读回来：`view.busy === true` 期间的
   * 1.5s 轮询（`tickTimers` 会把它放出来）。这条路径以前在自检里是空的
   * （`setInterval` 是空实现），也就是「提交完界面不刷新」根本测不到。
   */
  for (let tick = 0; tick < 200 && G.mapBusy(projectId); tick++) await delay(25);
  check("宿主导出作业跑完（自检层面确认真落盘了）", G.mapBusy(projectId) === false);
  /**
   * 界面是**异步**看到这件事的：提交那一刻读到的还是「进行中」，得靠 busy 期间的
   * 1.5s 轮询再读一次才拿到新清单（真机实测：导出约 2s 后文件列表自己冒出来）。
   * 所以这里按真机的节奏一轮轮放轮询，最多放几轮 —— 一轮就到位反而不正常。
   */
  let resultCard = null;
  let result = null;
  for (let round = 0; round < 6; round++) {
    tree = await renderTree(() => MapModule({ api }));
    resultCard = byClass(tree, "SPR_mapEdCard")[0];
    result = collect(resultCard, (node) => node.props?.["data-testid"] === "map-export-result")[0];
    if (result !== undefined) break;
    await tickTimers();
  }
  check("导出跑完后界面自己刷新出结果区（busy 期间的轮询真的在跑）", result !== undefined && /最近一次导出：\d+ 个文件/.test(textOf(result)), textOf(resultCard).slice(0, 140));
  const download = collect(resultCard, (node) => node.props?.["data-testid"] === "map-export-download")[0];
  const viewForExport = await G.mapView(await G.readMapProject(projectId));
  const zipFile = viewForExport.exportFiles.find((file) => file.endsWith(".zip"));
  check("★ 主下载按钮指向那个 zip（多产物一次拿走）", download !== undefined && zipFile !== undefined && String(download.props.href).endsWith(zipFile), `${download?.props.href} vs ${zipFile}`);
  check("下载按钮带 download 属性（点了是存盘，不是开着看）", download !== undefined && download.props.download === zipFile);
  check("结果区把每个产物都列出来（zip 上标着「打包，含全部内容」）", ["map.png", "map.json"].every((name) => textOf(resultCard).includes(name)) && /打包，含全部内容/.test(textOf(resultCard)), textOf(resultCard).slice(0, 160));
  const pathLine = collect(resultCard, (node) => node.props?.["data-testid"] === "map-export-path")[0];
  check("★ 写清文件落在哪（导出目录的本机绝对路径，不再「意味不明」）", pathLine !== undefined && textOf(pathLine).includes(viewForExport.exportPath) && textOf(pathLine).includes("export"), textOf(pathLine));
  const saveAsButton = collect(resultCard, (node) => node.props?.["data-testid"] === "map-export-save-as")[0];
  check("没有原生保存框时不给「另存为…」按钮，改说明位置由浏览器决定", saveAsButton === undefined && /下载目录/.test(textOf(resultCard)));

  // 「打开导出目录」必须带 target:"export"（不带就打开的是项目根目录 —— 老版本的坏法）
  apiLog.reveals.length = 0;
  collect(resultCard, (node) => node.type === "a" || node.type === "button")
    .find((node) => textOf(node) === "打开导出目录")
    ?.props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  check('点「打开导出目录」带上 target:"export"', apiLog.reveals.length === 1 && apiLog.reveals[0].target === "export", JSON.stringify(apiLog.reveals));
  /**
   * 打开的必须是**导出目录本身**（老版本打开的是项目根目录 —— 那里并没有他要的文件）。
   * 断言宿主解析出来的路径，而不是底部那条提示：提示是瞬时状态，本来就会被下一次
   * setNotice 顶掉，拿它当断言会随机红。
   */
  check("打开的是导出目录本身（不是项目根目录）", apiLog.reveals[0]?.dir === viewForExport.exportPath && apiLog.reveals[0]?.fallback === false, `${apiLog.reveals[0]?.dir} vs ${viewForExport.exportPath}`);

  /**
   * 「另存为…」：装一个原生保存框的桩。断言的是**先弹框再取字节**这个顺序 ——
   * 先 await fetch 会把手势耗掉，Chromium 直接抛「Must be handling a user gesture」。
   */
  const saved = [];
  const order = [];
  windowStub.showSaveFilePicker = async (options) => {
    order.push("pick");
    return {
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            order.push("write");
            saved.push({ name: options.suggestedName, size: blob.size });
          },
          async close() {
            order.push("close");
          }
        };
      }
    };
  };
  globalThis.fetch = async (url) => {
    order.push("fetch");
    return { ok: true, status: 200, async blob() { return { size: 42, url: String(url) }; } };
  };
  tree = await renderTree(() => MapModule({ api }));
  const saveAsNow = collect(byClass(tree, "SPR_mapEdCard")[0], (node) => node.props?.["data-testid"] === "map-export-save-as")[0];
  check("有原生保存框时出现「另存为…」", saveAsNow !== undefined && textOf(saveAsNow).includes("另存为"));
  saveAsNow?.props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  check("「另存为…」先弹保存框、再取字节、最后写盘", order.join(">") === "pick>fetch>write>close", order.join(">"));
  check("保存框建议的文件名就是那个 zip，写进去的字节数来自下载内容", saved.length === 1 && saved[0].name === zipFile && saved[0].size === 42, JSON.stringify(saved));
  check("存完给一句「已保存到 …」", /已保存到/.test(textOf(tree)), textOf(tree).slice(0, 120));
  delete windowStub.showSaveFilePicker;
  delete globalThis.fetch;

  byClass(tree, "SPR_mapEdTopBtn")[1].props.onClick();
  tree = await renderTree(() => MapModule({ api }));
  check("再点一次卡片收起", byClass(tree, "SPR_mapEdCard").length === 0);
  check("渲染出来的文本里不出现 markdown 星号（界面不渲染 markdown）", !textOf(tree).includes("**"));
  /**
   * 术语黑名单的**用户面**版本：源码里允许协议字段名（`"chunks"`），但**画到屏幕上的字**
   * 一个都不许有。这条比扫源码更接近「用户看到什么」，也挡得住「把词写进文案里」。
   */
  const JARGON = ["地形族", "掩码", "优先级", "切分", "chunk", "chunks", "图集", "变体种子", "高度偏移", "Tiled", "等距", "图块序号"];
  const shownText = textOf(tree);
  check(
    "渲染出来的界面文案里不出现旧术语（含 chunk / 图集 / 等距 / 图块序号）",
    JARGON.every((word) => !shownText.includes(word)),
    JARGON.filter((word) => shownText.includes(word)).join("、")
  );

  // ══ 4. 预览 = 导出：drawImage 序列 == 宿主计划（同一视口）══════════════════
  section("4) 预览 = 导出：画布 drawImage 序列 == 宿主对同一视口的计划");

  const canvasNode = collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
  check("画布是 <canvas data-testid=map-canvas>", canvasNode !== undefined && canvasNode.type === "canvas");
  check("挂载后画布真的画了东西（有 drawImage 调用）", frameOf().length > 0, `${frameOf().length} 条`);
  check("画布调用是 9 参数的 drawImage（canvas 的带源矩形那一版）", frameOf().every(isDrawImage));
  check("画布上的贴图都归因到已挂载的图源（不存在无源可画）", frameOf().every((call) => call.tilesetId !== null) && frameOf().some((call) => call.tilesetId === a2TilesetId));

  /**
   * ⚠️ 计划是**增量**下发的：客户端把缓存 key 报上来（`have`），宿主只回「还没给过」的块。
   * 而块的内容取决于**查询时的视口范围**（`buildPlan(range)` 只发范围内那几格），
   * 所以「预览 == 导出」这条契约要在**整份重拉之后**才有确定的对照面：
   * 切一次单层预览再切回来会让 `planKey` 变化 → 客户端 `clearPlan()` → 下一次查询 `have` 为空。
   *
   * 挂载与平移时**不整份重拉**也必须与同一视口的计划一致 —— 第 15 节专门盯这一条
   * （增量缓存按视口失效）。
   */
  async function forceFullPlanReload(current) {
    for (const key of ["single", "single"]) {
      byTool(current, key)[0].props.onClick();
      current = await renderTree(() => MapModule({ api }));
    }
    return current;
  }
  tree = await forceFullPlanReload(tree);
  const lastQuery = apiLog.plans[apiLog.plans.length - 1];
  const prevQuery = apiLog.plans[apiLog.plans.length - 2];
  check(
    "整份重拉后：最后两次查询用的是同一个视口（对照面确定）",
    lastQuery !== undefined && prevQuery !== undefined && JSON.stringify(lastQuery.view) === JSON.stringify(prevQuery.view),
    `${JSON.stringify(lastQuery?.view)} vs ${JSON.stringify(prevQuery?.view)}`
  );
  const clientView = lastQuery.view;
  const hostPlan = await G.mapPlan(projectId, { view: clientView, have: [], layerIds: lastQuery.layerIds === undefined ? undefined : lastQuery.layerIds });
  const hostOps = hostPlan.chunks.flatMap((chunk) => chunk.ops);
  const hostLegend = new Map(hostPlan.legend.map((entry) => [entry.index, entry]));
  const frame = frameOf();

  check(`条数 == 宿主对同一视口给出的计划条数（画布 ${frame.length} vs 宿主 ${hostOps.length}）`, frame.length === hostOps.length, `画布 ${frame.length} vs 宿主 ${hostOps.length}`);
  check(
    "画布用的 chunk 列表 == 宿主算出的 visibleKeys（连顺序都一样，界面没有自己算 chunk）",
    JSON.stringify(windowStub.__mapDrawStats?.keys ?? null) === JSON.stringify(hostPlan.visibleKeys),
    `${JSON.stringify(windowStub.__mapDrawStats?.keys)} vs ${JSON.stringify(hostPlan.visibleKeys)}`
  );
  if (frame.length === hostOps.length && frame.length > 0) {
    let positionMismatch = 0;
    let rectMismatch = 0;
    let sizeMismatch = 0;
    for (let index = 0; index < frame.length; index++) {
      const draw = frame[index];
      const op = hostOps[index];
      if (draw.dx !== op.x || draw.dy !== op.y) positionMismatch++;
      const rect = hostLegend.get(op.t)?.rect;
      if (rect === undefined) continue;
      if (draw.sx !== rect.x || draw.sy !== rect.y || draw.sw !== rect.width || draw.sh !== rect.height) rectMismatch++;
      if (draw.dw !== rect.width || draw.dh !== rect.height) sizeMismatch++;
    }
    check("逐项目标像素与宿主计划一致（顺序也一致）", positionMismatch === 0, `${positionMismatch} 项不同`);
    check("逐项源矩形与宿主 legend 一致（sx/sy/sw/sh）", rectMismatch === 0, `${rectMismatch} 项不同`);
    check("贴图按 legend 的原尺寸贴（不缩放，像素画不糊）", sizeMismatch === 0, `${sizeMismatch} 项不同`);
    // 反向验证：把顺序当成「可任意」时上面那条会失效 —— 倒序比对必须能发现不同。
    let reversedSame = true;
    for (let index = 0; index < frame.length; index++) {
      const op = hostOps[frame.length - 1 - index];
      if (frame[index].dx !== op.x || frame[index].dy !== op.y) {
        reversedSame = false;
        break;
      }
    }
    check("反向验证：倒序比对会不一致（所以「顺序也一致」这条断言有区分力）", reversedSame === false || frame.length === 1);
  }
  check(
    "帧统计：drawn == 计划条数、noImage == 0（没有缺图源导致的静默少画）",
    windowStub.__mapDrawStats?.drawn === hostOps.length && windowStub.__mapDrawStats?.noImage === 0 && windowStub.__mapDrawStats?.noLegend === 0,
    JSON.stringify(windowStub.__mapDrawStats ?? null)
  );

  // ══ 5. A2 拼块：一格 4 条 op ══════════════════════════════════════════════
  section("5) A2 拼块：一格 4 条 drawImage（四象限）");
  const opIndicesOf = (r, c) => hostOps.map((op, index) => ({ op, index })).filter((item) => item.op.r === r && item.op.c === c).map((item) => item.index);
  const cell88 = opIndicesOf(8, 8);
  check("宿主计划里 A2 的 (8,8) 有 4 条 op（TL/TR/BL/BR）", cell88.length === 4, `${cell88.length}`);
  check("四条 op 落在四个**不同像素位置**（半格偏移）", new Set(cell88.map((index) => `${hostOps[index].x},${hostOps[index].y}`)).size === 4, cell88.map((index) => `${hostOps[index].x},${hostOps[index].y}`).join(" "));
  check(
    "画布对 (8,8) 的四条 op 各画一次，且四条的 dx/dy 互不相同",
    cell88.length === 4 && new Set(cell88.map((index) => `${frame[index].dx},${frame[index].dy}`)).size === 4,
    cell88.map((index) => `${frame[index].dx},${frame[index].dy}`).join(" ")
  );
  const a2Rects = cell88.map((index) => hostLegend.get(hostOps[index].t)?.rect);
  check(
    "四条 op 的源矩形都是 16×16 的**小格**且互不相同（不是整格 32×32）",
    a2Rects.every((rect) => rect !== undefined && rect.width === 16 && rect.height === 16) && new Set(a2Rects.map((rect) => `${rect.x},${rect.y}`)).size === 4,
    a2Rects.map((rect) => `${rect.x},${rect.y} ${rect.width}x${rect.height}`).join(" | ")
  );
  const blockCells = opIndicesOf(8, 9).length + opIndicesOf(9, 8).length + opIndicesOf(9, 9).length + cell88.length;
  check("2×2 的 A2 方块一共 16 条 op（4 格 × 4 象限）", blockCells === 16, `${blockCells}`);
  check(
    "自动连接真的生效：A2 满格的四条 op 与孤立格的四条 op 不是同一套小格",
    (() => {
      const isolated = hostOps.filter((op) => op.r === 8 && op.c === 8).map((op) => op.t).join(",");
      const filled = hostOps.filter((op) => op.r === 9 && op.c === 9).map((op) => op.t).join(",");
      return isolated !== filled && isolated !== "" && filled !== "";
    })()
  );

  // ══ 6. 动画：同一格在不同帧号下取不同矩形 ════════════════════════════════
  section("6) 动画：全局帧号驱动，同一格不同帧取不同源矩形");
  check("宿主计划给出 frameCount = 2（A2 的变体数就是帧数）", hostPlan.frameCount === 2 && hostPlan.fps === 1, `frameCount=${hostPlan.frameCount} fps=${hostPlan.fps}`);
  const animated = hostOps.findIndex((op) => Array.isArray(op.cycle) && op.cycle.length === 2);
  check("A2 的 op 带 cycle（长度 2），且 t == cycle[0]", animated >= 0 && hostOps[animated].t === hostOps[animated].cycle[0], JSON.stringify(hostOps[animated]?.cycle));
  const frame0Rect = hostLegend.get(hostOps[animated].t).rect;
  const frameNow = frameOf();
  check("第 0 帧画的是 cycle[0] 的矩形", frameNow[animated].sx === frame0Rect.x && frameNow[animated].sy === frame0Rect.y);
  // 推进全局帧号：面板用 rAF + Date.now 推时钟，这里把时钟拨快再跑一次排队的回调。
  const realNow = Date.now;
  const pendingTicks = [...rafQueue.values()];
  rafQueue.clear();
  check("画面在动时确实注册了动画回调（不是死帧）", pendingTicks.length > 0, `${pendingTicks.length} 个`);
  try {
    /**
     * ⚠️ 拨**恰好一个帧间隔**（`fps = 1` → 1000ms），不能拨 1500ms。
     *
     * 面板算的是 `floor(elapsed * fps) % frameCount`：拨 1.5s 时落到哪一帧取决于
     * `elapsed` 的奇偶 —— 也就是说这条断言隐含依赖「跑到这里时一共花了多少挂钟时间」。
     * 前面的用例多花半秒（例如新增的导出段要真写盘）就会翻成 frame 0，表现为
     * 「莫名其妙挂一条与本次改动无关的动画断言」。拨整数个间隔则恒 +1 帧。
     */
    Date.now = () => realNow() + 1000;
    for (const tick of pendingTicks) tick();
  } finally {
    Date.now = realNow;
  }
  tree = await renderTree(() => MapModule({ api }));
  const frame1 = frameOf();
  const frame1Rect = hostLegend.get(hostOps[animated].cycle[1]).rect;
  check("推进一帧后 __mapDrawStats.frame == 1（帧号真的推上去了）", windowStub.__mapDrawStats?.frame === 1, `frame=${String(windowStub.__mapDrawStats?.frame)}`);
  check(
    "同一格在帧 1 取到的源矩形与帧 0 不同（画布从 legend 查的是另一块）",
    frame1[animated].sx === frame1Rect.x && frame1[animated].sy === frame1Rect.y && frame1[animated].sx !== frameNow[animated].sx,
    `帧0 (${frameNow[animated].sx},${frameNow[animated].sy}) → 帧1 (${frame1[animated].sx},${frame1[animated].sy})`
  );
  check("动画只换图块、不换位置（同一格两个帧的目标像素相同）", frame1[animated].dx === frameNow[animated].dx && frame1[animated].dy === frameNow[animated].dy);
  // 反向验证：不再推进帧时，重渲染必须还是同一帧（动画是帧号驱动，不是每次重画随机挑）
  tree = await renderTree(() => MapModule({ api }));
  check("反向验证：不推进帧号时重渲染仍是同一帧（不是每次重画随机挑一块）", frameOf()[animated].sx === frame1[animated].sx);

  // ══ 7. 环绕接缝：负数 chunk key 也要画 ════════════════════════════════════
  section("7) 环绕接缝：视口跨左上边界时出现负数 chunk key 且真的画了");
  {
    // 用抓手把视口往右下拉 → 相机往左上走（pan 变负），视口就跨过了左上边界。
    byTool(tree, "hand")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const queriesBeforeDrag = apiLog.plans.length;
    const liveCanvas = collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
    liveCanvas.props.onPointerDown({ clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    liveCanvas.props.onPointerMove({ clientX: 2000, clientY: 2000, pointerId: 1 });
    liveCanvas.props.onPointerUp({ pointerId: 1 });
    tree = await renderTree(() => MapModule({ api }));
    const draggedQueries = apiLog.plans.slice(queriesBeforeDrag);
    /**
     * ⚠️ 相机现在**被夹在地图里**（见 clampPan）：往右下角拖到头时视口原点正好是
     * 「地图宽 - 视口宽」，再拖也不动 —— 真机上这就是「地图不再乱跑、左上角能对齐」。
     */
    const clampedQuery = draggedQueries[draggedQueries.length - 1];
    // 这个夹具里自适应缩放会让整张地图正好铺进视口（视口 ≥ 地图）→ 相机应当钉在 0：
    // 「地图左上角 = 画布左上角」。地图比视口大的分支（能滚、滚到边界停）用捏合放大后再测。
    check(
      "地图不比视口大时相机钉在 0（左上角对齐，不会拖进空白）",
      clampedQuery !== undefined && clampedQuery.view.x === 0 && clampedQuery.view.y === 0,
      `x=${clampedQuery?.view.x} y=${clampedQuery?.view.y} 视口宽=${clampedQuery?.view.width}`
    );
    // 地图比视口大时另一支：捏合放大（双指针）让地图超出视口，再拖 → 能滚，且滚到边界就停
    {
      const pinchCanvas = collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
      pinchCanvas.props.onPointerDown({ clientX: 300, clientY: 260, button: 0, pointerId: 71 });
      pinchCanvas.props.onPointerDown({ clientX: 420, clientY: 260, button: 0, pointerId: 72 });
      pinchCanvas.props.onPointerMove({ clientX: 300, clientY: 260, pointerId: 71 });
      pinchCanvas.props.onPointerMove({ clientX: 560, clientY: 260, pointerId: 72 });
      pinchCanvas.props.onPointerUp({ pointerId: 71 });
      pinchCanvas.props.onPointerUp({ pointerId: 72 });
      tree = await renderTree(() => MapModule({ api }));
      tree = await forceFullPlanReload(tree);
      const zoomed = apiLog.plans[apiLog.plans.length - 1].view;
      const dragStart = apiLog.plans.length;
      byTool(tree, "hand")[0].props.onClick();
      tree = await renderTree(() => MapModule({ api }));
      const drag2 = collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
      // 把地图往左上拖（pointer 往左上 → pan 变大）→ 一路滚到右下边界就停
      drag2.props.onPointerDown({ clientX: 300, clientY: 260, button: 0, pointerId: 73 });
      drag2.props.onPointerMove({ clientX: -3000, clientY: -3000, pointerId: 73 });
      drag2.props.onPointerUp({ pointerId: 73 });
      tree = await renderTree(() => MapModule({ api }));
      tree = await forceFullPlanReload(tree);
      const afterDrag = apiLog.plans.slice(dragStart).map((entry) => entry.view);
      const last = afterDrag[afterDrag.length - 1];
      const mapSide = 32 * 32;
      const maxAllowed = Math.max(0, mapSide - last.width);
      check(
        "放大到地图超出视口后可以滚，且滚到边界就停（pan 落在 0..地图-视口）",
        last !== undefined && zoomed.width < mapSide && last.x >= -0.5 && last.x <= maxAllowed + 0.5,
        `放大后视口宽=${Math.round(zoomed.width)}，滚到底 x=${Math.round(last?.x)}（上界 ${Math.round(maxAllowed)}）`
      );
      check("滚到右下边界时正好停在「地图右下角贴住画布右下角」", Math.abs(last.x - maxAllowed) < 0.5 && Math.abs(last.y - Math.max(0, mapSide - last.height)) < 0.5, `x=${Math.round(last?.x)}/${Math.round(maxAllowed)} y=${Math.round(last?.y)}`);
    }
    tree = await forceFullPlanReload(tree);
    const seamQuery = apiLog.plans[apiLog.plans.length - 1];
    const seamPlan = await G.mapPlan(projectId, { view: seamQuery.view, have: [] });
    /**
     * ⚠️ 契约变了：相机被夹在地图内（`clampPan`）之后，客户端**再也不会请求越界的视口** ——
     * 所以「环绕出来的负数 key」在界面上不会出现，环绕只剩**数据层**语义（自动连接看邻居、
     * 导出铺一次）。这里改成钉住新不变量：所有请求出去的视口原点都不越界。
     * （负数 key 本身仍由宿主支持，`verify-map` / `-pipeline` 里有断言。）
     */
    const negativeKeys = seamPlan.visibleKeys.filter((key) => key.includes("-"));
    check("相机被夹住后不再请求越界视口（界面上不会出现环绕出来的副本）", negativeKeys.length === 0 && apiLog.plans.every((entry) => entry.view.x >= 0 && entry.view.y >= 0), `最后一次 visibleKeys=${seamPlan.visibleKeys.join(" ")}`);
    const seamFrame = frameOf();
    check("负数 chunk 的计划里真的有内容（不是空块）", seamPlan.chunks.every((chunk) => chunk.ops.length > 0), seamPlan.chunks.map((chunk) => `${chunk.key}:${chunk.ops.length}`).join(" "));
    check("画布对负数 chunk 照画不误（条数 > 0，且 chunk 列表与宿主一致）", seamFrame.length > 0 && JSON.stringify(windowStub.__mapDrawStats?.keys) === JSON.stringify(seamPlan.visibleKeys), `${seamFrame.length} 条 / ${JSON.stringify(windowStub.__mapDrawStats?.keys)}`);
    check("接缝处画的内容 == 宿主计划（含图外副本的绝对像素）", seamFrame.length === seamPlan.chunks.flatMap((chunk) => chunk.ops).length, `${seamFrame.length} vs ${seamPlan.chunks.flatMap((chunk) => chunk.ops).length}`);
    // ── 小幅平移（不动 planKey、**不整份重拉**）之后，缓存里的块是不是仍然对 ──
    // 小幅平移时一部分 unwrapped chunk key 会留下来（`have` 命中 → 宿主不重发），
    // 而它们的 ops 是按**当时那个范围**裁的。留下来还能看见的那几块一旦内容不全，
    // 画面就会缺一条边 —— 不报错，只在平移时看得出来。
    tree = await forceFullPlanReload(tree);
    const beforePanQuery = apiLog.plans[apiLog.plans.length - 1];
    const beforePanPlan = await G.mapPlan(projectId, { view: beforePanQuery.view, have: [] });
    const beforePanPositions = new Set(beforePanPlan.chunks.flatMap((chunk) => chunk.ops).map((op) => `${op.x},${op.y}`));
    byTool(tree, "hand")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const panCanvas = collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
    panCanvas.props.onPointerDown({ clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    panCanvas.props.onPointerMove({ clientX: 500, clientY: 460, pointerId: 1 });
    panCanvas.props.onPointerUp({ pointerId: 1 });
    tree = await renderTree(() => MapModule({ api }));
    const afterPanQuery = apiLog.plans[apiLog.plans.length - 1];
    const afterPanPlan = await G.mapPlan(projectId, { view: afterPanQuery.view, have: [] });
    const afterPanNeed = new Set(afterPanPlan.chunks.flatMap((chunk) => chunk.ops).map((op) => `${op.x},${op.y}`));
    const afterPanDrawn = new Set(frameOf().map((draw) => `${draw.dx},${draw.dy}`));
    const panMissing = [...afterPanNeed].filter((key) => !afterPanDrawn.has(key));
    const panExtra = [...afterPanDrawn].filter((key) => !afterPanNeed.has(key));
    const reused = [...beforePanPositions].filter((key) => afterPanNeed.has(key)).length;
    note(`小幅平移探针：视口 x ${beforePanQuery.view.x.toFixed(1)} → ${afterPanQuery.view.x.toFixed(1)}`);
    note(`平移前用过、平移后仍能看到的位置（会命中 have 而不重发）：${reused} 个`);
    note(`平移后宿主计划 ${afterPanNeed.size} 个像素位置；画布 ${afterPanDrawn.size} 个；缺 ${panMissing.length}、多 ${panExtra.length}`);
    check(
      "小幅平移后（不整份重拉）画布覆盖 == 宿主计划要求的像素位置（增量缓存按视口失效）",
      panMissing.length === 0 && panExtra.length === 0,
      `缺 ${panMissing.length} 个、多 ${panExtra.length} 个：${panMissing.slice(0, 4).join(" | ")}`
    );
    byTool(tree, "pen")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
  }

  // ══ 8. 真的能改地图：画一笔 / 撤销 / 重做 ════════════════════════════════
  section("8) 真的能改地图（一笔拖拽 = 一条撤销）");
  {
    const beforeView = apiLog.plans[apiLog.plans.length - 1].view;
    const planBefore = await G.mapPlan(projectId, { view: beforeView, have: [] });
    const depthBefore = G.historyState(projectId).depth;
    const appearsBefore = apiLog.applies.length;
    const framesBefore = drawFrames.length;
    const liveCanvas = collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
    // 换一块笔刷再画：保证「这一笔真的改到了数据」（同格同图 = 宿主认为没变，计划自然不变）
    byClass(tree, "SPR_mapEdTile")[4].props.onClick({ shiftKey: false });
    byTool(tree, "pen")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    /**
     * ⚠️ 必须画**当前视口里**的格子。相机现在会被夹在地图内（可能停在边界上），
     * 视口外的格子画了也不会改变「这一份视口的计划」，断言会误报「没改到地图」。
     * 用 __mapCamera 反推视口中心在哪个格，再从那附近拖两格。
     */
    const camNow = windowStub.__mapCamera;
    const viewMidR = Math.floor((camNow.pan.y + 520 / camNow.zoom / 2) / 32);
    const viewMidC = Math.floor((camNow.pan.x + 900 / camNow.zoom / 2) / 32);
    const from11 = clientOf(viewMidR, viewMidC);
    const to33 = clientOf(viewMidR + 1, viewMidC + 1);
    liveCanvas.props.onPointerDown({ clientX: from11.x, clientY: from11.y, button: 0, pointerId: 1 });
    await tickTimers();
    liveCanvas.props.onPointerMove({ clientX: to33.x, clientY: to33.y, pointerId: 1 });
    /**
     * 一笔还没结束：这里要模拟「手还按着、又过了一小会儿」——
     * 80ms 的预览节拍放行 → 重渲染（查询副作用这时才注册自己的定时器）→ 再放行一次，
     * 于是产生一条带 `pending` 的**预览查询**（宿主只算不存）。
     */
    await tickTimers();
    tree = await renderTree(() => MapModule({ api }));
    await tickTimers();
    liveCanvas.props.onPointerUp({ pointerId: 1 });
    tree = await renderTree(() => MapModule({ api }));
    const planAfter = await G.mapPlan(projectId, { view: beforeView, have: [] });
    const depthAfter = G.historyState(projectId).depth;
    const submits = apiLog.applies.slice(appearsBefore);
    note(`调试：提交的格 ${submits.flatMap((b) => (b.ops ?? []).flatMap((op) => (op.cells ?? []).map((c) => `${c.r},${c.c},t${c.tile}`))).join(" ")}`);

    check("在画布上按下 → 拖动 → 抬起真的改了地图（宿主计划变了）", JSON.stringify(planAfter.chunks) !== JSON.stringify(planBefore.chunks), `${planBefore.chunks.flatMap((c) => c.ops).length} → ${planAfter.chunks.flatMap((c) => c.ops).length} 条 op`);
    check("改了之后画布重画了", drawFrames.length > framesBefore, `${framesBefore} → ${drawFrames.length} 帧`);
    check("一笔拖拽只提交**一次**（改完样式：不一边画一边存），宿主历史 +1", depthAfter === depthBefore + 1 && submits.length === 1, `depth ${depthBefore} → ${depthAfter}，提交 ${submits.length} 批`);
    /**
     * 用户要的其实是两件：**画的过程中看得见**（预览），但**别一边画一边存**（提交）。
     * 所以拖动期间必须出现带 `pending` 的计划查询（宿主只算不存），而 applyMapOps 一次都不发。
     */
    const previewQueries = apiLog.plans.filter((entry) => Array.isArray(entry.pending) && entry.pending.length > 0);
    check(
      "拖动期间画得出来：发出了带 pending 的预览查询（宿主只算不存）",
      previewQueries.length > 0,
      `预览查询 ${previewQueries.length} 次 / 总共 ${apiLog.plans.length} 次查询`
    );
    /**
     * ⚠️ 这条原来写得太松（「有一块带 op」或「visibleKeys 非空」都算过），结果放过去一个真机 bug：
     * 预览查询带着 `have`，宿主认为「你有这一块」就不回传 —— 于是拖动期间**一片空白**，
     * 松手提交后靠 dropKeys 重拉才出现。现在按「返回的那块里、那一格的 op 真的换了」来判。
     */
    const opAt = (result, r, c) => {
      for (const chunk of result.chunks ?? []) {
        const hit = chunk.ops.find((op) => op.r === r && op.c === c);
        if (hit !== undefined) return hit;
      }
      return null;
    };
    const beforeOp = opAt(planBefore, viewMidR, viewMidC);
    const strictPreview = previewQueries.some((entry) => {
      const op = opAt(entry.result, viewMidR, viewMidC);
      return op !== null && (beforeOp === null || op.t !== beforeOp.t);
    });
    check(
      "预览真的把这一笔画进了计划（返回块里那一格的内容变了，不是空转）",
      strictPreview,
      `按下格 ${viewMidR},${viewMidC}：拖动前 ${beforeOp === null ? "无 op" : "t" + beforeOp.t}，预览回传块 ${previewQueries.map((entry) => entry.result.chunks.length).join(",")}`
    );
    check(
      "预览期间 applyMapOps 一次都没发（只有松手那一次）",
      apiLog.applies.length - appearsBefore === 1,
      `${apiLog.applies.length - appearsBefore} 次`
    );
    check(
      "这一次提交带非空 stroke（少了它一次拖拽会变成好几步撤销）",
      submits.length === 1 && typeof submits[0].stroke === "string" && submits[0].stroke !== "",
      submits.map((submit) => String(submit.stroke)).join(",")
    );
    check("每一批提交都把本地缓存的 chunk key 报上去（have，宿主据此只回失效的块）", submits.every((submit) => Array.isArray(submit.have)) && submits.some((submit) => submit.have.length > 0), submits.map((submit) => submit.have.length).join(","));
    check("画布重画用的还是宿主的计划（改动后 drawn 仍等于计划条数）", windowStub.__mapDrawStats?.noImage === 0 && windowStub.__mapDrawStats?.noLegend === 0, JSON.stringify(windowStub.__mapDrawStats ?? null));
    /**
     * ⚠️ 拖动期间**一帧都不能是空的**。
     *
     * 真机踩过：提交完一批 op 之后宿主回的 `dropKeys` 里就有刚画的那一块，客户端当时是
     * **直接把它从缓存里删掉**，于是从「删掉」到「重拉回来」之间这块是空的 —— 一块 = 整张
     * 地图（32×32 地图在 `MAP_CHUNK_SIZE = 32` 下只有一块）时，就是**拖动期间每 40ms 全屏闪
     * 一下**（真机实测 266 个采样里 77 个是空屏）。所以这里按帧断言：旧内容要一直留到新内容回来。
     */
    const strokeFrames = drawFrames.slice(framesBefore).map((frame) => frame.length);
    check(
      "拖动过程中没有一帧是空的（旧内容留到新内容回来，不闪全屏）",
      strokeFrames.length > 0 && strokeFrames.every((size) => size > 0),
      `帧大小 ${strokeFrames.join(",")}`
    );
    // 重拉回来之后，**改动过的那几格**必须画的是新贴图。
    // 只比位置抓不到「内容还是旧的」：同一格重画后位置不变、贴图源矩形变了。
    const beforeTileAt = new Map(planBefore.chunks.flatMap((chunk) => chunk.ops).map((op) => [`${op.x},${op.y}`, op.t]));
    // 注意也要算上「原来这一格是空的」：那时 beforeTileAt 里没有这个位置，
    // 画上去就是新增的 op（`undefined !== t` 自然成立）。
    const changedOps = planAfter.chunks
      .flatMap((chunk) => chunk.ops)
      .filter((op) => beforeTileAt.get(`${op.x},${op.y}`) !== op.t);
    const rectOfTile = new Map((planAfter.legend || []).map((entry) => [entry.index, entry.rect]));
    const drawnByPos = new Map(frameOf().map((draw) => [`${draw.dx},${draw.dy}`, draw]));
    const stillStale = changedOps.filter((op) => {
      const draw = drawnByPos.get(`${op.x},${op.y}`);
      const rect = rectOfTile.get(op.t);
      if (draw === undefined || rect === undefined) return true;
      return draw.sx !== rect.x || draw.sy !== rect.y;
    });
    check(
      "重拉回来后改动过的那几格画的是新贴图（不是留在旧内容上）",
      changedOps.length > 0 && stillStale.length === 0,
      `改动了 ${changedOps.length} 格，仍画旧贴图 ${stillStale.length} 格`
    );

    // 撤销
    const undoButton = byTool(tree, "undo")[0];
    check("有撤销按钮（图标按钮 + aria-label，说明走自绘小标签）", undoButton !== undefined && String(undoButton.props["aria-label"]).includes("撤销"));
    undoButton.props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const restored = await G.mapPlan(projectId, { view: beforeView, have: [] });
    check("撤销后宿主计划**回到点击之前**（JSON 全等）", JSON.stringify(restored.chunks) === JSON.stringify(planBefore.chunks), `${restored.chunks.flatMap((c) => c.ops).length} vs ${planBefore.chunks.flatMap((c) => c.ops).length}`);
    check("撤销后按钮状态跟着变（canRedo 变 true）", byTool(tree, "redo")[0].props.disabled === false);
    // 重做
    byTool(tree, "redo")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const redone = await G.mapPlan(projectId, { view: beforeView, have: [] });
    check("重做后宿主计划又回到改动之后（JSON 全等）", JSON.stringify(redone.chunks) === JSON.stringify(planAfter.chunks));
    check("撤销 / 重做走的是宿主（apiLog 里各记了一次）", apiLog.undos >= 1 && apiLog.redos >= 1, `undo=${apiLog.undos} redo=${apiLog.redos}`);
  }

  // ══ 9. 单层预览：过滤由宿主做 ════════════════════════════════════════════
  section("9) 单层预览（layerIds 交给宿主过滤，界面不筛 op）");
  {
    const queriesBefore = apiLog.plans.length;
    byTool(tree, "single")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const singleQueries = apiLog.plans.slice(queriesBefore).filter((query) => Array.isArray(query.layerIds));
    check("打开单层预览后请求计划时带了 layerIds", singleQueries.length > 0, `${singleQueries.length} 次查询带 layerIds`);
    const query = singleQueries[0];
    check("layerIds 就是当前层号（第 1 层 → [0]）", JSON.stringify(query.layerIds) === JSON.stringify([0]), JSON.stringify(query.layerIds));
    const singleOps = query.result.chunks.flatMap((chunk) => chunk.ops);
    check("宿主返回的那份计划只含这一层（过滤真的发生了）", singleOps.length > 0 && singleOps.every((op) => op.l === 0), `${singleOps.length} 条，层号集合 ${[...new Set(singleOps.map((op) => op.l))].join(",")}`);
    const layer0Only = await G.mapPlan(projectId, { view: query.view, have: [], layerIds: [0] });
    const layer1Only = await G.mapPlan(projectId, { view: query.view, have: [], layerIds: [1] });
    check(
      "反向验证：宿主的两层内容不同（层过滤不是「反正都一样」）",
      layer0Only.chunks.flatMap((c) => c.ops).every((op) => op.l === 0) &&
        layer1Only.chunks.flatMap((c) => c.ops).every((op) => op.l === 1) &&
        layer1Only.chunks.flatMap((c) => c.ops).length > 0
    );
    check(
      "单层预览打开时画布底铺绿色（rgb(56,170,68)，AsLib 同款）",
      fillRects.some((rect) => rect.fillStyle === "rgb(56,170,68)"),
      [...new Set(fillRects.map((rect) => rect.fillStyle))].slice(0, 4).join(" / ")
    );
    byTool(tree, "single")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const allAgain = apiLog.plans[apiLog.plans.length - 1];
    check("关掉单层预览后 layerIds 不再传（回到全部层）", allAgain.layerIds === undefined, JSON.stringify(allAgain.layerIds));
  }

  // ══ 10. 橡皮不依赖笔刷（新面板重来一次，笔刷恒为 null）════════════════════
  section("10) 橡皮的可用性不依赖笔刷（新挂载的面板，笔刷为 null）");
  {
    const freshTree = await freshPanel();
    check("新挂载的面板有机会画（视图已加载）", !textOf(freshTree).includes("还没有地图项目"), textOf(freshTree).slice(0, 160));
    byTool(freshTree, "eraser")[0].props.onClick();
    let erased = await renderTree(() => MapModule({ api }));
    const before = apiLog.applies.length;
    const liveCanvas = collect(erased, (node) => node.props?.["data-testid"] === "map-canvas")[0];
    const eraseAt = clientOf(1, 1);
    liveCanvas.props.onPointerDown({ clientX: eraseAt.x, clientY: eraseAt.y, button: 0, pointerId: 1 });
    await tickTimers();
    liveCanvas.props.onPointerUp({ pointerId: 1 });
    erased = await renderTree(() => MapModule({ api }));
    const submits = apiLog.applies.slice(before);
    const paintOps = submits.flatMap((submit) => submit.ops).filter((op) => op.kind === "paint");
    check("没选过任何笔刷时，橡皮照样提交 op（tile 0）", paintOps.length > 0 && paintOps.every((op) => op.cells.every((cell) => cell.tile === 0)), `${paintOps.length} 条 paint op`);
    check("橡皮不会弹「先在左边点一块图当笔刷」", !textOf(erased).includes("先在左边点一块图当笔刷"), textOf(erased).slice(-60));
    // 反向验证：同一份面板、同一次挂载下，用画笔点一下就会被拦（证明这条路径确实不同）
    byTool(erased, "pen")[0].props.onClick();
    erased = await renderTree(() => MapModule({ api }));
    const beforePen = apiLog.applies.length;
    const penCanvas = collect(erased, (node) => node.props?.["data-testid"] === "map-canvas")[0];
    const seamAt = clientOf(4, 4);
    penCanvas.props.onPointerDown({ clientX: seamAt.x, clientY: seamAt.y, button: 0, pointerId: 1 });
    penCanvas.props.onPointerUp({ pointerId: 1 });
    erased = await renderTree(() => MapModule({ api }));
    check("反向验证：笔刷下用画笔点一下不会提交 op，并给出提示", apiLog.applies.length === beforePen && textOf(erased).includes("先在左边点一块图当笔刷"), textOf(erased).slice(-60));
  }

  // ══ 11. 减少动态效果：停在帧 0 ═══════════════════════════════════════════
  section("11) prefers-reduced-motion：停在帧 0");
  {
    reduceMotion = true;
    rafQueue.clear();
    const stillTree = await renderTree(() => MapModule({ api }), { fresh: true });
    check("开启「减少动态效果」后面板照常渲染", !textOf(stillTree).includes("还没有地图项目"));
    check("不再注册动画回调（不推时钟）", rafQueue.size === 0, `${rafQueue.size} 个`);
    check("帧号停在 0", windowStub.__mapDrawStats?.frame === 0, `frame=${String(windowStub.__mapDrawStats?.frame)}`);
    reduceMotion = false;
  }

  // ══ 12. 空态与健壮性 ═════════════════════════════════════════════════════
  section("12) 空态（没有项目时一句话 + 两个按钮）");
  {
    const emptyApi = { ...api, listMapProjects: async () => ({ projects: [] }) };
    const clicksBefore = fileClicks;
    const emptyTree = await renderTree(() => MapModule({ api: emptyApi }), { fresh: true });
    check("没有项目时给空态而不是崩", textOf(emptyTree).includes("还没有地图项目"), textOf(emptyTree).slice(0, 60));
    check("空态有两个按钮：选一张素材图开始 / 用自带素材试试", /选一张素材图开始/.test(textOf(emptyTree)) && /用自带素材试试/.test(textOf(emptyTree)), textOf(emptyTree).slice(0, 120));
    check("空态也带着实验性说明弹窗（早退分支不能漏）", collect(emptyTree, (node) => typeof node.type === "function" && node.type.name === "MapExperimentalDialog").length === 1);
    check("空态不出现阶段条 / 自造阶段类名", byClass(emptyTree, "SPR_step").length === 0 && byClass(emptyTree, "SPR_meSteps").length === 0);
    const startBtn = collect(emptyTree, (node) => node.type === "button" && textOf(node).includes("选一张素材图开始"))[0];
    if (startBtn !== undefined) startBtn.props.onClick();
    check("点「选一张素材图开始」会打开文件选择框", fileClicks > clicksBefore, `click 次数 ${clicksBefore} → ${fileClicks}`);
    check("空态文本里不出现 markdown 星号", !textOf(emptyTree).includes("**"));
  }

  // ══ 13. 实验性弹窗 ═══════════════════════════════════════════════════════
  section("13) 实验性弹窗（能关、文言不复讲旧功能）");
  {
    const gate = await withFreshHooks(async () => {
      let closed = false;
      const raw = await renderTree(() => MapExperimentalDialog({ onClose: () => { closed = true; } }));
      const expanded = expandComponents(raw);
      const closer = collect(expanded, (node) => node.props?.["data-testid"] === "rig-experimental-ok")[0] ?? collect(expanded, (node) => node.type === "button" && textOf(node).trim() !== "")[0];
      if (closer !== undefined) closer.props.onClick({ stopPropagation() {} });
      return { expanded, closer, closed };
    });
    const gateText = textOf(gate.expanded);
    check("弹窗列出模块六自己的要点（>= 3 条）", byClass(gate.expanded, "SPR_gateBody").length >= 3, `${byClass(gate.expanded, "SPR_gateBody").length} 条`);
    check("弹窗讲的是「本地跑、不花钱」（模块六的性质）", gateText.includes("全本地") || gateText.includes("不花钱"), gateText.slice(0, 60));
    check("弹窗内容不再讲旧功能（地形族 / 掩码 / 切分 / 图集 / Tiled / 等距 / chunk / 阶段）", !/地形族|掩码|切分|图集|Tiled|等距|chunk|优先级|阶段/.test(gateText), gateText.slice(0, 80));
    check("弹窗有关闭按钮，点了会回调 onClose", gate.closer !== undefined && gate.closed === true, `closed=${String(gate.closed)}`);
  }

  // ══ 14. 静态源码约束 ═════════════════════════════════════════════════════
  section("14) 界面只执行宿主计划（静态源码约束）");
  const clientSource = readFileSync(fileURLToPath(new URL("../src/client.ts", import.meta.url)), "utf8");
  /**
   * 只看模块六那一段：模块④（Spine 图集）与模块⑤（45° 等距地块）里的
   * 「图集」「等距」是**正确用词**，全文件扫会误伤。
   */
  const mapStart = clientSource.indexOf("模块六 · 地图编辑器");
  const mapEnd = clientSource.indexOf("模块②：图片生成", mapStart);
  const mapSource = mapStart >= 0 && mapEnd > mapStart ? clientSource.slice(mapStart, mapEnd) : "";
  check("能定位到模块六那一段源码（切片锚点还在，且切出了足量内容）", mapSource.length > 20000, `${mapSource.length} 字节`);
  check("模块②那个锚点注释还在（自检按它切片）", mapEnd > mapStart && clientSource.includes("模块②：图片生成"));
  check("界面里有 MAP_pointToCell（命中测试必需的那一份复刻）", mapSource.includes("function MAP_pointToCell"));
  check(
    "模块六里没有变体挑选 / 绘制顺序 / chunk 计算（那些全在宿主）",
    !mapSource.includes("MAP_pickVariant") && !mapSource.includes("MAP_drawOrder") && !mapSource.includes("MAP_visibleChunks") && !mapSource.includes("MAP_chunkKey"),
    ["MAP_pickVariant", "MAP_drawOrder", "MAP_visibleChunks", "MAP_chunkKey"].filter((name) => mapSource.includes(name)).join(",")
  );
  check("模块六里没有自造坐标变换（只允许那四个 MAP_ 函数 + 取模辅助）", !/layoutOf\(|tileOriginAt\(|stableHash/.test(mapSource));
  check("模块六没有复用八方向图那个蒙层样式 SPR_stageHint", !mapSource.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "").includes("SPR_stageHint"), "复用它会把说明绝对定位铺满容器");
  /**
   * ⚠️ 术语黑名单：用户对第一版的反馈就是「门槛太高、专业名词太多」。
   * 只扫模块六那一段 —— 「图集」（Spine 纹理图集）与「等距」（45° 地块）在别的模块里是正确的。
   *
   * 唯一的例外是**协议字段名** `"chunks"`（宿主 `mapPlan` 返回体里那批 op 就叫这个名字，
   * 界面从不把它呈现给用户）。例外收得很紧：只许这一个字面量，
   * 而且它出现几次，`chunk` 就得命中几次 —— 多出来的用法（注释、变量名）一律算命中。
   */
  const chunkLiterals = (mapSource.match(/"chunks"/g) ?? []).length;
  const chunkHits = (mapSource.match(/chunk/g) ?? []).length;
  check(
    "黑名单例外收得很紧：模块六里 chunk 只作为协议字段 \"chunks\" 出现（没有别处用法）",
    chunkHits === chunkLiterals && chunkLiterals >= 1 && chunkLiterals <= 2,
    `chunk 命中 ${chunkHits} 次，其中协议字段字面量 ${chunkLiterals} 次`
  );
  const mapSourceNoProtocol = mapSource.replace(/"chunks"/g, "«协议字段»");
  for (const word of ["地形族", "掩码", "优先级", "切分", "chunk", "图集", "变体种子", "高度偏移", "Tiled", "等距"]) {
    check(`模块六的源码 / 文案里不出现旧术语「${word}」`, !mapSourceNoProtocol.includes(word), "命中旧术语");
  }
  check("（对照）整份客户端里别处仍允许出现「图集」/「等距」（模块④ / ⑤ 的正确用词）", clientSource.length > mapSource.length && clientSource.includes("等距") && clientSource.includes("图集"));
  /**
   * ⚠️ 用到的每个 `SPR_` 类都必须真的有 CSS 规则（或本来就是个纯文本容器）。
   * 这条是**真机打脸**换来的：自造的类名一个 CSS 规则都没有 → 界面塌成几个小按钮。
   */
  const mapCode = mapSource.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const styled = new Set();
  for (const match of clientSource.matchAll(/\.(SPR_[A-Za-z0-9_-]+)/g)) styled.add(match[1]);
  const intentionallyUnstyled = new Set(["SPR_moduleBody", "SPR_notice", "SPR_select"]);
  const usedClasses = new Set();
  for (const match of mapCode.matchAll(/SPR_[A-Za-z0-9_-]+/g)) {
    if (match[0].endsWith("-")) continue; // `SPR_notice-${kind}` 这种是模板片段
    usedClasses.add(match[0]);
  }
  const unstyled = [...usedClasses].filter((name) => !styled.has(name) && !intentionallyUnstyled.has(name)).sort();
  check(`模块六用到的 ${usedClasses.size} 个类都有 CSS 规则（或本来无样式）`, unstyled.length === 0, unstyled.length === 0 ? "" : `没有样式：${unstyled.join("、")}`);
  check("面板外层仍走 DSH 变量（深色主题下不塌）", clientSource.includes(".SPR_mapEdRoot{") && clientSource.includes("border:1px solid var(--dsw-alias-border-l2)"));
  for (const [name, needle] of [
    ["保存状态色", '.SPR_mapEdSave[data-busy="true"]{color:var(--dsw-alias-state-warning-primary'],
    ["通过标记色", ".SPR_mapEdMark{color:var(--dsw-alias-state-success-primary"],
    ["危险操作色", '.SPR_mapEdMenuItem[data-danger="true"]{color:var(--dsw-alias-state-error-primary'],
    ["导出链接色", ".SPR_mapEdFiles a{color:var(--dsw-alias-state-business-primary"]
  ]) {
    check(`模块六的${name}走 var(--dsw-alias-state-*)（状态色没有写死）`, clientSource.includes(needle), needle);
  }
  check("调色板可滚动（overflow:auto，条目多了滚轮能滚）", /\.SPR_mapEdPalette\{[^}]*overflow:auto/.test(clientSource));
  check("调色板是 8 列 32px 网格", clientSource.includes(".SPR_mapEdPaletteGrid{display:grid;grid-template-columns:repeat(8,32px)"));
  check("工具格是 6 列 × 2 行", clientSource.includes(".SPR_mapEdTools{display:grid;grid-template-columns:repeat(6,1fr)"));
  // 工具小标签：固定定位才不会被祖先的 overflow 裁掉「按钮正上方」那段；坐标要夹在视口内。
  check(
    "工具小标签用 position:fixed + translate(-50%,-100%)（absolute 会被 overflow 裁掉）",
    /\.SPR_mapEdTip\{position:fixed[^}]*translate\(-50%,-100%\)/.test(clientSource)
  );
  check("工具小标签贴边时被夹在视口内", /Math\.max\(half, Math\.min\(center, viewWidth - half\)\)/.test(clientSource));
  // 新建 / 重命名：不许再依赖原生 prompt（Electron 里它是坏的），两个入口都走同一个对话框。
  // 用剥掉注释的 mapCode：注释里正解释着「为什么不能用 window.prompt」。
  check("模块六不再调用 window.prompt", !/window\.prompt/.test(mapCode));
  check("新建与重命名都走自带的名字对话框", /askProjectName\("create"\)/.test(mapCode) && /askProjectName\("rename"\)/.test(mapCode));
  check("名字对话框用 position:fixed 居中（absolute 会被 overflow 裁掉）", /\.SPR_mapEdDlgMask\{position:fixed/.test(clientSource));
  check(
    "悬停红框按**未取模**坐标定位（环绕时同一格有多份，取模后会跳一整张地图）",
    /const rawC = Math\.floor\(hover\.x \/ layout\.stepX\)/.test(mapCode) && /const rawR = Math\.floor\(hover\.y \/ layout\.stepY\)/.test(mapCode)
  );
  check("选中的笔刷是红框（outline 2px 红，AsLib 同款）", /\.SPR_mapEdTile\[data-on="true"\]\{outline:2px solid #e23b2b/.test(clientSource));
  check("画布用 image-rendering:pixelated / touch-action:none（像素画不糊、触摸不滚动）", /\.SPR_mapEdCanvas\{[^}]*image-rendering:pixelated[^}]*touch-action:none/.test(clientSource));
  /**
   * ⚠️ 一次拖拽 = **一步**撤销。客户端必须把 `stroke` 一路带上（拖拽期间分多批提交），
   * 否则真机上擦一条线要按好几次撤销。
   */
  check("拖拽带笔画 id（applyMapOps payload 里带 stroke）", /stroke:\s*ops\[0\]\?\.stroke/.test(mapSource), "少了它，一笔拖拽会变成好几步撤销");
  check("笔画 id 在拖动期间保持同一个（currentStroke）", /currentStroke\.current/.test(mapSource) && /pendingOps\.current\.concat/.test(mapSource));
  check("wire 的 applyMapOps schema 声明了 stroke（不声明会被静默丢掉）", readFileSync(fileURLToPath(new URL("../src/wire.ts", import.meta.url)), "utf8").includes("stroke: z.string().optional()"));
  /**
   * ⚠️ 橡皮**不需要**笔刷。判断写成「笔刷为空就返回」的话，刚进面板还没选过图时
   * 橡皮拖半天一点反应都没有、也不报错（真机踩过）。
   * 判据是**顺序**：`tool === "eraser"` 那条分支必须排在 `warnNoBrush()` 之前，
   * 而且擦的是 tile 0。
   */
  const eraseBranchAt = mapSource.indexOf('tool === "eraser"');
  const brushGuardAt = mapSource.indexOf("warnNoBrush()");
  check(
    "橡皮的可用性判断不依赖笔刷（eraser 分支在 warnNoBrush 之前，且擦的是 tile 0）",
    eraseBranchAt > 0 && brushGuardAt > eraseBranchAt && /tile:\s*0/.test(mapSource) && mapSource.includes("先在左边点一块图当笔刷"),
    `eraser@${eraseBranchAt} warnNoBrush@${brushGuardAt}`
  );
  check("调色板读的是宿主给的 palette（不是自己从 legend 里推可点的块）", /owner\.palette|\.palette\.length/.test(mapSource) && /A2 素材只出 1 个条目|palette/.test(mapSource));
  check("渲染循环没有失控（没有 setState 死循环）", HOOK_MISMATCH.length === 0, HOOK_MISMATCH.join("；"));

  // ══ 15. 挂载首帧 == 同一视口的计划（不整份重拉）══════════════════════════
  section("15) 挂载首帧 == 同一视口的计划（增量缓存按视口失效）");
  {
    const mountQuery = apiLog.plans[0];
    if (mountQuery !== undefined) {
      const mountPlan = await G.mapPlan(projectId, { view: mountQuery.view, have: [] });
      const settledView = apiLog.plans[apiLog.plans.length - 1]?.view ?? mountQuery.view;
      const settledPlan = await G.mapPlan(projectId, { view: settledView, have: [] });
      note(`首次查询视口 ${JSON.stringify(mountQuery.view)} → visibleKeys ${mountPlan.visibleKeys.join(" ")}`);
      note(`稳定后视口 ${JSON.stringify(settledView)} → visibleKeys ${settledPlan.visibleKeys.join(" ")}`);
    }
    /**
     * 在「第一次查询那个窗口之外」（第 25 行）放一格内容，再**全新挂载**一次。
     *
     * 这里刻意**不做任何整份重拉**（不碰 planKey）：面板挂载时会按量到的画布尺寸
     * 先查一次计划，紧接着 fit effect 把缩放改成「整张图放得下」。真机上那两次
     * 状态提交都发生在 32ms 防抖窗口之内，所以**只有后一次查询会真的发出去**；
     * 假 React 这边也照这个语义放定时器（见 timers 的注释），于是首帧应当就是
     * 「稳定视口的完整计划」。一旦有人把 `have` 的失效口径改坏（或让旧查询漏出去），
     * 首帧就会缺一块 —— 这条断言就是「预览 = 导出」在挂载那一刻的形态。
     */
    await G.applyMapOps(projectId, [{ kind: "paint", layerId: "l0", cells: [{ r: 25, c: 25, tile: propBrush }] }]);
    const freshTree = await freshPanel();
    const freshQuery = apiLog.plans[apiLog.plans.length - 1];
    const mountFrame = frameOf();
    const needPlan = await G.mapPlan(projectId, { view: freshQuery.view, have: [] });
    const needOps = needPlan.chunks.flatMap((chunk) => chunk.ops);
    const key255 = (op) => `${op.x},${op.y}`;
    const drawn = new Set(mountFrame.map((draw) => `${draw.dx},${draw.dy}`));
    const needed = new Set(needOps.map(key255));
    const missing = [...needed].filter((key) => !drawn.has(key));
    const extra = [...drawn].filter((key) => !needed.has(key));
    note(`全新挂载（内容含 (25,25)）：首帧 ${mountFrame.length} 条 drawImage（${drawn.size} 个像素位置）`);
    note(`同一视口的宿主计划 ${needOps.length} 条（${needed.size} 个像素位置）`);
    note(`缺的位置例如 ${missing.slice(0, 6).join(" | ")}${extra.length > 0 ? `；多的位置例如 ${extra.slice(0, 3).join(" | ")}` : ""}`);
    check(
      "挂载后首帧 == 同一视口的计划（增量缓存必须按视口失效）",
      missing.length === 0 && extra.length === 0,
      `首帧 ${drawn.size}/${needed.size} 个像素位置：缺 ${missing.length} 个、多 ${extra.length} 个`
    );
    check("诊断用的全新面板本身渲染正常（视图已加载）", !textOf(freshTree).includes("还没有地图项目"));
  }

  // ══ 16) 新建 / 重命名 与 悬停红框（都会动到面板状态，所以放在最后）══════════
  section("16) 新建项目走自带对话框（Electron 里原生 prompt 是坏的）+ 悬停红框跟着指针");
  {
    // 前面的用例把 `tree` 留在了别的快照上（第 15 段还单独挂过一次），这里重新挂一份
    // 自洽的面板再点，免得点到过期闭包上（菜单开关会因此「点了没反应」）。
    tree = await freshPanel();
    // ── 新建 / 重命名：自带对话框，不依赖原生 window.prompt ───────────────
    windowStub.__promptCalls.length = 0;
    const projButton = byClass(tree, "SPR_mapEdProj")[0];
    check("顶栏有项目菜单入口", projButton !== undefined && textOf(projButton).includes("▾"), textOf(projButton ?? null));
    /** 菜单是开关：前面的用例可能已经把它留着开着了，别盲目再点一下（会关掉）。 */
    const ensureMenu = async () => {
      if (byClass(tree, "SPR_mapEdMenuItem").length === 0) {
        byClass(tree, "SPR_mapEdProj")[0].props.onClick();
        tree = await renderTree(() => MapModule({ api }));
      }
      return byClass(tree, "SPR_mapEdMenuItem");
    };
    const menuItems = await ensureMenu();
    const newItem = menuItems.find((node) => textOf(node) === "新建项目");
    check("项目菜单里有「新建项目」", newItem !== undefined, menuItems.map((node) => textOf(node)).join(" / "));
    newItem.props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const dlg = byClass(tree, "SPR_mapEdDlg")[0];
    const nameInput = collect(tree, (node) => node.props?.["data-testid"] === "map-name-input")[0];
    check("点「新建项目」弹出面板自己的对话框（不再走原生 prompt）", dlg !== undefined && nameInput !== undefined);
    check(
      "对话框里预填了默认名，且全程没碰 window.prompt",
      nameInput?.props.value === "我的地图" && windowStub.__promptCalls.length === 0,
      `值 ${nameInput?.props.value} / prompt 调用 ${windowStub.__promptCalls.length} 次`
    );
    check(
      "对话框标题与「取消 / 确定」都在",
      dlg !== undefined && textOf(dlg).includes("新建项目") && collect(dlg, (node) => node.props?.["data-testid"] === "map-name-ok").length === 1 && collect(dlg, (node) => node.props?.["data-testid"] === "map-name-cancel").length === 1,
      textOf(dlg)
    );
    // 输入名字 → 回车确认（与点「确定」共用同一个提交函数）
    nameInput.props.onChange({ target: { value: "自检建的项目" } });
    tree = await renderTree(() => MapModule({ api }));
    collect(tree, (node) => node.props?.["data-testid"] === "map-name-input")[0].props.onKeyDown({ key: "Enter", preventDefault() {} });
    tree = await renderTree(() => MapModule({ api }));
    check("回车确认后对话框关掉", byClass(tree, "SPR_mapEdDlg").length === 0);
    check("项目真的建出来了，并且已经切过去", textOf(byClass(tree, "SPR_mapEdProj")[0] ?? null).includes("自检建的项目"), textOf(byClass(tree, "SPR_mapEdProj")[0] ?? null));
    const built = await G.listMapProjects();
    check("宿主侧确实多出这个名字的项目", built.some((item) => item.name === "自检建的项目"), built.map((item) => item.name).join(" / "));
    // 取消路径：一个项目都不能多出来
    (await ensureMenu()).find((node) => textOf(node) === "新建项目").props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    collect(tree, (node) => node.props?.["data-testid"] === "map-name-input")[0].props.onChange({ target: { value: "不该被建出来" } });
    tree = await renderTree(() => MapModule({ api }));
    collect(tree, (node) => node.props?.["data-testid"] === "map-name-cancel")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const afterCancel = await G.listMapProjects();
    check(
      "点「取消」不会建出项目",
      byClass(tree, "SPR_mapEdDlg").length === 0 && !afterCancel.some((item) => item.name === "不该被建出来"),
      afterCancel.map((item) => item.name).join(" / ")
    );
    // 重命名：同一个对话框（点到「重命名」就换成重命名标题）
    (await ensureMenu()).find((node) => textOf(node) === "重命名").props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check("「重命名」弹出的是同一个对话框、预填当前名字", textOf(byClass(tree, "SPR_mapEdDlg")[0] ?? null).includes("重命名项目") && collect(tree, (node) => node.props?.["data-testid"] === "map-name-input")[0]?.props.value === "自检建的项目", textOf(byClass(tree, "SPR_mapEdDlg")[0] ?? null));
    collect(tree, (node) => node.props?.["data-testid"] === "map-name-cancel")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
  }
  {
    // ── 悬停红框跟着指针，且**地图外不悬停**─────────────────────────────────
    // 老 bug：红框按取模后的格号画，指针落在地图外那一份时红框会跳一整张地图。
    // 现在的契约更简单：只认地图自己那一份 —— 图内红框跟着指针，图外干脆不画。
    {
      /** ⚠️ `fillRects` 是累积的（每次重画只是往里继续 push），所以必须按「这次之前」切片。 */
      const redFrameSince = (from) => {
        const rects = fillRects.slice(from).filter((item) => item.fillStyle === "#e23b2b").slice(-4);
        if (rects.length < 4) return null;
        return {
          left: Math.min(...rects.map((item) => item.x)),
          right: Math.max(...rects.map((item) => item.x + item.w)),
          top: Math.min(...rects.map((item) => item.y)),
          bottom: Math.max(...rects.map((item) => item.y + item.h))
        };
      };
      const hitCanvas = () => collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
      const inside = [];
      for (const [r, c] of [[2, 3], [7, 9], [12, 5], [15, 14]]) {
        const before = fillRects.length;
        const at = clientOf(r, c);
        hitCanvas().props.onPointerMove({ clientX: at.x, clientY: at.y, pointerId: 41 });
        tree = await renderTree(() => MapModule({ api }));
        // 红框的 fillRect 参数是**地图坐标**（画布带变换），所以拿格的中心去比，不用管屏幕像素
        const frame = redFrameSince(before);
        const cx = (c + 0.5) * 32, cy = (r + 0.5) * 32;
        inside.push(frame !== null && frame.left - 0.6 <= cx && cx <= frame.right + 0.6 && frame.top - 0.6 <= cy && cy <= frame.bottom + 0.6);
      }
      check("图内悬停：红框落在这几格上（4 个位置全中）", inside.every(Boolean), inside.map((ok) => (ok ? "✓" : "✗")).join(""));
      // 地图外（右下角那片空白）：不该有红框 —— 用户就是在这里发现「画到图外会点亮相反的边」
      const beforeOutside = fillRects.length;
      const outside = clientOf(40, 40);
      hitCanvas().props.onPointerMove({ clientX: outside.x, clientY: outside.y, pointerId: 42 });
      tree = await renderTree(() => MapModule({ api }));
      check("地图外悬停不画红框（图外那片空白不该有落笔提示）", redFrameSince(beforeOutside) === null, JSON.stringify(redFrameSince(beforeOutside)));
    }
  }

  // ══ 17) 地图外不落笔；图内快速拖动仍要补满 ═══════════════════════════════
  // 真机反馈：「画超过右边缘时左边缘被着色、超过下边缘时上边缘被着色」——
  // 环绕地图上 `pointToCell` 会把图外折回图内。现在只认地图自己那一份。
  section("17) 地图外不落笔（不折回另一边）+ 图内快速拖动补满");
  {
    // 夹具准备：上一段建过自己的项目（没有素材），这里重挂并切回主夹具，选一支笔
    tree = await freshPanel();
    const mainName17 = (await G.readMapProject(projectId)).name;
    if (byClass(tree, "SPR_mapEdMenuItem").length === 0) {
      byClass(tree, "SPR_mapEdProj")[0].props.onClick();
      tree = await renderTree(() => MapModule({ api }));
    }
    byClass(tree, "SPR_mapEdMenuItem").find((node) => textOf(node) === mainName17).props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    byClass(tree, "SPR_mapEdTile")[0].props.onClick({ shiftKey: false });
    tree = await renderTree(() => MapModule({ api }));
    byTool(tree, "pen")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const grid = (await G.readMapProject(projectId)).grid;
    const probeView = { x: 0, y: 0, width: grid.tileWidth, height: grid.tileHeight };
    const cols = (await G.mapPlan(projectId, { view: probeView, have: [] })).cols;
    const rows = (await G.mapPlan(projectId, { view: probeView, have: [] })).rows;
    const canvasNode = () => collect(tree, (node) => node.props?.["data-testid"] === "map-canvas")[0];
    const dragCells = async (from, to) => {
      const before = apiLog.applies.length;
      const a = clientOf(from[0], from[1], grid.tileWidth);
      const b = clientOf(to[0], to[1], grid.tileWidth);
      canvasNode().props.onPointerDown({ clientX: a.x, clientY: a.y, button: 0, pointerId: 51 });
      canvasNode().props.onPointerMove({ clientX: b.x, clientY: b.y, pointerId: 51 });
      canvasNode().props.onPointerUp({ pointerId: 51 });
      tree = await renderTree(() => MapModule({ api }));
      await tickTimers();
      tree = await renderTree(() => MapModule({ api }));
      const painted = new Set();
      for (const batch of apiLog.applies.slice(before)) {
        for (const op of batch.ops ?? []) {
          for (const cell of op.cells ?? []) painted.add(`${((cell.r % rows) + rows) % rows},${((cell.c % cols) + cols) % cols}`);
        }
      }
      return painted;
    };
    // ① 往右拖出地图：不能折回左边
    const right = await dragCells([5, cols - 1], [5, cols + 2]);
    check(
      "画超过右边缘不会点亮左边缘（图外那两格不落笔）",
      right.size > 0 && ![...right].some((key) => key.split(",")[1] === "0"),
      `落笔：${[...right].join(" ")}`
    );
    // ② 往下拖出地图：不能折回上边
    const down = await dragCells([rows - 1, 6], [rows + 2, 6]);
    check(
      "画超过下边缘不会点亮上边缘（图外那两格不落笔）",
      down.size > 0 && ![...down].some((key) => key.split(",")[0] === "0"),
      `落笔：${[...down].join(" ")}`
    );
    // ③ 同一格内挪 12 次不该重画；跨格挪 4 次必须重画（两边一起才有区分力）
    {
      const canvas = canvasNode();
      const at = clientOf(7, 7, grid.tileWidth);
      canvas.props.onPointerMove({ clientX: at.x, clientY: at.y, pointerId: 61 });
      tree = await renderTree(() => MapModule({ api }));
      const intraBefore = drawFrames.length;
      for (let i = 1; i <= 12; i++) canvas.props.onPointerMove({ clientX: at.x + i * 0.3, clientY: at.y + i * 0.2, pointerId: 61 });
      tree = await renderTree(() => MapModule({ api }));
      const intraFrames = drawFrames.length - intraBefore;
      const crossBefore = drawFrames.length;
      for (let i = 1; i <= 4; i++) {
        const step = clientOf(7, 7 + i * 2, grid.tileWidth);
        canvas.props.onPointerMove({ clientX: step.x, clientY: step.y, pointerId: 61 });
        tree = await renderTree(() => MapModule({ api }));
      }
      const crossFrames = drawFrames.length - crossBefore;
      check(
        "同一格内挪 12 次几乎不重画，跨格 4 次必须重画（悬停去重还在）",
        intraFrames <= 1 && crossFrames >= 3,
        `同格 ${intraFrames} 帧 / 跨格 ${crossFrames} 帧`
      );
    }
    // ④ 图内一笔从 (2,2) 快速拖到 (2,9)：中间不能漏格（补间还得管用）
    const fast = await dragCells([2, 2], [2, 9]);
    const wantCols = [2, 3, 4, 5, 6, 7, 8, 9];
    check(
      "图内一笔快速拖动补满中间格（不漏格）",
      wantCols.every((c) => fast.has(`2,${c}`)) && fast.size <= wantCols.length + 1,
      `落笔：${[...fast].join(" ")}`
    );
  }
  // ══ 18) 自由尺寸 / 用法说明 / 通过按钮文案 ═══════════════════════════════
  section("18) 地图尺寸与素材格子都可自由填；用法四项悬停有解释；通过按钮叫「确定」");
  {
    tree = await freshPanel();
    // 上一段建过自己的项目（没有素材），切回主夹具再测尺寸与素材设置
    const mainName18 = (await G.readMapProject(projectId)).name;
    if (byClass(tree, "SPR_mapEdMenuItem").length === 0) {
      byClass(tree, "SPR_mapEdProj")[0].props.onClick();
      tree = await renderTree(() => MapModule({ api }));
    }
    byClass(tree, "SPR_mapEdMenuItem").find((node) => textOf(node) === mainName18).props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    /**
     * ⚠️ `NumField` 自带 hook，harness 的 `collect` **不能**展开它（会多吃 hook 槽位），
     * 所以这里按它的 props 找那个元素，直接调它的 `onChange`（= 失焦提交后的回调）。
     */
    const numFieldIn = (card, label) =>
      collect(card, (node) => node.props !== undefined && typeof node.props.onChange === "function" && node.props.label === label)[0];
    const capCard = (index) => byClass(tree, "SPR_mapEdCard")[index];

    // ── 地图大小：宽 / 高 各填各的（不再是固定正方形）
    byTool(tree, "settings")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const settingsCard = capCard(byClass(tree, "SPR_mapEdCard").length - 1);
    const mapWidth = numFieldIn(settingsCard, "宽");
    const mapHeight = numFieldIn(settingsCard, "高");
    check(
      "设置卡里「地图大小」是两个数字框（宽 / 高 各填各的，不再是正方形下拉）",
      mapWidth !== undefined && mapHeight !== undefined,
      JSON.stringify(collect(settingsCard, (node) => typeof node.props?.label === "string").map((node) => node.props.label))
    );
    windowStub.__confirmCalls.length = 0;
    mapWidth.props.onChange(48);
    tree = await renderTree(() => MapModule({ api }));
    numFieldIn(capCard(byClass(tree, "SPR_mapEdCard").length - 1), "高").props.onChange(20);
    tree = await renderTree(() => MapModule({ api }));
    const doc = await G.readTheDoc(projectId);
    check("改成 48×20 真的生效（宽高各自独立）", doc.cols === 48 && doc.rows === 20, `${doc.cols}×${doc.rows}`);
    check("改小会先问一句（确认后照做）", windowStub.__confirmCalls.length > 0, windowStub.__confirmCalls.join(" / "));

    // ── 素材：列表 + 新增（属性在对话框里一次定死）+ 删除 / 恢复默认
    byTool(tree, "settings")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    byClass(tree, "SPR_mapEdTopBtn")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const assets = byClass(tree, "SPR_mapEdCard")[0];
    const rowCount = () => byClass(byClass(tree, "SPR_mapEdCard")[0], "SPR_mapEdTsRow").length;
    const beforeRows = rowCount();
    check("素材列表列出了项目里的素材", beforeRows > 0, `${beforeRows} 张`);
    // 新增素材：先弹对话框，里面才有「图片 / 名字 / 格子 / 用法 / 会动吗」
    collect(assets, (node) => node.type === "button" && textOf(node) === "新增素材")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const addDlg = collect(tree, (node) => node.props?.["data-testid"] === "map-add-dialog")[0];
    check("点「新增素材」弹出对话框", addDlg !== undefined, textOf(byClass(tree, "SPR_mapEdCard")[0]).slice(0, 40));
    check(
      "对话框里有：素材图 / 叫什么 / 格子大小 / 这块素材怎么用 / 会动吗",
      ["素材图", "叫什么", "格子大小（留空就自动认）", "这块素材怎么用", "会动吗"].every((label) => textOf(addDlg).includes(label)),
      textOf(addDlg).replace(/\s+/g, " ").slice(0, 120)
    );
    check("对话框里格子大小是两个数字框（宽 / 高，留空走自动识别）", numFieldIn(addDlg, "宽") !== undefined && numFieldIn(addDlg, "高") !== undefined);
    check("对话框里「用法」是四个按钮、「会动吗」是两个按钮", collect(addDlg, (node) => typeof node.props?.["data-shape"] === "string").length === 4 && collect(addDlg, (node) => typeof node.props?.["data-anim"] === "string").length === 2);
    // 悬停解释还在（和工具格同一套小标签）
    collect(addDlg, (node) => node.props?.["data-shape"] === "corner16")[0].props.onMouseEnter({
      currentTarget: { getBoundingClientRect: () => ({ left: 120, top: 320, width: 50, height: 24 }) }
    });
    tree = await renderTree(() => MapModule({ api }));
    check("悬停「整格」解释它是什么", textOf(byClass(tree, "SPR_mapEdTip")[0] ?? null).includes("拐角"), textOf(byClass(tree, "SPR_mapEdTip")[0] ?? null));
    // 没选图就点确定：要说清楚，别静默
    collect(tree, (node) => node.props?.["data-testid"] === "map-add-ok")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check("没选图片就点「确定」会明确提示（不是静默失败）", textOf(tree).includes("先选一张素材图"), textOf(tree).match(/先选一张素材图[^\s]*/)?.[0] ?? "");
    // 草稿是可编辑的：点「翻页图」后按钮状态跟着变
    collect(tree, (node) => node.props?.["data-anim"] === "rows")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check("对话框里的选择只改草稿（「翻页图」被选中）", collect(tree, (node) => node.props?.["data-anim"] === "rows")[0].props["data-on"] === "true");
    collect(tree, (node) => node.props?.["data-testid"] === "map-add-cancel")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check("「取消」关掉对话框、什么都不改", collect(tree, (node) => node.props?.["data-testid"] === "map-add-dialog").length === 0 && rowCount() === beforeRows, `${rowCount()} 张`);
    // 删除内置素材 → 列表少一张；恢复默认 → 回来了
    const builtinRow = byClass(tree, "SPR_mapEdTsRow").find((node) => textOf(node).includes("自带"));
    const builtinName = textOf(byClass(builtinRow, "SPR_mapEdTsName")[0]);
    collect(builtinRow, (node) => node.type === "button" && textOf(node) === "删除")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check(`内置素材也能删（删掉了「${builtinName}」）`, rowCount() === beforeRows - 1 && !textOf(byClass(tree, "SPR_mapEdCard")[0]).includes(builtinName), `${beforeRows} → ${rowCount()}`);
    collect(byClass(tree, "SPR_mapEdCard")[0], (node) => node.type === "button" && textOf(node) === "恢复默认素材")[0].props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    check("「恢复默认素材」把它拿回来（同名不会变成两份）", rowCount() === beforeRows && textOf(byClass(tree, "SPR_mapEdCard")[0]).includes(builtinName), `${rowCount()} 张`);

    // ── 通过按钮：普通按钮「确定」，按下即标记 + **收起卡片**，没有「取消确认」这一说
    const cardBeforeConfirm = byClass(tree, "SPR_mapEdCard")[0];
    const confirmBtn = collect(cardBeforeConfirm, (node) => node.type === "button" && textOf(node) === "确定")[0];
    check(
      "素材卡的通过按钮叫「确定」（不再是「这步看过了」）",
      confirmBtn !== undefined && confirmBtn.props["data-on"] === undefined && confirmBtn.props["data-approved"] === undefined,
      collect(cardBeforeConfirm, (node) => node.type === "button").map((node) => textOf(node)).join(" / ")
    );
    check(
      "它不是勾选式、也没有「取消确认」（用户：素材根本没有取消确认这一说）",
      !/✓|已确定|取消确定/.test(textOf(cardBeforeConfirm)),
      textOf(cardBeforeConfirm).match(/[^\s]*(?:已确定|取消确定|✓)[^\s]*/)?.[0] ?? "（没有这类文案）"
    );
    confirmBtn.props.onClick();
    tree = await renderTree(() => MapModule({ api }));
    const stages = (await G.readMapProject(projectId)).stages;
    check("点「确定」标记素材阶段已通过", stages?.assets?.status === "done", JSON.stringify(stages));
    check("点「确定」之后卡片收起来（回到画布，不是留着一个已确定的按钮）", byClass(tree, "SPR_mapEdCard").length === 0, `还剩 ${byClass(tree, "SPR_mapEdCard").length} 张卡片`);
  }

} finally {
  if (projectId !== "") await G.deleteMapProject(projectId).catch(() => undefined);
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${failures.length === 0 ? "全部通过" : "有失败"}：${passed} 项通过${failures.length > 0 ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}

