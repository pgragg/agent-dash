/**
 * Takes the README screenshots from the demo dashboard (scripts/demo/start.ts must run):
 *
 *   node scripts/demo/shoot.ts [name…]     # writes docs/images/<name>.png
 *
 * Before each capture it checks the page text for company names, people and real ticket keys,
 * and refuses to save a screenshot that has one.
 */
import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { PORT, ROOT } from "./config.ts";

const SESSION = "agent-dash-demo-shots";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL("../../docs/images/", import.meta.url).pathname;

const ab = (...args: string[]) => execFileSync("agent-browser", ["--session", SESSION, ...args], { encoding: "utf8" }).trim();
const evalJs = (js: string) => ab("eval", js);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What must never be in a screenshot: company names, real people, and real ticket projects. Only
 * the text that the capture holds counts: inside the element, or else inside the viewport.
 */
const guard = (selector?: string) => `(() => {
  const bad = /postman|fern|piper|gragg|\\b(FSDK|EFSUP|FSM)-\\d|cloud9|enterprise\\.slack/i;
  const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};
  const box = el ? el.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
  const seen = (r) => r.width > 0 && r.height > 0 && r.bottom > box.top && r.right > box.left && r.top < box.bottom && r.left < box.right;
  const parts = el ? [] : [document.title];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode()); ) {
    if (!n.nodeValue.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    if ([...range.getClientRects()].some(seen)) parts.push(n.nodeValue);
  }
  for (const e of document.querySelectorAll("input, textarea, select")) if (seen(e.getBoundingClientRect())) parts.push(e.value, e.placeholder || "");
  const text = parts.join("\\n");
  const m = text.match(bad);
  return m ? text.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\\s+/g, " ") : "";
})()`;

/** Scrolls an element to the top of its scroll box, under a small margin. */
const scrollTo = (selector: string, margin = 24) =>
  evalJs(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent);
    if (!el) return "missing";
    el.scrollIntoView({ block: "start" });
    let box = el.parentElement;
    while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
    (box ?? window).scrollBy(0, -${margin});
    return "ok";
  })()`);

/** Clicks the first visible element whose text starts with `text`. */
const clickText = (selector: string, text: string) =>
  evalJs(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent && e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return "missing";
    el.click();
    return "ok";
  })()`);

/** A window this tall holds the whole ticket view: an element capture outside the window comes out blank. */
const TALL = 4400;

/** Tags the element that `find` returns, so a shot can capture an element with no selector of its own. */
const mark = (find: string) => {
  if (evalJs(`(() => { const el = ${find}; if (!el) return "missing"; el.setAttribute("data-shot", ""); return "ok"; })()`) !== '"ok"') throw new Error(`no element for ${find}`);
  return "[data-shot]";
};

/** Each shot starts from a fresh page: no layout, width or "seen" marks kept from the last one. */
async function open(hash: string, height = 1000) {
  ab("open", `${BASE}/${hash}`);
  ab("set", "viewport", "1600", String(height));
  evalJs("localStorage.clear(); sessionStorage.clear()");
  ab("reload");
  await sleep(2500);
}

/** A shot is the viewport, or one element when `selector` is set. */
async function capture(name: string, selector?: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = JSON.parse(evalJs(guard(selector)));
    if (before) throw new Error(`${name}: the page shows "${before}"`);
    const tmp = `${ROOT}/${name}.png`;
    ab("screenshot", ...(selector ? [selector] : []), tmp);
    // A live update can re-render the page between the check and the capture: check again.
    if (!JSON.parse(evalJs(guard(selector)))) {
      renameSync(tmp, `${OUT}${name}.png`);
      console.log(`docs/images/${name}.png`);
      return;
    }
  }
  throw new Error(`${name}: the page kept changing`);
}

/** Each shot sets up the page, and returns the element to capture, or nothing for the viewport. */
const SHOTS: Record<string, () => Promise<string | void>> = {
  async board() {
    await open("#/t:ACME-412");
  },
  async kanban() {
    await open("#/t:ACME-412");
    clickText("button", "Kanban");
    await sleep(800);
    // The kanban opens the drawer of the selected ticket; the shot shows the columns.
    ab("press", "Escape");
    await sleep(500);
  },
  async "agent-cards"() {
    await open("#/t:ACME-412");
    scrollTo("h2.section-title");
    await sleep(500);
  },
  async smoketests() {
    await open("#/t:ACME-412");
    scrollTo("#smoketests");
    await sleep(500);
  },
  async ticket() {
    await open("#/t:ACME-412");
    ab("press", "t");
    await sleep(1500);
    scrollTo("section.ticket-panel");
    await sleep(500);
  },
  async prs() {
    await open("#/prs");
  },
  async "pr-panel"() {
    await open("#/pr:acme/web-platform/181");
    await sleep(1500);
  },
  async settings() {
    await open("#/settings");
  },
    async "ticket-view"() {
    await open("#/t:ACME-412", TALL);
    return "article.workspace";
  },
  async queue() {
    await open("#/t:ACME-412", 1500);
    return "nav.rail";
  },
  async "why-list"() {
    await open("#/t:ACME-412", TALL);
    return "article.workspace .why";
  },
  async "next-steps"() {
    await open("#/t:ACME-412", TALL);
    return "#next-steps";
  },
  async sdlc() {
    await open("#/t:ACME-412", TALL);
    return "article.workspace .sdlc";
  },
  async agents() {
    await open("#/t:ACME-412", TALL);
    return mark(`[...document.querySelectorAll("article.workspace h2.section-title")].find((h) => h.textContent.startsWith("Agent"))?.parentElement`);
  },
  async "smoketests-card"() {
    await open("#/t:ACME-412", TALL);
    return "#smoketests";
  },
  async "ticket-section"() {
    await open("#/t:ACME-412", TALL);
    ab("press", "t");
    await sleep(1500);
    return "section.ticket-panel";
  },
  async document() {
    await open("#/doc:1");
    await sleep(1500);
  },
  async "ticket-brief"() {
    await open("#/doc:5", 3600);
    await sleep(1500);
    return "article.workspace";
  },
  async documents() {
    await open("#/documents");
  },
  async wiki() {
    await open("#/wiki:services/Release bot.md");
    await sleep(1500);
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
try {
  for (const name of names) {
    if (!SHOTS[name]) throw new Error(`no shot named ${name}; the shots are ${Object.keys(SHOTS).join(", ")}`);
    await capture(name, (await SHOTS[name]()) ?? undefined);
  }
} finally {
  ab("close");
}
