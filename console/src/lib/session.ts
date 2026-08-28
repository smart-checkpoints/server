/**
 * Where the console keeps the project API key.
 *
 * The key is a bearer credential for a whole enforcement project, so it lives
 * in `sessionStorage`: scoped to one tab, gone when the tab closes, and never
 * written into a URL. The previous console passed it as `?key=` on every
 * project link, which put it in browser history, in the Referer header of
 * anything the page loaded, and in any proxy log along the way.
 *
 * Storage is an external store, so it is read through `useSyncExternalStore`
 * rather than copied into state by an effect: a page reads the key it actually
 * holds, at the moment it renders, with no window where the two disagree.
 *
 * The admin password is deliberately absent from this file. It is held in
 * React state for the life of the page and nowhere else.
 */
import { useSyncExternalStore } from "react";

import type { Project } from "@/lib/api";

const STORAGE_KEY = "smart-checkpoints.session";

export type ConsoleSession = Project & {
  apiKey: string;
};

function isSession(value: unknown): value is ConsoleSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.apiKey === "string" &&
    typeof candidate.project_id === "number" &&
    typeof candidate.project_name === "string"
  );
}

const listeners = new Set<() => void>();

/* `useSyncExternalStore` compares snapshots by identity, so the parsed object
   is cached against the raw string it came from. Re-parsing on every read
   would hand React a new object every time and loop it. */
let cachedRaw: string | null = null;
let cachedSession: ConsoleSession | null = null;

function readRaw(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // A private window, or a browser with site data blocked.
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Reads the open session, or null when there is none. */
export function readSession(): ConsoleSession | null {
  if (typeof window === "undefined") return null;

  const raw = readRaw();
  if (raw === cachedRaw) return cachedSession;

  cachedRaw = raw;
  if (!raw) {
    cachedSession = null;
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    cachedSession = isSession(parsed) ? parsed : null;
  } catch {
    cachedSession = null;
  }
  return cachedSession;
}

export function writeSession(session: ConsoleSession): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage being unavailable is not fatal: the page already holds the key
    // in memory, and the operator only loses it across a reload.
  }
  notify();
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if it was never written.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab signing out of the same project should not leave this one
  // holding a key the operator thinks they revoked.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * The session for this tab.
 *
 * `undefined` means "not read yet", because the markup is prerendered at build
 * time where there is no storage to read. It is the difference between a page
 * that waits and a page that flashes an unlock prompt at an operator who is
 * already signed in.
 */
export function useConsoleSession(): ConsoleSession | null | undefined {
  return useSyncExternalStore(subscribe, readSession, () => undefined);
}
