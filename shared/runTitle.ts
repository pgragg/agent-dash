/**
 * The title of a run on the page, in notifications and in the tab. A pi session name wins; then
 * the short title that agent-dash drafted; then the first prompt, made safe to show.
 */

/** Each URL as its host in brackets: a full link (a 1Password item, a token) is long and can be secret. */
export function hideUrls(text: string): string {
  // A sentence's full stop or comma after a link is not part of it.
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#<>"')\]]*)[^\s<>"')\]]*?(?=[.,;:!?]*(?:[\s<>"')\]]|$))/gi, (_, host: string) => `[${host.replace(/^[^@]*@/, "").replace(/[.,;:!?]+$/, "") || "link"}]`);
}

/** The first prompt as a title: no URLs, cut to 80 characters. */
export function promptTitle(firstPrompt: string, max = 80): string {
  const flat = hideUrls(firstPrompt).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A session name stays as it is, except its URLs: no title on the page shows a full URL. */
export function runTitle(run: { name: string | null; title?: string | null; firstPrompt: string }): string {
  return run.name != null ? hideUrls(run.name) : (run.title ?? promptTitle(run.firstPrompt));
}

/** The model's title, held to 8 words so it fits a rail row and a tab. */
export function shortTitle(raw: string): string | null {
  const words = hideUrls(raw).replace(/[.。]+$/, "").split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 8).join(" ") : null;
}
