/**
 * Worker entry: SharedWorker when the browser provides it (one backend for
 * every tab), dedicated Worker otherwise (same protocol, per-tab). All the
 * logic lives in backend.ts; this file only routes ports.
 */
// The AWS SDK's browser build deserializes S3's XML responses with the
// DOM — DOMParser to parse, the Node global's nodeType constants to walk
// the tree — none of which worker scopes provide. Polyfill from xmldom;
// the SDK touches these at response-parse time, safely after module eval.
import { DOMParser, Node as XmlNode, XMLSerializer } from '@xmldom/xmldom';
const g = globalThis as Record<string, unknown>;
g.DOMParser ??= DOMParser;
g.Node ??= XmlNode;
g.XMLSerializer ??= XMLSerializer;

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
