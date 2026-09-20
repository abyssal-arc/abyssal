/**
 * Minimal static file server for packages/web.
 * Dev-only: on Cloudflare Workers this duty moves to Workers Static Assets.
 *
 * Files are read from disk on every request so a frontend edit shows up on the
 * next reload. The mtime/size validator is what keeps that cheap: an unchanged
 * file answers 304 with an empty body instead of re-sending ~193 KB of assets.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface StaticRequestHeaders {
  get(name: string): string | null;
}

export async function serveStatic(
  root: string,
  pathname: string,
  req?: StaticRequestHeaders,
): Promise<Response | null> {
  const filePath = normalize(join(root, pathname));
  if (filePath !== normalize(root) && !filePath.startsWith(normalize(root) + sep)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    const lastModified = info.mtime.toUTCString();
    const headers: Record<string, string> = {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag,
      'last-modified': lastModified,
    };
    if (req?.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers });
    }
    const since = req?.get('if-modified-since');
    if (since && !req?.get('if-none-match') && Date.parse(since) >= Math.floor(info.mtimeMs)) {
      return new Response(null, { status: 304, headers });
    }
    const data = await readFile(filePath);
    return new Response(new Uint8Array(data), { headers });
  } catch {
    return null;
  }
}
