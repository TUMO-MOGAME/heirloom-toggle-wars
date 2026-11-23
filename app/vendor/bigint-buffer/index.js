"use strict";
/**
 * The four functions of bigint-buffer, in plain JavaScript (see package.json for why). Its only consumer here is
 * @solana/buffer-layout-utils (under @solana/spl-token). A value that does not fit its width is refused: the original
 * silently wrote other digits, which for a token amount means another amount.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS package, required by a CommonJS consumer
const { Buffer } = require("buffer");

function read(bytes) {
  let value = BigInt(0);
  for (const b of bytes) value = (value << BigInt(8)) | BigInt(b);
  return value;
}

function write(value, width) {
  if (typeof value !== "bigint") throw new TypeError("Expected a bigint");
  if (!Number.isSafeInteger(width) || width < 0) throw new RangeError("Width must be a whole number of bytes");
  const out = Buffer.alloc(width);
  let left = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(left & BigInt(255));
    left >>= BigInt(8);
  }
  // A negative number leaves -1 here, a too-large one leaves the digits that did not fit.
  if (left !== BigInt(0)) throw new RangeError(`The value does not fit in ${width} unsigned bytes`);
  return out;
}

exports.toBigIntLE = function toBigIntLE(bytes) {
  return read(Uint8Array.from(bytes).reverse());
};
exports.toBigIntBE = function toBigIntBE(bytes) {
  return read(bytes);
};
exports.toBufferLE = function toBufferLE(value, width) {
  return write(value, width).reverse();
};
exports.toBufferBE = function toBufferBE(value, width) {
  return write(value, width);
};
