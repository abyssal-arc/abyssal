/**
 * Response compression for the node dev adapter.
 *
 * It lives outside `handler.ts` on purpose: the handler is Fetch-API shaped so
 * it can be dropped onto Cloudflare Workers, where the edge compresses for us.
 * Only the local node server needs to do it itself.
 *
 * Brotli quality 6 measured 0.5–3ms on real payloads (snapshot 30 KB → 5.7 KB,
 * /history 456 KB → 26 KB, 78–94% off). Quality 11 buys ~10% more but costs
 * 573ms on /history, which would stall the 250ms sim tick. Both codecs run
 * through promisify so the work lands on the libuv threadpool rather than
 * blocking the event loop the simulation shares.
 */
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/** Below this, the header overhead and the CPU are not worth the bytes saved. */
export const COMPRESS_MIN_BYTES = Number(process.env.COMPRESS_MIN_BYTES ?? 1024);
export const BROTLI_QUALITY = Number(process.env.COMPRESS_LEVEL ?? 6);

/** Text-ish payloads. PNG is already compressed, so it is deliberately absent. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/;

export function compressible(contentType: string): boolean {
  return COMPRESSIBLE.test(contentType);
}

/**
 * Encode `body` with the best codec the client advertised. Returns the input
 * unchanged when compression does not apply or would not actually shrink it.
 */
export async function encodeBody(
  body: Buffer,
  acceptEncoding: string,
  contentType: string,
): Promise<{ body: Buffer; encoding?: 'br' | 'gzip' }> {
  if (body.length < COMPRESS_MIN_BYTES || !compressible(contentType)) return { body };
  if (/\bbr\b/.test(acceptEncoding)) {
    const out = await brotli(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
    return out.length < body.length ? { body: out, encoding: 'br' } : { body };
  }
  if (/\bgzip\b/.test(acceptEncoding)) {
    const out = await deflate(body, { level: 6 });
    return out.length < body.length ? { body: out, encoding: 'gzip' } : { body };
  }
  return { body };
}
