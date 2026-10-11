/**
 * 地图编辑器（模块六）的**自动连接**（autotile）内核：纯函数。
 *
 * 只剩两套：
 *   · `corner16`  四邻域整格连接（N/E/S/W），4 位掩码 → 16 张
 *   · `a2quad`    A2 拼块：一格的四个象限各自挑形状号，照 AsLib `map20n_Number`
 *
 * 旧的 `blob47` / 族优先级 / `edgeMode` 全部删除：新模块里「同一类」由调用方
 * 一句话回答（`NeighborAt`），宿主选块时只看「这一格是不是同一张图集」，
 * 于是「优先级」这种约定俗成的隐式规则不再有存在的地方。
 *
 * ## 谁负责 wrap
 *
 * `NeighborAt` 的坐标可能越界（`r = -1`、`c = cols`）。**取模由调用方做** ——
 * 这里对每个方向都发一次问，问的是「那一格是不是同一类」，`at` 自己决定越界怎么答。
 * 在宿主里就是 `wrapCell(...)` 之后查图层数据；忘了 wrap 的表现是「接缝处形状不对」，
 * 只在贴边时才看得出来。
 *
 * ## A2 为什么是「四个象限各一个形状号」
 *
 * AsLib 的 `drawMapBranch`（type_20n）对一格发 4 次 `drawChip`：TL / TR / BL / BR，
 * 每个象限只看它**自己那一边的横竖邻居 + 那个角**：
 *   TL 用 left / up / upLeft，TR 用 right / up / upRight，
 *   BL 用 left / down / downLeft，BR 用 right / down / downRight。
 * 所以「格子该长什么样」不是一个 0..4 的数，而是四个 0..4 的数 —— 这就是
 * `a2QuadrantShapes` 返回元组的原因。
 */
/** 四邻域位值（与 `corner16` 的掩码一致）：N=1, E=2, S=4, W=8。 */
export const NB4_N = 1;
export const NB4_E = 2;
export const NB4_S = 4;
export const NB4_W = 8;
/**
 * 整格自动连接（16 掩码）：四邻域位序 N=1,E=2,S=4,W=8，返回 0..15。
 *
 * 位序是**契约**（掩码是导入时一次性算好、写进图块元数据的语义值），
 * 顺手改成别的顺序只会让所有已存的图块错位，不会报错。
 */
export function corner16Mask(at, r, c) {
    let mask = 0;
    if (at(r - 1, c))
        mask |= NB4_N;
    if (at(r, c + 1))
        mask |= NB4_E;
    if (at(r + 1, c))
        mask |= NB4_S;
    if (at(r, c - 1))
        mask |= NB4_W;
    return mask;
}
/** `corner16` 的全集（掩码值就是下标，0..15）。 */
export const CORNER16_MASKS = Array.from({ length: 16 }, (_unused, index) => index);
/** A2 的形状数：0..4（块行号）。 */
export const A2_SHAPES = 5;
/**
 * A2 形状号，照 AsLib `map20n_Number(left, up, diag)`：
 *
 * | left | up | diag | 形状 |
 * |---|---|---|---|
 * | 否 | 否 | * | 0 |
 * | 否 | 是 | * | 1 |
 * | 是 | 否 | * | 2 |
 * | 是 | 是 | 否 | 3 |
 * | 是 | 是 | 是 | 4 |
 *
 * `diag` 只在两条边都接上时才有意义（否则那个角在网格上根本不相邻）——
 * 写成「两边接上就点亮角」的话形状 3 会永远消失，`A2_SHAPES` 也就退化成 4 种。
 */
export function a2Shape(left, up, diag) {
    if (left) {
        if (up)
            return diag ? 4 : 3;
        return 2;
    }
    if (up)
        return 1;
    return 0;
}
/** 一格四个象限各自的形状号（TL, TR, BL, BR），元组顺序与 `A2_QUADRANT_ORDER` 一致。 */
export function a2QuadrantShapes(at, r, c) {
    const left = at(r, c - 1);
    const right = at(r, c + 1);
    const up = at(r - 1, c);
    const down = at(r + 1, c);
    return [
        a2Shape(left, up, at(r - 1, c - 1)), // TL
        a2Shape(right, up, at(r - 1, c + 1)), // TR
        a2Shape(left, down, at(r + 1, c - 1)), // BL
        a2Shape(right, down, at(r + 1, c + 1)) // BR
    ];
}
/** 象限名的顺序（画验收图 / 调试用），与 `a2QuadrantShapes` 的元组一一对应。 */
export const A2_QUADRANT_ORDER = ["TL", "TR", "BL", "BR"];
/** 掩码的位数（算 Hamming 距离用）。 */
function popcount(value) {
    let count = 0;
    let rest = value >>> 0;
    while (rest !== 0) {
        rest &= rest - 1;
        count++;
    }
    return count;
}
export function hammingDistance(a, b) {
    return popcount((a ^ b) >>> 0);
}
/**
 * 缺掩码回退：Hamming 最近的已配置掩码，**并列取掩码值最小的**；一个都没配
 * 返回 `undefined`（调用方再退「图集的第一块」）。
 *
 * 为什么必须回退而不是留空：留空在屏幕上就是一个透明洞，而且不报任何错
 * （旧模块的「白色洞」就是这么来的）。并列取最小是为了确定性 —— 同样的地图
 * 每次算出来必须是同一块，否则「导出和预览不一样」这类问题永远查不清。
 */
export function nearestMask(mask, configured) {
    let best;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of configured) {
        const distance = hammingDistance(mask, candidate);
        if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate < best)) {
            bestDistance = distance;
            best = candidate;
        }
    }
    return best;
}
