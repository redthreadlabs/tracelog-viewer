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
  const region = field('text', 'us-east-1', existing?.region ?? 'us-east-1');
  const accessKey = field('text', 'AKIA…', existing?.accessKeyId ?? '');
  const secretKey = field('password', '', existing?.secretAccessKey ?? '');
  const sessionToken = field('password', '(optional)', existing?.sessionToken ?? '');

  const remember = el('input', { attrs: { type: 'checkbox' } });
  remember.checked = profiles.remembered;

  const form = el('form', {}, [
    label('Bucket'), bucket,
    label('Region'), region,
    label('Access key ID'), accessKey,
    label('Secret access key'), secretKey,
    label('Session token'), sessionToken,
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
      region: region.value.trim() || 'us-east-1',
      accessKeyId: accessKey.value.trim(),
      secretAccessKey: secretKey.value.trim(),
      sessionToken: sessionToken.value.trim() || undefined,
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
