/**
 * The workspace-directory bridge (data/workspaces.ts). Runs at the apex
 * origin inside a hidden iframe; keeps the one piece of shared state — the
 * list of workspace (subdomain) names — in the apex's localStorage, and
 * answers list/add/remove from same-family origins over postMessage.
 *
 * It stores names only: never credentials, never log data. Origin checks
 * keep strangers out — only the apex and its subdomains may read or write.
 */

const KEY = 'tracelog:workspaces';
const apexHost = location.hostname; // this page IS served from the apex

/** Same registrable domain: the apex itself, or any subdomain of it. */
function allowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== location.protocol) return false;
    return u.hostname === apexHost || u.hostname.endsWith(`.${apexHost}`);
  } catch {
    return false;
  }
}

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function write(names: string[]): void {
  try {
    // de-duped, sorted, bounded — a directory of labels, nothing heavy
    const unique = [...new Set(names)].filter(Boolean).sort().slice(0, 256);
    localStorage.setItem(KEY, JSON.stringify(unique));
  } catch {
    /* storage disabled — reads will just return [] */
  }
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (!allowed(ev.origin)) return;
  const data = ev.data as { kind?: string; op?: string; name?: string; reqId?: number };
  if (data?.kind !== 'tl-dir' || typeof data.reqId !== 'number') return;

  let names = read();
  if (data.op === 'add' && data.name) {
    names = [...names, data.name];
    write(names);
    names = read();
  } else if (data.op === 'remove' && data.name) {
    names = names.filter((n) => n !== data.name);
    write(names);
  }
  (ev.source as Window | null)?.postMessage(
    { kind: 'tl-dir-result', reqId: data.reqId, names },
    ev.origin,
  );
});
