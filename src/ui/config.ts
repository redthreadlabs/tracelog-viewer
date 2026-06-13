/**
 * Connect this workspace (SPEC §6.0, §4). One workspace, one bucket: the
 * subdomain is the namespace, so there's no profile name — just credentials
 * for the bucket this workspace reads. The form prefills from an existing
 * connection (editing), and Disconnect drops it.
 */
import { el, clear } from './dom';
import { profiles, type Profile } from './profiles';
import { cacheWipeBucket } from '../data/cache';
import { workspaceContext, dropCurrentWorkspace, recordCurrentWorkspaceIfNew } from '../data/workspaces';

export function renderConfig(container: HTMLElement, onDone: () => void): void {
  clear(container);

  // config only renders on a subdomain (the apex isn't a workspace) or on
  // localhost/self-host single-origin
  const ctx = workspaceContext();
  const hereLabel = ctx.current && ctx.apexHost ? `${ctx.current}.${ctx.apexHost}` : 'this device';
  const existing = profiles.active();

  const wrap = el('div', { className: 'config' });
  wrap.append(
    el('h2', { text: existing ? `Reconnect ${hereLabel}` : `Connect ${hereLabel}` }),
    el('p', {
      className: 'lede',
      text:
        'A workspace reads one tracelog bucket with a read-only key. Credentials ' +
        'stay in this tab’s memory and are sent only to AWS, as request ' +
        'signatures — never anywhere else.',
    }),
  );

  // --- connection form (prefilled when editing an existing connection) ---
  const bucket = field('text', 'my-service-logs', existing?.bucket ?? '');
  const prefix = field('text', 'logs/  (optional)', existing?.prefix ?? '');
  const region = field('text', 'us-east-1', existing?.region ?? 'us-east-1');
  const accessKey = revealField('AKIA…', existing?.accessKeyId ?? '');
  const secretKey = revealField('', existing?.secretAccessKey ?? '');
  const sessionToken = revealField('(optional)', existing?.sessionToken ?? '');

  const remember = el('input', { attrs: { type: 'checkbox' } });
  remember.checked = profiles.remembered;

  const form = el('form', {}, [
    label('Bucket'), bucket,
    label('Prefix'), prefix,
    el('div', { className: 'full' }, [
      el('span', {
        className: 'field-note',
        text:
          'Optional — set this only if your tracelog channels live under a key ' +
          'prefix rather than the bucket root (e.g. logs/ for logs/server/…).',
      }),
    ]),
    label('Region'), region,
    label('Access key ID'), accessKey.wrap,
    label('Secret access key'), secretKey.wrap,
    label('Session token'), sessionToken.wrap,
    label('Workspace'),
    el('div', { className: 'workspace-fixed' }, [
      el('span', { className: 'mono', text: hereLabel }),
      ctx.apexHost
        ? el('span', { className: 'field-note', text: 'this workspace’s own browser storage' })
        : el('span'),
    ]),
    el('div', { className: 'full' }, [
      el('label', { className: 'remember' }, [
        remember,
        el('span', {
          text:
            'Remember on this device — stores these credentials in this browser’s ' +
            'localStorage, in plain text. Only check this on a machine that is yours alone.',
        }),
      ]),
    ]),
    el('div', { className: 'full actions' }, [
      existing
        ? el('button', {
            className: 'btn btn-quiet',
            text: 'Disconnect',
            attrs: { type: 'button', title: 'forget this workspace’s credentials and cached files' },
            on: { click: () => disconnect() },
          })
        : el('span'),
      el('button', {
        className: 'btn btn-primary',
        text: existing ? 'Save' : 'Save & connect',
        attrs: { type: 'submit' },
      }),
    ]),
  ]);

  function disconnect(): void {
    const wiped = profiles.active()?.bucket;
    profiles.remove();
    if (wiped) void cacheWipeBucket(wiped);
    // a connected workspace leaves the directory when disconnected (the
    // bounce to the apex and back replaces this render)
    if (ctx.current) {
      dropCurrentWorkspace('/config');
      return;
    }
    renderConfig(container, onDone);
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const profile: Profile = {
      bucket: bucket.value.trim(),
      prefix: prefix.value.trim() || undefined,
      region: region.value.trim() || 'us-east-1',
      accessKeyId: accessKey.input.value.trim(),
      secretAccessKey: secretKey.input.value.trim(),
      sessionToken: sessionToken.input.value.trim() || undefined,
      subdomain: ctx.current || undefined,
    };
    if (!profile.bucket || !profile.accessKeyId || !profile.secretAccessKey) return;
    profiles.setRemembered(remember.checked);
    profiles.save(profile);
    // a workspace reached by direct navigation joins the directory now (the
    // bounce to the apex and back replaces onDone); the create flow already
    // recorded it, so that path skips this.
    if (recordCurrentWorkspaceIfNew('/overview')) return;
    onDone();
  });

  wrap.append(form);
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
