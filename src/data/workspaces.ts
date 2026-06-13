/**
 * Workspace directory (SPEC §4, §10). Each `*.tracelog.org` subdomain is a
 * separate browser origin with its own siloed profiles and cache — so no
 * origin can natively see which other workspaces exist. This shares ONE
 * thing across them: a list of workspace *names* (subdomain labels only —
 * never credentials, never logs), kept in the apex origin's localStorage
 * and reached from any subdomain through a hidden iframe + postMessage
 * (bridge.html). No cookies, no server: the apex page is static and the
 * bridge does no network work, so "the server knows nothing" still holds.
 *
 * On hosts with no apex to bridge to (localhost, an IP, a bare domain), the
 * directory degrades to the current origin only — the switcher still lists
 * local profiles, just without cross-workspace hops.
 */

export interface WorkspaceContext {
  /** registrable apex, e.g. 'tracelog.org'; null when there's nothing to bridge */
  apexHost: string | null;
  /** current subdomain label, e.g. 'duiduidui'; '' on the apex itself */
  current: string;
  /** origin serving bridge.html, e.g. 'https://tracelog.org'; null = no bridge */
  bridgeOrigin: string | null;
}

function isBareHost(host: string): boolean {
  return host === 'localhost' || /^[\d.]+$/.test(host) || !host.includes('.');
}

export function workspaceContext(): WorkspaceContext {
  const host = location.hostname;
  if (isBareHost(host)) return { apexHost: null, current: '', bridgeOrigin: null };
  const parts = host.split('.');
  const apexHost = parts.slice(-2).join('.');
  const current = parts.length > 2 ? parts.slice(0, -2).join('.') : '';
  return { apexHost, current, bridgeOrigin: `${location.protocol}//${apexHost}` };
}

/** The full https URL a workspace label lives at (for navigation). */
export function workspaceUrl(label: string): string {
  const { apexHost } = workspaceContext();
  const host = label ? `${label}.${apexHost}` : apexHost;
  return `https://${host}/`;
}

type Pending = { resolve: (names: string[]) => void; timer: ReturnType<typeof setTimeout> };

class WorkspaceDirectory {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private bridge(): string | null {
    return workspaceContext().bridgeOrigin;
  }

  /** Lazily mount the apex bridge iframe; resolves when it has loaded. */
  private ensureFrame(): Promise<void> | null {
    const origin = this.bridge();
    if (!origin) return null;
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.display = 'none';
      frame.src = `${origin}/bridge.html`;
      frame.onload = () => resolve();
      frame.onerror = () => resolve(); // unreachable bridge → calls just time out
      document.body.appendChild(frame);
      this.frame = frame;
      window.addEventListener('message', (ev) => this.onMessage(ev, origin));
    });
    return this.ready;
  }

  private onMessage(ev: MessageEvent, origin: string): void {
    if (ev.origin !== origin) return;
    const data = ev.data as { kind?: string; reqId?: number; names?: string[] };
    if (data?.kind !== 'tl-dir-result' || typeof data.reqId !== 'number') return;
    const waiter = this.pending.get(data.reqId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(data.reqId);
    waiter.resolve(Array.isArray(data.names) ? data.names : []);
  }

  private send(op: 'list' | 'add' | 'remove', name?: string): Promise<string[]> {
    const frame = this.ensureFrame();
    if (!frame) return Promise.resolve([]); // no apex → empty directory
    return frame.then(
      () =>
        new Promise<string[]>((resolve) => {
          const reqId = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(reqId);
            resolve([]); // bridge silent → degrade to empty, never hang the UI
          }, 2500);
          this.pending.set(reqId, { resolve, timer });
          this.frame?.contentWindow?.postMessage({ kind: 'tl-dir', op, name, reqId }, this.bridge()!);
        }),
    );
  }

  list(): Promise<string[]> {
    return this.send('list');
  }
  add(name: string): Promise<string[]> {
    return this.send('add', name);
  }
  remove(name: string): Promise<string[]> {
    return this.send('remove', name);
  }
}

export const workspaces = new WorkspaceDirectory();
