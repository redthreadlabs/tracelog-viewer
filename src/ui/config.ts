/**
 * Connect this workspace (SPEC §6.0, §4). One workspace, one bucket: the
 * subdomain is the namespace, so there's no profile name — just credentials
 * for the bucket this workspace reads. The form prefills from an existing
 * connection (editing), and Disconnect drops it.
 */
import { el, clear } from './dom';
import { profiles, type Profile } from './profiles';
import { cacheWipeAll } from '../data/cache';
import {
  workspaceContext,
  dropCurrentWorkspace,
  recordCurrentWorkspaceIfNew,
  clearLocalWorkspaceState,
} from '../data/workspaces';

export function renderConfig(container: HTMLElement, onDone: () => void): void {
  clear(container);

  // config only renders on a subdomain (the apex isn't a workspace) or on
  // localhost/self-host single-origin
  const ctx = workspaceContext();
  const hereLabel = ctx.current && ctx.apexHost ? `${ctx.current}.${ctx.apexHost}` : 'this device';
  const existing = profiles.active();

  // the lede carries the disclosure + warning, updated by the public toggle
  const lede = el('p', { className: 'lede' });
  const wrap = el('div', { className: 'config' });
  wrap.append(
    el('h2', { text: 'Connect Workspace' }),
    lede,
  );

  // --- connection form (prefilled when editing an existing connection) ---
  const region = field('text', 'us-east-1', existing?.region ?? 'us-east-1');
  const bucket = field('text', 'my-service-logs', existing?.bucket ?? '');
  const prefix = field('text', 'logs/  (optional)', existing?.prefix ?? '');
  const accessKey = revealField('AKIA…', existing?.accessKeyId ?? '');
  const secretKey = revealField('', existing?.secretAccessKey ?? '');
  const sessionToken = revealField('(optional)', existing?.sessionToken ?? '');

  // ON = authenticated (private bucket); OFF = public/anonymous
  const authToggle = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
  authToggle.checked = !(existing?.public ?? false);
  const authSwitch = el('label', { className: 'switch' }, [
    authToggle,
    el('span', { className: 'slider' }),
  ]);

  // auth fields live in their own block (display:contents so the label/field
  // pairs still align in the form grid) so the toggle can hide them
  const authBlock = el('div', { className: 'config-auth' }, [
    label('Access key ID'), accessKey.wrap,
    label('Secret access key'), secretKey.wrap,
    label('Session token'), sessionToken.wrap,
  ]);
  const publicHint = el('div', { className: 'full public-hint' });
  publicHint.innerHTML =
    '<strong>Public Bucket:</strong><br>Readable anonymously. ' +
    'No credentials are entered, stored, or sent.';

  // an honest disclosure, not an opt-in: the connection is always saved to
  // this browser so the workspace survives reloads and subdomain hops
  const syncAuth = (): void => {
    const authed = authToggle.checked;
    authBlock.style.display = authed ? 'contents' : 'none';
    publicHint.style.display = authed ? 'none' : 'block';
    lede.textContent = authed
      ? 'A workspace reads one tracelog bucket. Credentials are sent only to AWS ' +
        'as request signatures, never anywhere else — but they are saved in ' +
        'this browser’s localStorage, in plain text, so the workspace stays ' +
        'connected across reloads. Anyone with access to this device can read them' +
        // the Purge button only exists once a connection has been saved
        (existing ? '; “Purge” below removes everything.' : '.')
      : 'A workspace reads one tracelog bucket. This one is public, so no ' +
        'credentials are entered, stored, or sent — only the bucket location ' +
        'is saved in this browser.';
  };
  authToggle.addEventListener('change', syncAuth);

  const form = el('form', {}, [
    label('Workspace'),
    el('div', { className: 'workspace-fixed' }, [
      el('span', { className: 'mono', text: hereLabel }),
      ctx.apexHost
        ? el('span', { className: 'field-note', text: 'this workspace’s own browser storage' })
        : el('span'),
    ]),
    label('Region'), region,
    label('Bucket'), bucket,
    label('Prefix'), prefix,
    label('Authentication'), authSwitch,
    authBlock,
    publicHint,
    el('div', { className: 'full actions' }, [
      el('button', {
        className: 'btn btn-primary',
        text: existing ? 'Save' : 'Save & connect',
        attrs: { type: 'submit' },
      }),
    ]),
  ]);
  syncAuth();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const pub = !authToggle.checked;
    const profile: Profile = {
      region: region.value.trim() || 'us-east-1',
      bucket: bucket.value.trim(),
      prefix: prefix.value.trim() || undefined,
      public: pub || undefined,
      // public → no credentials are kept (cleared from storage on save)
      accessKeyId: pub ? '' : accessKey.input.value.trim(),
      secretAccessKey: pub ? '' : secretKey.input.value.trim(),
      sessionToken: pub ? undefined : sessionToken.input.value.trim() || undefined,
      subdomain: ctx.current || undefined,
    };
    if (!profile.bucket) return;
    if (!pub && (!profile.accessKeyId || !profile.secretAccessKey)) return;
    profiles.save(profile);
    // a workspace reached by direct navigation joins the directory now (the
    // bounce to the apex and back replaces onDone); the create flow already
    // recorded it, so that path skips this.
    if (recordCurrentWorkspaceIfNew('/overview')) return;
    onDone();
  });

  wrap.append(form);

  // --- local data: an obvious, total purge for this workspace ---
  if (existing) {
    wrap.append(
      el('div', { className: 'config-danger' }, [
        el('div', { className: 'form-label', text: 'Local data' }),
        el('p', {
          className: 'field-note',
          text:
            'Everything this workspace keeps lives only in this browser: the ' +
            'connection above, and the cached log files in IndexedDB. Purge ' +
            'wipes all of it and removes the workspace from your switcher.',
        }),
        el('button', {
          className: 'btn btn-danger',
          text: 'Purge this workspace’s data',
          attrs: { type: 'button' },
          on: { click: () => purge() },
        }),
      ]),
    );
  }

  function purge(): void {
    profiles.remove();
    clearLocalWorkspaceState();
    void cacheWipeAll();
    // drop from the directory (bounce to apex and back replaces this render);
    // on a single-origin host there's no directory, so just re-render
    if (ctx.current) {
      dropCurrentWorkspace('/about');
      return;
    }
    renderConfig(container, onDone);
  }

  container.append(wrap);
}

function label(text: string): HTMLElement {
  return el('div', { className: 'form-label', text });
}

function field(type: string, placeholder: string, value = ''): HTMLInputElement {
  const input = el('input', {
    className: 'input',
    attrs: { type, placeholder, autocomplete: 'off', spellcheck: 'false' },
  });
  input.value = value;
  return input;
}

const EYE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

/** A masked credential field that starts hidden, with an eyeball reveal. */
function revealField(placeholder: string, value = ''): { input: HTMLInputElement; wrap: HTMLElement } {
  const input = field('password', placeholder, value);
  const btn = el('button', {
    className: 'reveal-toggle',
    attrs: { type: 'button', 'aria-label': 'show', title: 'show' },
  });
  btn.innerHTML = EYE;
  let shown = false;
  btn.addEventListener('click', () => {
    shown = !shown;
    input.type = shown ? 'text' : 'password';
    btn.innerHTML = shown ? EYE_OFF : EYE;
    btn.title = shown ? 'hide' : 'show';
    btn.setAttribute('aria-label', shown ? 'hide' : 'show');
  });
  const wrap = el('div', { className: 'reveal-field' }, [input, btn]);
  return { input, wrap };
}
