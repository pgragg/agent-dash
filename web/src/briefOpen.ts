import { useState } from "react";

/** Which tickets show their brief open in the workspace. A brief starts closed, so only the open ones are kept. */

const KEY = "agent-dash:brief-open";

type Store = Pick<Storage, "getItem" | "setItem">;

function read(store: Store): Record<string, true> {
  try {
    const v = JSON.parse(store.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const isBriefOpen = (store: Store, ticket: string): boolean => read(store)[ticket] === true;

export function setBriefOpen(store: Store, ticket: string, open: boolean): void {
  const map = read(store);
  if (open) map[ticket] = true;
  else delete map[ticket];
  store.setItem(KEY, JSON.stringify(map));
}

export function useBriefOpen(ticket: string | null): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => (ticket ? isBriefOpen(localStorage, ticket) : false));
  return [
    open,
    (o) => {
      setOpen(o);
      if (ticket) setBriefOpen(localStorage, ticket, o);
    },
  ];
}
