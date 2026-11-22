// Screenshots and other user images, checked by their real headers before they're stored or handed to agents:
// the type, sane dimensions and no payload after the image beyond a small slack.
export const imageLimits = { side: 8192, pixels: 40_000_000, slack: 64 }
export type ImageInfo = { mime: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number }
export const imageExtensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const le32 = (b: Uint8Array, i: number) => (le24(b, i) | (b[i + 3]! << 24)) >>> 0
const tag = (b: Uint8Array, i: number) => String.fromCharCode(...b.subarray(i, i + 4))
type Result = ImageInfo | "invalid" | "too_large"
function sized(mime: ImageInfo["mime"], width: number, height: number): Result {
  if (!(width > 0 && height > 0)) return "invalid"
  if (width > imageLimits.side || height > imageLimits.side || width * height > imageLimits.pixels) return "too_large"
  return { mime, width, height }
}
// IHDR first (13 bytes, valid depth and colour type), at least one IDAT, and IEND at the end.
function png(b: Uint8Array): Result {
  let i = 8,
    width = 0,
    height = 0,
    data = false
  while (i + 12 <= b.length) {
    const length = be32(b, i),
      type = tag(b, i + 4)
    if (!/^[A-Za-z]{4}$/.test(type) || length > b.length - i - 12) return "invalid"
    if (i === 8) {
      if (type !== "IHDR" || length !== 13) return "invalid"
      width = be32(b, 16)
      height = be32(b, 20)
      const depth = b[24]!,
        colour = b[25]!
      if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(colour)) return "invalid"
    } else if (type === "IHDR") return "invalid"
    if (type === "IDAT") data = true
    i += 12 + length
    if (type === "IEND") return data && b.length - i <= imageLimits.slack ? sized("image/png", width, height) : "invalid"
  }
  return "invalid"
}
// Segments up to a baseline, extended or progressive frame header, then scan data ending at EOI.
function jpeg(b: Uint8Array): Result {
  let i = 2,
    width = 0,
    height = 0
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return "invalid"
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xd8 || marker === 0xd9) return "invalid"
    const length = be16(b, i + 2)
    if (length < 2 || i + 2 + length > b.length) return "invalid"
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return "invalid"
      height = be16(b, i + 5)
      width = be16(b, i + 7)
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return "invalid"
    if (marker === 0xda) {
      if (!width) return "invalid"
      const tail = Math.max(i + 2 + length, b.length - imageLimits.slack - 2)
      for (let j = b.length - 2; j >= tail; j--) if (b[j] === 0xff && b[j + 1] === 0xd9) return sized("image/jpeg", width, height)
      return "invalid"
    }
    i += 2 + length
  }
  return "invalid"
}
// RIFF covering the file, then a lossy (VP8), lossless (VP8L) or extended (VP8X) header.
function webp(b: Uint8Array): Result {
  if (b.length < 30) return "invalid"
  const riff = le32(b, 4) + 8
  if (riff > b.length || b.length - riff > imageLimits.slack) return "invalid"
  const kind = tag(b, 12),
    chunk = le32(b, 16)
  if (20 + chunk > riff) return "invalid"
  if (kind === "VP8 ") {
    if (chunk < 10 || (b[20]! & 1) !== 0 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return "invalid"
    return sized("image/webp", le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)
  }
  if (kind === "VP8L") {
    if (chunk < 5 || b[20] !== 0x2f) return "invalid"
    const bits = le32(b, 21)
    return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (kind === "VP8X") {
    if (chunk < 10) return "invalid"
    return sized("image/webp", le24(b, 24) + 1, le24(b, 27) + 1)
  }
  return "invalid"
}
export function inspectImage(bytes: Uint8Array): Result {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return png(bytes)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes)
  if (bytes.length >= 16 && tag(bytes, 0) === "RIFF" && tag(bytes, 8) === "WEBP") return webp(bytes)
  return "invalid"
}
