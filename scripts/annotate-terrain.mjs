import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { TERRAIN_CONTEXT_RADIUS_M, TERRAIN_RADIUS_M, classifyLandform, terrainRing } from '@stations/contracts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cataloguePath = resolve(root, 'data/catalogue/stations.json');
const outPath = resolve(root, 'data/terrain/landforms.json');
const tileRoot = resolve(root, '.cache/terrarium');
const zoom = 9;
const concurrency = 6;

const pointKey = (latitude, longitude) => `${latitude.toFixed(4)},${longitude.toFixed(4)}`;

function tileIndex(latitude, longitude) {
  const n = 2 ** zoom;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const latRad = (Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

function decodePng(bytes) {
  const png = Buffer.from(bytes);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels || width === 0) throw new Error('unsupported terrain tile');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? pixels[row + i - channels] : 0;
      const up = y > 0 ? pixels[row - stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[row - stride + i - channels] : 0;
      let value = raw[src];
      src += 1;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[row + i] = value & 255;
    }
  }
  return { width, channels, pixels };
}

function sampleElevation(tile, latitude, longitude) {
  const n = 2 ** zoom;
  const xFloat = ((longitude + 180) / 360) * n;
  const latRad = (latitude * Math.PI) / 180;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const px = Math.min(255, Math.max(0, Math.floor((xFloat - Math.floor(xFloat)) * 256)));
  const py = Math.min(255, Math.max(0, Math.floor((yFloat - Math.floor(yFloat)) * 256)));
  const index = (py * tile.width + px) * tile.channels;
  const red = tile.pixels[index];
  const green = tile.pixels[index + 1];
  const blue = tile.pixels[index + 2];
  return red * 256 + green + blue / 256 - 32768;
}

async function readTile(x, y) {
  const path = resolve(tileRoot, String(zoom), String(x), `${y}.png`);
  if (!existsSync(path)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;
    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      response = await fetch(url);
      if (response.ok || response.status === 404) break;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (!response?.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  return decodePng(readFileSync(path));
}

const stations = JSON.parse(readFileSync(cataloguePath, 'utf8')).stations;
const groups = new Map();

function place(latitude, longitude) {
  const { x, y } = tileIndex(latitude, longitude);
  const id = `${x}/${y}`;
  let group = groups.get(id);
  if (!group) {
    group = { x, y, points: [] };
    groups.set(id, group);
  }
  const key = pointKey(latitude, longitude);
  group.points.push({ key, latitude, longitude });
  return key;
}

function ringKeys(latitude, longitude, radiusM) {
  return terrainRing(latitude, longitude, radiusM).map(point => place(point.latitude, point.longitude));
}

const rings = new Map();
for (const station of stations) {
  rings.set(station.uid, {
    near: ringKeys(station.latitude, station.longitude, TERRAIN_RADIUS_M),
    far: ringKeys(station.latitude, station.longitude, TERRAIN_CONTEXT_RADIUS_M),
  });
}
const woodstock = {
  near: ringKeys(38.8706, -78.45, TERRAIN_RADIUS_M),
  far: ringKeys(38.8706, -78.45, TERRAIN_CONTEXT_RADIUS_M),
};
const hatis = stations.find(station => station.uid === 'wunderground:IHATIS1');
const elevations = new Map();
const tiles = [...groups.values()];
console.log(`terrain tiles ${tiles.length}`);

let cursor = 0;
async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= tiles.length) return;
    const group = tiles[index];
    const tile = await readTile(group.x, group.y);
    if (!tile) continue;
    for (const point of group.points) {
      elevations.set(point.key, sampleElevation(tile, point.latitude, point.longitude));
    }
    if (index % 200 === 0) console.log(`tiles ${index}/${tiles.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

const classified = {};
const counts = {};
function classifyKeys(near, far) {
  const nearValues = near.map(key => elevations.get(key));
  const farValues = far.map(key => elevations.get(key));
  if ([...nearValues, ...farValues].some(value => !Number.isFinite(value))) return null;
  return classifyLandform(nearValues[0], nearValues.slice(1), farValues.slice(1));
}

for (const station of stations) {
  const ring = rings.get(station.uid);
  const sample = classifyKeys(ring.near, ring.far);
  if (!sample) continue;
  classified[station.uid] = sample;
  counts[sample.landform] = (counts[sample.landform] ?? 0) + 1;
}
const woodstockSample = classifyKeys(woodstock.near, woodstock.far);
const hatisSample = hatis ? classifyKeys(rings.get(hatis.uid).near, rings.get(hatis.uid).far) : null;

mkdirSync(dirname(outPath), { recursive: true });
const temporary = `${outPath}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify({
  schemaVersion: 1,
  radiusM: TERRAIN_RADIUS_M,
  contextRadiusM: TERRAIN_CONTEXT_RADIUS_M,
  source: 'terrarium-z9',
  stations: classified,
})}\n`);
renameSync(temporary, outPath);
console.log('landforms', counts, 'stations', Object.keys(classified).length);
console.log('Woodstock Ediths Gap', woodstockSample);
console.log('Hatis', hatisSample);
