import { useMemo, useRef, useState } from "react";
import { type Brief, briefTldr, lintBrief } from "../../shared/brief.ts";
import { BRIEF_CSS, briefDocument, briefHtml, briefSvgs, SVG_THEME } from "../../shared/briefRender.ts";

/** A ticket brief on the dashboard: the same page as the file that goes on the Jira ticket, plus a toolbar. */

// One <style> for every brief on the page: the export carries the same rules inline.
if (typeof document !== "undefined" && !document.getElementById("tb-css")) {
  const style = document.createElement("style");
  style.id = "tb-css";
  style.textContent = BRIEF_CSS + SVG_THEME;
  document.head.append(style);
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A closed brief: its title, its ask and "At a glance", with a button to read the rest. */
export function BriefGlance({ brief, onRead }: { brief: Brief; onRead: () => void }) {
  const html = useMemo(() => briefHtml(brief, { glanceOnly: true }), [brief]);
  return (
    <div className="brief-host brief-glance">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <button className="btn small brief-read" onClick={onRead}>
        Read the brief
      </button>
    </div>
  );
}

export function BriefView({ brief, compact = false }: { brief: Brief; compact?: boolean }) {
  // The renderer escapes every text of the spec, and makes links of http(s) URLs only.
  const html = useMemo(() => briefHtml(brief), [brief]);
  const lint = useMemo(() => lintBrief(brief), [brief]);
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  if (compact) return <div className="brief-host" dangerouslySetInnerHTML={{ __html: html }} />;
  const copy = async () => {
    await navigator.clipboard.writeText(briefTldr(brief));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const svg = () => {
    const svgs = briefSvgs(brief);
    // The open map view: its radio is the checked one.
    const radios = [...(ref.current?.querySelectorAll<HTMLInputElement>(".tb-system .tb-radio") ?? [])];
    const i = Math.max(0, radios.findIndex((r) => r.checked));
    const s = svgs[i] ?? svgs[0];
    if (s) download(s.name, s.svg, "image/svg+xml");
  };
  const notes = [...lint.errors, ...lint.warnings];
  return (
    <div className="brief-host" ref={ref}>
      <div className="brief-bar">
        <button className="btn ghost small" onClick={copy} title="The 30-second version, as markdown, for a Jira comment or a Slack post">
          {copied ? "Copied" : "Copy TL;DR"}
        </button>
        <button className="btn ghost small" onClick={() => download(`${brief.key}.brief.html`, briefDocument(brief), "text/html")} title="One HTML file with no script: attach it to the Jira ticket">
          Download HTML
        </button>
        {(brief.system || brief.flow) && (
          <button className="btn ghost small" onClick={svg} title="The map view that is open, as an SVG image to attach to the ticket">
            Download SVG
          </button>
        )}
        <span className="grow" />
        {notes.length > 0 && (
          <details className="brief-notes">
            <summary className={`meta ${lint.errors.length ? "tone-text-warn" : ""}`}>
              {notes.length} editing {notes.length === 1 ? "note" : "notes"}
            </summary>
            <ul>
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
