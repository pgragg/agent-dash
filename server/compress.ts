import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** The dashboard is about 1.7 MB of JSON and compresses to a sixth. Quality 5 takes about 10 ms for it; the default, 11, is many times slower. */
export async function compress(body: string, accept: string): Promise<{ encoding: "br" | "gzip" | null; data: Buffer | string }> {
  if (/\bbr\b/.test(accept)) return { encoding: "br", data: await brotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) };
  if (/\bgzip\b/.test(accept)) return { encoding: "gzip", data: await gzipAsync(body) };
  return { encoding: null, data: body };
}
