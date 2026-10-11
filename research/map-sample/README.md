# 内置地图素材 · 生成产物

这个目录里的 PNG **不是手画的，也不是下载的**，而是由

```bash
node scripts/make-map-sample-tileset.mjs --check   # 只检查，不写文件
node scripts/make-map-sample-tileset.mjs --local   # 写到这里（默认输出目录）
node scripts/make-map-sample-tileset.mjs --ark --yes   # ★真实计费：改用火山引擎生成纹理
```

从 `src/mapsamplegen.ts` 生成出来的。**运行时并不读这些文件**：插件里
`mapgen.importSampleTileset` 直接调 `renderSampleTilesets()` 在内存里渲染、写进项目的
`tilesets/` 目录，所以这里只是「给人眼看一眼内置素材长什么样」的留档。

产物（全部确定性、同一输入两次生成逐字节一致）：

| 文件 | 尺寸 | 形态 | 说明 |
|---|---|---|---|
| `sample-grass.png` | 64×160 | A2 拼块 | 2 变体 × 5 形状 × 32px（水才有明显动感，草是两种花纹） |
| `sample-dirt.png` | 64×160 | A2 拼块 | 同上 |
| `sample-water.png` | 64×160 | A2 拼块 | 两个变体是错开的波纹，画到地图上就是循环动画 |
| `sample-stone.png` | 64×160 | A2 拼块 | 没有「邻接地貌」，过渡带用同色系阴影 |
| `sample-props.png` | 256×160 | 普通网格 | 8 列 × 5 行 32px 道具（树 / 花 / 石头 / 木箱 / 栅栏 / 蘑菇 / 断枝 / 石头堆） |

⚠️ **为什么不用 AsLib 自带的素材**：AsLib 仓库里的 `Picture/MapChip/*_pipo.png`
是第三方版权素材（它的 README 写明 "Third party content is copyrighted by its
respective owners"），只授权了代码 CC0，所以那批图**不能打包进本插件**。
内置素材是我们自己按同样的 A2 规格程序化画出来的，观感比不上商业素材，
但可以直接画、可以直接商用替换 —— 用户随时可以导入自己的图覆盖它。

`--ark` 那条路会用火山引擎 Seedream 生成 4 张无缝纹理，再**本地合成**成同样规格的
A2 图（形状/过渡带/变体仍是本地算的，AI 只负责纹理本身），生成结果写进
`src/mapsample.ts` 的 `SAMPLE_TEXTURE_OVERRIDE`。**这一步真实计费**，必须显式带 `--yes`。
