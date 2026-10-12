/**
 * Takes the README screenshots from the demo dashboard (scripts/demo/start.ts must run):
 *
 *   node scripts/demo/shoot.ts [name…]     # writes docs/images/<name>.png
 *
 * Before each capture it checks the page text for company names, people and real ticket keys,
 * and refuses to save a screenshot that has one. agent-dash's own labels for the Postman and
 * Fern environments are product text, so they show as "Staging" and "Acme" first.
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

/** agent-dash's own words for the two companies' environments, and the defaults that name them. */
const SANITIZE = `(() => {
  const map = [[/postmanlabs\\.atlassian\\.net/g, "acme.atlassian.net"], [/postman\\.enterprise\\.slack\\.com/g, "acme.slack.com"], [/postman-eng\\/cloud9-parcels-production-deployments/g, "acme/deploy-prod"], [/postman-eng\\/cloud9-parcels-deployments/g, "acme/deploy-staging"], [/sam@postman\\.com/g, "sam@acme.example"], [/postman_beta/g, "staging"], [/postman_prod/g, "prod"], [/fern_dev/g, "staging"], [/fern_prod/g, "prod"], [/Postman Beta/g, "Staging"], [/Postman Prod/g, "Production"], [/Fern Dev/g, "Staging"], [/Fern Prod/g, "Production"], [/\\bPostman\\b/g, "Acme"], [/\\bFern\\b/g, "Acme"]];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode()); ) {
    let t = n.nodeValue;
    for (const [re, to] of map) t = t.replace(re, to);
    if (t !== n.nodeValue) n.nodeValue = t;
  }
})()`;

/**
 * What must never be in a screenshot: company names, real people, and real ticket projects. Only
 * the text inside the viewport counts, because the capture holds only the viewport.
 */
const GUARD = `(() => {
  const bad = /postman|fern|piper|gragg|\\b(FSDK|EFSUP|FSM)-\\d|cloud9|enterprise\\.slack/i;
  const seen = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const parts = [document.title];
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

/** Each shot starts from a fresh page: no layout, width or "seen" marks kept from the last one. */
async function open(hash: string) {
  ab("open", `${BASE}/${hash}`);
  ab("set", "viewport", "1600", "1000");
  evalJs("localStorage.clear(); sessionStorage.clear()");
  ab("reload");
  await sleep(2500);
}

async function capture(name: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    evalJs(SANITIZE);
    const before = JSON.parse(evalJs(GUARD));
    if (before) throw new Error(`${name}: the page shows "${before}"`);
    const tmp = `${ROOT}/${name}.png`;
    ab("screenshot", tmp);
    // A live update can re-render the page between the check and the capture: check again.
    if (!JSON.parse(evalJs(GUARD))) {
      renameSync(tmp, `${OUT}${name}.png`);
      console.log(`docs/images/${name}.png`);
      return;
    }
  }
  throw new Error(`${name}: the page kept changing`);
}

const SHOTS: Record<string, () => Promise<void>> = {
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
  async wiki() {
    await open("#/wiki:services/Release bot.md");
    await sleep(1500);
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
try {
  for (const name of names) {
    if (!SHOTS[name]) throw new Error(`no shot named ${name}; the shots are ${Object.keys(SHOTS).join(", ")}`);
    await SHOTS[name]();
    await capture(name);
  }
} finally {
  ab("close");
}
