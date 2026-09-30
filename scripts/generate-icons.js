const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const body = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

function generatePng(size) {
  const width = size;
  const height = size;

  // Raw image data with filter byte (0) per row
  const rowLength = 1 + width * 4;
  const rawData = Buffer.alloc(rowLength * height);

  // Background and icon colors:
  // Primary GCP Blue: #1a73e8 (rgba: 26, 115, 232, 255)
  // Accent Yellow / White: #ffffff
  const primaryR = 26, primaryG = 115, primaryB = 232;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLength;
    rawData[rowOffset] = 0; // Filter None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      // Rounded rectangle badge
      const radius = size * 0.22;
      const dx = Math.max(0, Math.abs(x - (width - 1) / 2) - ((width - 1) / 2 - radius));
      const dy = Math.max(0, Math.abs(y - (height - 1) / 2) - ((height - 1) / 2 - radius));
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // Inside rounded badge
        // Draw key / diff shape in white/accent
        const nx = x / size;
        const ny = y / size;

        // Key head (circle) on left, shaft with teeth on right
        const keyCircleDx = nx - 0.35;
        const keyCircleDy = ny - 0.5;
        const keyDist = Math.sqrt(keyCircleDx * keyCircleDx + keyCircleDy * keyCircleDy);

        const isKeyCircle = keyDist <= 0.18 && keyDist >= 0.08;
        const isKeyShaft = nx >= 0.35 && nx <= 0.72 && Math.abs(ny - 0.5) <= 0.045;
        const isKeyTooth1 = nx >= 0.55 && nx <= 0.62 && ny >= 0.5 && ny <= 0.65;
        const isKeyTooth2 = nx >= 0.66 && nx <= 0.73 && ny >= 0.5 && ny <= 0.62;

        if (isKeyCircle || isKeyShaft || isKeyTooth1 || isKeyTooth2) {
          // White key
          rawData[pxOffset] = 255;
          rawData[pxOffset + 1] = 255;
          rawData[pxOffset + 2] = 255;
          rawData[pxOffset + 3] = 255;
        } else {
          // Background blue
          rawData[pxOffset] = primaryR;
          rawData[pxOffset + 1] = primaryG;
          rawData[pxOffset + 2] = primaryB;
          rawData[pxOffset + 3] = 255;
        }
      } else {
        // Transparent outside
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
      }
    }
  }

  // PNG Header
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = 6; // Color type: RGBA (6)
  ihdrData[10] = 0; // Compression: 0
  ihdrData[11] = 0; // Filter: 0
  ihdrData[12] = 0; // Interlace: 0
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT (Deflate rawData)
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 32, 48, 128].forEach(size => {
  const png = generatePng(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${png.length} bytes)`);
});
