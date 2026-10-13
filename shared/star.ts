/** A starred ticket goes to the top of the board and the PRs view. */

/** Starred items first. Each half keeps its order, so the queue ranking still holds inside it. */
export function starredFirst<T>(items: T[], isStarred: (item: T) => boolean): T[] {
  return [...items.filter(isStarred), ...items.filter((i) => !isStarred(i))];
}
