import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WikiList } from "../../shared/wiki.ts";
import { listWiki, readWikiNote, searchWikiDir, wikiFile } from "../wiki.ts";

/**
 * The Wiki view, read-only, from the folder in the `wikiDir` setting.
 *
 * - `GET /api/wiki`: every note (`WikiList`).
 * - `GET /api/wiki?q=words`: the notes that hold every word, best first, with matching lines.
 * - `GET /api/wiki/note?ref=R`: one note, by path, file name, title or alias, with its backlinks.
 * - `GET /api/wiki/file?ref=R`: an image in the wiki, for `![[x.png]]`, sandboxed like a document image.
 */
export function handle(req: IncomingMessage, res: ServerResponse, url: URL, dir: string): boolean {
  if (url.pathname !== "/api/wiki" && !url.pathname.startsWith("/api/wiki/")) return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    return true;
  };
  if (req.method !== "GET") return json(405, { error: "the wiki is read-only" });
  const ready = !!dir && existsSync(dir) && statSync(dir).isDirectory();

  if (url.pathname === "/api/wiki") {
    if (!ready) return json(200, { configured: !!dir, dir, notes: [] } satisfies WikiList);
    const q = url.searchParams.get("q");
    if (q !== null) return json(200, searchWikiDir(dir, q.slice(0, 200)));
    return json(200, { configured: true, dir, notes: listWiki(dir) } satisfies WikiList);
  }
  if (!ready) return json(404, { error: dir ? `the wiki folder ${dir} does not exist` : "no wiki folder is set: set it in Settings" });

  const ref = url.searchParams.get("ref") ?? "";
  if (url.pathname === "/api/wiki/note") {
    const note = readWikiNote(dir, ref);
    return note ? json(200, note) : json(404, { error: `no note named “${ref.slice(0, 120)}”` });
  }
  if (url.pathname === "/api/wiki/file") {
    const file = wikiFile(dir, ref);
    if (!file) return json(404, { error: "no such image in the wiki" });
    res
      .writeHead(200, {
        "Content-Type": file.mime,
        // An SVG in the vault runs no script, as a document image does not.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      })
      .end(readFileSync(file.abs));
    return true;
  }
  return json(404, { error: "no such wiki route" });
}
