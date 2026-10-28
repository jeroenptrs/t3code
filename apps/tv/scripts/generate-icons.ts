// Renders the Apple TV brand assets in apps/tv/assets from the nightly Icon Composer project:
// layered app icons (background, clouds, T3 mark) for the focus parallax, and flat top shelf
// images. Run `vp run --filter @t3tools/tv icons:generate` after changing the source artwork.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "../../../scripts/lib/brand-assets.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const layersDir = NodePath.join(repoRoot, BRAND_ASSET_PATHS.nightlyIconComposerProject, "Assets");
const outDir = NodePath.resolve(import.meta.dirname, "../assets");
// The nightly background colour, as in PREVIEW_ASSETS in apps/mobile/app.config.ts.
const BACKGROUND = "#111533";

const ICON_SIZES = [
  [1280, 768],
  [400, 240],
  [800, 480],
] as const;
const TOP_SHELF_SIZES = [
  [1920, 720],
  [3840, 1440],
  [2320, 720],
  [4640, 1440],
] as const;

const svg = (name: string) => NodeFSP.readFile(NodePath.join(layersDir, name));

/** Rasterizes an SVG at `width` px wide, at a density that keeps its edges sharp. */
async function raster(source: Buffer, intrinsicWidth: number, width: number) {
  const density = Math.ceil((72 * width) / intrinsicWidth);
  return sharp(source, { density }).resize({ width }).png().toBuffer();
}

function canvas(width: number, height: number, background: string | null) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
}

async function backLayer(width: number, height: number) {
  const side = Math.max(width, height);
  const gradient = await sharp(await raster(await svg("background.svg"), 128, side))
    .resize(width, height, { fit: "cover" })
    .toBuffer();
  return canvas(width, height, BACKGROUND)
    .composite([{ input: gradient }])
    .png()
    .toBuffer();
}

async function cloudLayer(width: number, height: number) {
  const lower = await raster(await svg("cloud-lower-left.svg"), 64, Math.round(width * 0.6));
  const upper = await raster(await svg("cloud-upper-right.svg"), 64, Math.round(width * 0.42));
  const lowerHeight = (await sharp(lower).metadata()).height;
  return canvas(width, height, null)
    .composite([
      { input: upper, left: Math.round(width * 0.62), top: Math.round(height * 0.02) },
      {
        input: lower,
        left: Math.round(-width * 0.08),
        top: Math.round(height - lowerHeight * 0.75),
      },
    ])
    .png()
    .toBuffer();
}

/** The T3 glyphs fill about 45% of the text layer's square, so `side` sets the mark's size. */
async function markLayer(width: number, height: number, side: number) {
  const mark = await raster(await svg("text.svg"), 128, side);
  return canvas(width, height, null)
    .composite([
      {
        input: mark,
        left: Math.round((width - side) / 2),
        top: Math.round((height - side) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function write(buffer: Buffer, name: string) {
  await sharp(buffer).toFile(NodePath.join(outDir, name));
  console.log(`wrote assets/${name}`);
}

await NodeFSP.mkdir(outDir, { recursive: true });

for (const [width, height] of ICON_SIZES) {
  const size = `${width}x${height}`;
  await write(await backLayer(width, height), `icon-back-${size}.png`);
  await write(await cloudLayer(width, height), `icon-middle-${size}.png`);
  await write(await markLayer(width, height, height), `icon-front-${size}.png`);
}

for (const [width, height] of TOP_SHELF_SIZES) {
  const layers = await Promise.all([
    cloudLayer(width, height),
    markLayer(width, height, Math.round(height * 0.9)),
  ]);
  const flat = await sharp(await backLayer(width, height))
    .composite(layers.map((input) => ({ input })))
    .png()
    .toBuffer();
  // Top shelf images must be opaque.
  await write(
    await sharp(flat).flatten({ background: BACKGROUND }).toBuffer(),
    `top-shelf-${width}x${height}.png`,
  );
}
