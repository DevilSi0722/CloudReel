import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Resvg} from '@resvg/resvg-js';

// The framed SVG supplies Windows icons; cloudreel-mark.svg is the transparent
// in-app symbol, sharing the same C/ribbon geometry.
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/brand');
const source = fs.readFileSync(path.join(directory, 'cloudreel.svg'), 'utf8');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map(size => ({size, bytes: new Resvg(source, {fitTo: {mode: 'width', value: size}}).render().asPng()}));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [i, image] of images.entries()) {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = image.size === 256 ? 0 : image.size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += image.bytes.length;
}
fs.writeFileSync(path.join(directory, 'app.ico'), Buffer.concat([header, ...images.map(image => image.bytes)]));
for (const image of images.filter(image => [32, 256].includes(image.size))) fs.writeFileSync(path.join(directory, `app-${image.size}.png`), image.bytes);
fs.writeFileSync(path.join(directory, 'app-512.png'), new Resvg(source).render().asPng());
console.log(`CloudReel icons generated from SVG (${sizes.join(', ')} px).`);
