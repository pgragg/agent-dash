import assert from "node:assert/strict";
import { test } from "node:test";
import { type AdfNode, adfToMarkdown } from "../shared/adf.ts";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", content });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: AdfNode["marks"] & {}): AdfNode => ({ type: "text", text, marks });
const li = (...content: AdfNode[]): AdfNode => ({ type: "listItem", content });

test("paragraphs and headings become markdown blocks", () => {
  const md = adfToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [t("Root cause")] }, p(t("One.")), p(t("Two."))));
  assert.equal(md, "## Root cause\n\nOne.\n\nTwo.");
});

test("inline marks: code, strong, em, and links", () => {
  const md = adfToMarkdown(
    doc(
      p(
        t("run "),
        t("pnpm test", { type: "code" }),
        t(", "),
        t("now", { type: "strong" }),
        t(" "),
        t("please", { type: "em" }),
        t(" see "),
        t("the run", { type: "link", attrs: { href: "https://github.com/o/r/actions/runs/1" } }),
      ),
    ),
  );
  assert.equal(md, "run `pnpm test`, **now** *please* see [the run](https://github.com/o/r/actions/runs/1)");
});

test("a link whose text is its URL stays bare, and a URL that breaks [label](url) goes in brackets", () => {
  const url = "https://github.com/o/r/actions/runs/1):";
  assert.equal(adfToMarkdown(doc(p(t(url, { type: "link", attrs: { href: url } })))), url);
  assert.equal(adfToMarkdown(doc(p(t("log", { type: "link", attrs: { href: url } })))), `log (${url})`);
});

test("spaces stay outside bold markers", () => {
  assert.equal(adfToMarkdown(doc(p(t("Risk: ", { type: "strong" }), t("forks")))), "**Risk:** forks");
});

test("code marks win over other marks", () => {
  assert.equal(adfToMarkdown(doc(p(t("x", { type: "code" }, { type: "strong" })))), "`x`");
});

test("bullet, ordered, and nested lists", () => {
  const md = adfToMarkdown(
    doc(
      { type: "bulletList", content: [li(p(t("a"))), li(p(t("b")), { type: "bulletList", content: [li(p(t("b1")))] })] },
      { type: "orderedList", attrs: { order: 3 }, content: [li(p(t("c"))), li(p(t("d")))] },
    ),
  );
  assert.equal(md, "- a\n- b\n  - b1\n\n3. c\n4. d");
});

test("code blocks keep their text and language", () => {
  const md = adfToMarkdown(doc({ type: "codeBlock", attrs: { language: "bash" }, content: [t("echo hi\necho there")] }));
  assert.equal(md, "```bash\necho hi\necho there\n```");
});

test("mentions, hard breaks, inline cards, and dates", () => {
  const md = adfToMarkdown(
    doc(
      p(
        { type: "mention", attrs: { text: "@Ada Lovelace" } },
        t(" look"),
        { type: "hardBreak" },
        { type: "inlineCard", attrs: { url: "https://github.com/o/r/pull/7" } },
        t(" by "),
        { type: "date", attrs: { timestamp: "1790985600000" } },
      ),
    ),
  );
  assert.equal(md, "@Ada Lovelace look\nhttps://github.com/o/r/pull/7 by 2026-10-03");
});

test("an unknown node keeps its text", () => {
  const md = adfToMarkdown(doc({ type: "panel", content: [p(t("inside a panel"))] }, p({ type: "futureInline", content: [t("still here")] }), { type: "futureBlock", text: "raw" }));
  assert.equal(md, "inside a panel\n\nstill here\n\nraw");
});

test("tables become rows that the page renders as a table", () => {
  const cell = (s: string): AdfNode => ({ type: "tableCell", content: [p(t(s))] });
  const md = adfToMarkdown(doc({ type: "table", content: [{ type: "tableRow", content: [cell("env"), cell("state")] }, { type: "tableRow", content: [cell("beta"), cell("a|b")] }] }));
  assert.equal(md, "| env | state |\n| beta | a/b |");
});

test("empty and plain-string input", () => {
  assert.equal(adfToMarkdown(null), "");
  assert.equal(adfToMarkdown("plain text"), "plain text");
  assert.equal(adfToMarkdown(doc()), "");
});
