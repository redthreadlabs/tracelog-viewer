/**
 * Worker entry: SharedWorker when the browser provides it (one backend for
 * every tab), dedicated Worker otherwise (same protocol, per-tab). All the
 * logic lives in backend.ts; this file only routes ports.
 */
import { handlePort } from './backend';

const scope = self as unknown as {
  onconnect?: (ev: MessageEvent) => void;
  onmessage?: ((ev: MessageEvent) => void) | null;
  postMessage?: (message: unknown) => void;
};

// SharedWorker: one port per connecting tab
scope.onconnect = (ev: MessageEvent) => {
  const port = (ev as unknown as { ports: MessagePort[] }).ports[0];
  handlePort(port);
  port.start();
};

// Dedicated-worker fallback: the worker global itself acts as the port
declare const SharedWorkerGlobalScope: unknown;
if (typeof SharedWorkerGlobalScope === 'undefined' && scope.postMessage) {
  handlePort({
    postMessage: (message: unknown) => scope.postMessage!(message),
    set onmessage(handler: (ev: MessageEvent) => void) {
      scope.onmessage = handler;
    },
  } as never);
}
