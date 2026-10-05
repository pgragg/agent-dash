import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { Diagram } from "../../shared/types.ts";
import { href } from "./routes.ts";

/** Mermaid is big, so it loads the first time a diagram shows. */

type MermaidApi = (typeof import("mermaid"))["default"];
let loader: Promise<MermaidApi> | null = null;

function mermaid(): Promise<MermaidApi> {
  loader ??= import("mermaid").then(({ default: m }) => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    // "strict" escapes labels and turns off click handlers: an agent wrote this code.
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", suppressErrorRendering: true, fontFamily: "inherit" });
    return m;
  });
  return loader;
}

let seq = 0;

export function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSvg(null);
    setError(null);
    mermaid()
      .then((m) => m.render(`mermaid-${++seq}`, code))
      .then((out) => live && setSvg(out.svg))
      .catch((err: Error) => live && setError(err?.message ?? String(err)));
    return () => {
      live = false;
    };
  }, [code]);
  if (error) {
    return (
      <div className="mermaid-error">
        <span className="meta">This mermaid code does not render: {error.split("\n")[0]}</span>
        <pre>{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="mermaid loading"><span className="shimmer" /></div>;
  // Mermaid's strict mode sanitizes the SVG it makes.
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// ---- which diagram a fence or an image on the page is ---------------------------------

/** Every diagram, set by each dashboard load, as the ticket keys are for links. */
let known: Diagram[] = [];
export function setKnownDiagrams(diagrams: Diagram[]): void {
  known = diagrams;
}

/** The conversation whose messages are inside, so their diagrams link to that conversation's rows. */
const SessionContext = createContext<string | null>(null);

export function SessionScope({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  return <SessionContext.Provider value={sessionId}>{children}</SessionContext.Provider>;
}

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The conversation's own diagram first: the same code in two conversations is two diagrams. */
function pick(sessionId: string | null, match: (d: Diagram) => boolean): Diagram | undefined {
  return known.find((d) => match(d) && d.sessionId === sessionId) ?? known.find(match);
}

/** A ```mermaid fence in a message: the chart, and a link to its diagram page. */
export function MermaidFence({ code }: { code: string }) {
  const sessionId = useContext(SessionContext);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    // The server hashes the code without its trailing newlines.
    sha1(code.trimEnd()).then(setHash, () => setHash(null));
  }, [code]);
  const d = hash ? pick(sessionId, (x) => x.hash === hash) : undefined;
  return (
    <figure className="md-diagram">
      <Mermaid code={code} />
      {d && (
        <figcaption>
          <a href={href(`d:${d.id}`)}>Diagram {d.id} ↗</a>
        </figcaption>
      )}
    </figure>
  );
}

/** A local image shows from its stored copy, so it outlives the file. */
export function EmbeddedImage({ alt, path }: { alt: string; path: string }) {
  const d = pick(useContext(SessionContext), (x) => x.origin === path && x.kind !== "mermaid");
  if (!d) return <code title="This image is not stored as a diagram">{alt || path}</code>;
  return (
    <a className="md-image" href={href(`d:${d.id}`)} title={`${d.title} · open the diagram`}>
      <img src={`/api/diagram/raw?id=${d.id}`} alt={alt || d.title} loading="lazy" />
    </a>
  );
}
