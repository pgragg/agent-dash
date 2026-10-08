import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { namesOf, type WikiHit, type WikiList, type WikiNote, type WikiNoteMeta } from "../../shared/wiki.ts";
import { Markdown, plural, setWikiNames } from "./lib.tsx";
import { href } from "./routes.ts";

/** The Wiki view: the notes of the local Obsidian vault in the `wikiDir` setting, read-only. */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `failed (${res.status})`);
  return json as T;
}

/** The list loads once per page view; a note's links use its names to mark broken links. */
let listPromise: Promise<WikiList> | null = null;
function loadList(fresh = false): Promise<WikiList> {
  if (!listPromise || fresh) {
    listPromise = getJson<WikiList>("/api/wiki").then((l) => {
      setWikiNames(new Set(l.notes.flatMap(namesOf)));
      return l;
    });
    listPromise.catch(() => (listPromise = null));
  }
  return listPromise;
}

const folderLabel = (f: string) => f || "Top level";

function TypeTag({ type }: { type: string }) {
  return type ? <span className={`tag wiki-type wiki-type-${type.replace(/[^a-z-]/gi, "")}`}>{type}</span> : null;
}

/** The query's words in a line, marked. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

function NoteRow({ n, words, lines }: { n: WikiNoteMeta; words: string[]; lines?: WikiHit["lines"] }) {
  return (
    <li className={`wiki-row ${n.status ? "wiki-stale" : ""}`}>
      <div className="wiki-row-head">
        <a className="wiki-title h-title" href={href(`wiki:${n.path}`)} title={n.path}>
          <Marked text={n.title} words={words} />
        </a>
        <TypeTag type={n.type} />
        {n.status && <span className="tag tone-warn">{n.status}</span>}
        <span className="grow" />
        {n.tags.length > 0 && <span className="meta wiki-tags">{n.tags.map((t) => `#${t}`).join(" ")}</span>}
        {n.updated && <span className="meta wiki-date">{n.updated}</span>}
      </div>
      {lines && lines.length > 0 && (
        <ul className="wiki-lines">
          {lines.map((l) => (
            <li key={l.n}>
              <span className="meta">{l.n}</span> <Marked text={l.text} words={words} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** `#/wiki`: every note grouped by folder, a type filter, and a search over titles, tags and text. */
export function WikiListView() {
  const [list, setList] = useState<WikiList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(() => sessionStorage.getItem("agent-dash:wiki-query") ?? "");
  const [type, setType] = useState<string | null>(null);
  const [hits, setHits] = useState<WikiHit[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadList(true).then(setList, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    sessionStorage.setItem("agent-dash:wiki-query", query);
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      getJson<WikiHit[]>(`/api/wiki?q=${encodeURIComponent(query)}`).then(
        (h) => live && setHits(h),
        (e: Error) => live && setError(e.message),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  // `/` searches, as on the kanban.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of list?.notes ?? []) counts.set(n.type || "untyped", (counts.get(n.type || "untyped") ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);
  const keep = (n: WikiNoteMeta) => !type || (n.type || "untyped") === type;

  if (error) return <div className="zero big">{error}</div>;
  if (!list) return <span className="shimmer wide" />;
  if (!list.configured)
    return (
      <div className="zero big">
        No wiki folder is set. Set <b>Wiki folder</b> in <a href="#/settings">Settings</a> to a local Obsidian vault, such as <code>~/pi/wiki</code>, then restart.
      </div>
    );

  const folders = new Map<string, WikiNoteMeta[]>();
  for (const n of list.notes.filter(keep)) folders.set(n.folder, [...(folders.get(n.folder) ?? []), n]);
  const sortedFolders = [...folders.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  const shownHits = hits?.filter(keep) ?? null;

  return (
    <article className="workspace wiki">
      <header className="ws-head">
        <h1>Wiki</h1>
        <div className="ws-meta">
          <span className="meta">
            {plural(list.notes.length, "note")} in <code>{list.dir}</code> · read-only
          </span>
        </div>
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="Search titles, tags and text (/)"
          aria-label="Search the wiki"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            } else if (e.key === "Enter" && shownHits?.[0]) location.hash = href(`wiki:${shownHits[0].path}`);
          }}
        />
        <div className="wiki-types" role="group" aria-label="Filter by type">
          <button className={`chip ${type === null ? "active" : ""}`} onClick={() => setType(null)}>
            all <span className="count">{list.notes.length}</span>
          </button>
          {types.map(([t, c]) => (
            <button key={t} className={`chip ${type === t ? "active" : ""}`} onClick={() => setType(type === t ? null : t)}>
              {t} <span className="count">{c}</span>
            </button>
          ))}
        </div>
      </header>
      {shownHits ? (
        shownHits.length === 0 ? (
          <div className="zero big">No note holds every word of “{query}”.</div>
        ) : (
          <section>
            <h2 className="section-title">{plural(shownHits.length, "match")} · best first</h2>
            <ol className="history wiki-list">
              {shownHits.map((h) => (
                <NoteRow key={h.path} n={h} words={words} lines={h.lines} />
              ))}
            </ol>
          </section>
        )
      ) : (
        sortedFolders.map(([folder, notes]) => (
          <section key={folder} className="wiki-folder">
            <h2 className="section-title">
              {folderLabel(folder)} · {notes.length}
            </h2>
            <ol className="history wiki-list">
              {notes
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((n) => (
                  <NoteRow key={n.path} n={n} words={[]} />
                ))}
            </ol>
          </section>
        ))
      )}
    </article>
  );
}

/** Front matter fields that the head shows on their own line; the rest are chips. */
const LONG_FIELDS = new Set(["source"]);
const HIDDEN_FIELDS = new Set(["title"]);

/** `#/wiki:REF`: one note, rendered, with its front matter, backlinks, and a link to Obsidian. */
export function WikiNoteView({ refId }: { refId: string }) {
  const [note, setNote] = useState<WikiNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setNote(null);
    setError(null);
    // The names load first, so the note's broken links show as broken on the first render.
    loadList()
      .catch(() => null)
      .then(() => getJson<WikiNote>(`/api/wiki/note?ref=${encodeURIComponent(refId)}`))
      .then(
        (n) => {
          if (!live) return;
          setNote(n);
          // A link by title or alias lands on the note's own address, so a copy of the URL is stable.
          if (n.path !== refId) history.replaceState(null, "", href(`wiki:${n.path}`));
          window.scrollTo(0, 0);
        },
        (e: Error) => live && setError(e.message),
      );
    return () => {
      live = false;
    };
  }, [refId]);

  if (error)
    return (
      <article className="workspace">
        <a className="meta" href="#/wiki">
          ← Wiki
        </a>
        <div className="zero big">{error}</div>
      </article>
    );
  if (!note) return <span className="shimmer wide" />;
  const chips = note.fields.filter(([k, v]) => v && !LONG_FIELDS.has(k) && !HIDDEN_FIELDS.has(k));
  const long = note.fields.filter(([k, v]) => v && LONG_FIELDS.has(k));
  const obsidian = `obsidian://open?vault=${encodeURIComponent(note.vault)}&file=${encodeURIComponent(note.path.replace(/\.md$/i, ""))}`;
  // The page heading is the title, so the body's own first `# Title` would say it twice.
  const body = note.body.replace(/^#\s+(.+)\n+/, (line, h: string) => (h.trim() === note.title ? "" : line));
  return (
    <article className="workspace wiki-note">
      <header className="ws-head">
        <nav className="meta wiki-crumbs">
          <a href="#/wiki">Wiki</a>
          {note.folder && (
            <>
              {" / "}
              <span>{note.folder}</span>
            </>
          )}
        </nav>
        <h1>{note.title}</h1>
        <div className="ws-meta wiki-fields">
          <TypeTag type={note.type} />
          {note.status && <span className="tag tone-warn">{note.status}</span>}
          {chips
            .filter(([k]) => k !== "type" && k !== "status")
            .map(([k, v]) => (
              <span key={k} className="meta wiki-field">
                <b>{k}</b> {k === "tags" ? v.split(/,\s*/).map((t) => `#${t}`).join(" ") : v}
              </span>
            ))}
          <span className="grow" />
          <a className="btn ghost small" href={obsidian} title={`Open ${note.path} in Obsidian`}>
            Open in Obsidian
          </a>
        </div>
        {long.map(([k, v]) => (
          <p key={k} className="meta wiki-source">
            <b>{k}</b> {v}
          </p>
        ))}
      </header>
      <div className="doc-body wiki-body">
        <Markdown text={body} />
      </div>
      <section className="wiki-backlinks">
        <h2 className="section-title">Linked from · {note.backlinks.length}</h2>
        {note.backlinks.length === 0 ? (
          <p className="meta">No note links here.</p>
        ) : (
          <ol className="history wiki-list">
            {note.backlinks.map((n) => (
              <NoteRow key={n.path} n={n} words={[]} />
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
