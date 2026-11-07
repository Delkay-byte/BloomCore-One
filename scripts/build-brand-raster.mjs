/**
 * Raster brand assets from the SVG sources in public/branding.
 *
 * The SVGs are the production artwork. Rasters are generated from them so the
 * PWA installer, iOS home screen and social scrapers all show the same mark.
 *
 * Run from the repository root:
 *   node scripts/build-brand-raster.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
const BRANDING = path.join(ROOT, "public", "branding");
const APP = path.join(ROOT, "src", "app");

async function svg(name) {
  return readFile(path.join(BRANDING, name), "utf8");
}

/** Solid forest tile with the mark centred, safe area for maskable use. */
function maskableSource(markSvg, size, safeRatio = 0.72) {
  const inner = Math.round(size * safeRatio);
  const offset = Math.round((size - inner) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0E4D34"/>
  <g transform="translate(${offset} ${offset}) scale(${inner / 48})">
    ${markSvg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
  </g>
</svg>`;
}

async function main() {
  const mark = await svg("maacash-mark.svg");
  const icon = await svg("maacash-icon.svg");
  const og = await svg("maacash-og.svg");

  const outputs = [];

  // Application icons.
  for (const size of [192, 512]) {
    const file = path.join(BRANDING, `maacash-icon-${size}.png`);
    await sharp(Buffer.from(icon)).resize(size, size).png().toFile(file);
    outputs.push(path.relative(ROOT, file));
  }

  // Maskable icon: mark on a full-bleed forest tile, inside the safe area.
  {
    const file = path.join(BRANDING, "maacash-icon-maskable-512.png");
    const source = maskableSource(mark, 512);
    await sharp(Buffer.from(source)).png().toFile(file);
    outputs.push(path.relative(ROOT, file));
  }

  // Small favicon sizes.
  for (const size of [16, 32, 48]) {
    const file = path.join(BRANDING, `maacash-favicon-${size}.png`);
    await sharp(Buffer.from(mark)).resize(size, size).png().toFile(file);
    outputs.push(path.relative(ROOT, file));
  }

  // Apple touch icon.
  {
    const file = path.join(APP, "apple-icon.png");
    await sharp(Buffer.from(icon)).resize(180, 180).png().toFile(file);
    outputs.push(path.relative(ROOT, file));
  }

  // Favicon (multi-resolution .ico). sharp cannot write .ico, so the PNGs are
  // written and the .ico is assembled from their PNG payloads.
  {
    const sizes = [16, 32, 48];
    const pngs = [];
    for (const size of sizes) {
      pngs.push(
        await sharp(Buffer.from(mark)).resize(size, size).png().toBuffer()
      );
    }
    const ico = buildIco(pngs, sizes);
    const file = path.join(APP, "favicon.ico");
    await writeFile(file, ico);
    outputs.push(path.relative(ROOT, file));
  }

  // Social sharing image.
  {
    const file = path.join(BRANDING, "maacash-og.png");
    await sharp(Buffer.from(og)).resize(1200, 630).png().toFile(file);
    outputs.push(path.relative(ROOT, file));
  }

  console.log(outputs.join("\n"));
}

/** Assemble a Windows .ico from PNG payloads (Vista+ PNG-in-ICO format). */
function buildIco(pngBuffers, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const entries = [];
  let offset = 6 + sizes.length * 16;
  for (let i = 0; i < sizes.length; i += 1) {
    const size = sizes[i];
    const data = pngBuffers[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...pngBuffers]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
