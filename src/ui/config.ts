/**
 * Connect this workspace (SPEC §6.0, §4). One workspace, one bucket: the
 * subdomain is the namespace, so there's no profile name — just credentials
 * for the bucket this workspace reads. The form prefills from an existing
 * connection (editing); "Delete & Purge" wipes everything this origin stores.
 */
import { el, clear } from './dom';
import { profiles, type Profile } from './profiles';
import { cacheWipeAll } from '../data/cache';
import {
  workspaceContext,
  knownWorkspaces,
  purgeAndLeave,
  recordCurrentWorkspaceIfNew,
  clearLocalWorkspaceState,
} from '../data/workspaces';

export function renderConfig(container: HTMLElement, onDone: () => void, flash = ''): void {
  clear(container);

  // config only renders on a subdomain (the apex isn't a workspace) or on
  // localhost/self-host single-origin
  const ctx = workspaceContext();
  const hereLabel = ctx.current && ctx.apexHost ? `${ctx.current}.${ctx.apexHost}` : 'this device';
  const existing = profiles.active();

  // the lede carries the disclosure + warning, updated by the public toggle.
  // the headline + lede live at the top of the panel itself (added to the
  // form below), so the whole thing reads as one card.
  const lede = el('p', { className: 'lede' });
  const wrap = el('div', { className: 'config' });

  // --- connection form (prefilled when editing an existing connection) ---
  const region = field('text', 'us-east-1', existing?.region ?? 'us-east-1');
  const bucket = field('text', 'my-service-logs', existing?.bucket ?? '');
  const prefix = field('text', 'logs/  (optional)', existing?.prefix ?? '');
  const accessKey = revealField('AKIA…', existing?.accessKeyId ?? '');
  const secretKey = revealField('', existing?.secretAccessKey ?? '');
  const sessionToken = revealField('(optional)', existing?.sessionToken ?? '');

  // limits, in MB — defaulted on a new connection, editable, blank = none.
  // (existing connection with the field cleared = no limit, hence the
  // null-coalescing only applies its default when there's no profile yet.)
  const limitValue = (mb: number | undefined, dflt: number): string =>
    existing ? (mb != null ? String(mb) : '') : String(dflt);
  const memLimit = field('text', 'blank = no limit', limitValue(existing?.memoryLimitMb, 256));
  const cacheLimit = field('text', 'blank = no limit', limitValue(existing?.cacheLimitMb, 1024));
  const memErr = el('div', { className: 'field-error' });
  const cacheErr = el('div', { className: 'field-error' });

  // Save gates on the two limit fields being valid (blank, or a positive
  // number). Friendly: flag the bad field inline, disable Save until fixed.
  const saveBtn = el('button', {
    className: 'btn btn-primary',
    text: existing ? 'Save' : 'Save & connect',
    attrs: { type: 'submit' },
  }) as HTMLButtonElement;
  const validate = (): void => {
    memErr.textContent = limitError(memLimit.value);
    cacheErr.textContent = limitError(cacheLimit.value);
    saveBtn.disabled = !!(memErr.textContent || cacheErr.textContent);
  };
  memLimit.addEventListener('input', validate);
  cacheLimit.addEventListener('input', validate);

  // feedback line for purge (and any flash passed into this render)
  const purgeMsg = el('div', { className: 'field-note', attrs: { style: 'text-align:right' } });

  // ON = authenticated (private bucket); OFF = public/anonymous
  const authToggle = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
  authToggle.checked = !(existing?.public ?? false);
  const authSwitch = el('label', { className: 'switch' }, [
    authToggle,
    el('span', { className: 'slider' }),
  ]);

  // auth fields live in their own block so the toggle can show/hide them as a
  // group (they fill the right-hand column)
  const authBlock = el('div', { className: 'config-auth' }, [
    row('Access key ID', accessKey.wrap),
    row('Secret access key', secretKey.wrap),
    row('Session token', sessionToken.wrap),
  ]);
  const publicHint = el('div', { className: 'public-hint' });
  publicHint.innerHTML =
    '<strong>Public Bucket:</strong><br>Readable anonymously. ' +
    'No credentials are entered, stored, or sent.';

  // an honest disclosure, not an opt-in: the connection is always saved to
  // this browser so the workspace survives reloads and subdomain hops
  const syncAuth = (): void => {
    const authed = authToggle.checked;
    authBlock.style.display = authed ? 'flex' : 'none';
    publicHint.style.display = authed ? 'none' : 'block';
    clear(lede);
    if (authed) {
      lede.append(
        'A workspace reads a single tracelog bucket. Your credentials are used ' +
          'only to sign requests to AWS. But to stay connected, this workspace ' +
          'keeps them as plain text in your browser’s ',
        em('localStorage'),
        '. The log files themselves are copied from your S3 bucket and cached ' +
          'in your browser’s ',
        em('IndexedDB'),
        '. Anyone with access to this device can read all of it, so use ',
        em('Delete & Purge'),
        ' to wipe it clean.',
      );
    } else {
      lede.append(
        'A workspace reads a single tracelog bucket. This one is ',
        em('public'),
        ', so there are no credentials to enter, store, or send. The log files ' +
          'are still copied from your S3 bucket and cached in your browser’s ',
        em('IndexedDB'),
        '. ',
        em('Delete & Purge'),
        ' clears them.',
      );
    }
    lede.append(
      ' The ',
      em('memory and cache limits'),
      ' cap the working set held in memory and the log files cached on disk. ' +
        'Leave either blank for no limit.',
    );
  };
  authToggle.addEventListener('change', syncAuth);

  const form = el('form', {}, [
    el('h2', { text: existing ? 'Edit Workspace Configuration' : 'Connect Workspace' }),
    lede,
    el('div', { className: 'config-cols' }, [
      // left column: where the bucket is, plus the on-device limits
      el('div', { className: 'config-col' }, [
        row(
          'Workspace',
          el('div', { className: 'workspace-fixed' }, [
            el('span', { className: 'mono', text: hereLabel }),
            ctx.apexHost
              ? el('span', { className: 'field-note', text: 'this workspace’s own browser storage' })
              : el('span'),
          ]),
        ),
        row('Region', region),
        row('Bucket', bucket),
        row('Prefix', prefix),
        row('Memory limit', withNote(withUnit(memLimit, 'MB'), memErr)),
        row('Cache limit', withNote(withUnit(cacheLimit, 'MB'), cacheErr)),
      ]),
      // right column: how to authenticate to it
      el('div', { className: 'config-col' }, [
        el('div', { className: 'auth-head' }, [label('Authentication'), authSwitch]),
        authBlock,
        publicHint,
      ]),
    ]),
    el('div', { className: 'actions' }, [
      el('button', {
        className: 'btn btn-danger',
        text: 'Delete & Purge',
        attrs: { type: 'button', title: 'wipe this workspace’s connection and cached files' },
        on: { click: () => purge() },
      }),
      // editing an existing workspace: Cancel just goes back where you came from
      ...(existing
        ? [
            el('button', {
              className: 'btn btn-quiet',
              text: 'Cancel',
              attrs: { type: 'button' },
              on: { click: () => globalThis.history.back() },
            }),
          ]
        : []),
      saveBtn,
    ]),
    purgeMsg,
  ]);
  syncAuth();
  validate();
  if (flash) purgeMsg.textContent = flash;

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    validate();
    if (saveBtn.disabled) return; // invalid limit field — Save is gated
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
      memoryLimitMb: parseLimit(memLimit.value),
      cacheLimitMb: parseLimit(cacheLimit.value),
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

  function purge(): void {
    const hadData = !!profiles.active() || (!!ctx.current && knownWorkspaces().includes(ctx.current));
    profiles.remove();
    clearLocalWorkspaceState();
    void cacheWipeAll();
    if (!hadData) {
      purgeMsg.textContent = 'No data to purge in this workspace.';
      return;
    }
    // there was data: on a real workspace, drop it from the directory and
    // kick to the apex launcher with a confirmation; on a single-origin
    // host (no apex) just re-render with the confirmation
    if (ctx.current) {
      purgeAndLeave(ctx.current);
      return;
    }
    renderConfig(container, onDone, 'Workspace data purged.');
  }

  container.append(wrap);
}

function label(text: string): HTMLElement {
  return el('div', { className: 'form-label', text });
}

/** One stacked column row: a label above its control. */
function row(labelText: string, control: HTMLElement): HTMLElement {
  return el('div', { className: 'field-row' }, [label(labelText), control]);
}

/** A semibold-emphasized phrase for the lede prose. */
function em(text: string): HTMLElement {
  return el('strong', { className: 'em', text });
}

function field(type: string, placeholder: string, value = ''): HTMLInputElement {
  const input = el('input', {
    className: 'input',
    attrs: { type, placeholder, autocomplete: 'off', spellcheck: 'false' },
  });
  input.value = value;
  return input;
}

/** Wrap an input with a trailing unit chip (e.g. "MB"). */
function withUnit(input: HTMLInputElement, unit: string): HTMLElement {
  return el('div', { className: 'unit-field' }, [input, el('span', { className: 'unit', text: unit })]);
}

/** Stack a control over its (initially empty) inline error note. */
function withNote(control: HTMLElement, note: HTMLElement): HTMLElement {
  return el('div', { className: 'field-cell' }, [control, note]);
}

/** A clean positive number, or blank — anything else is rejected (stricter
 *  than parseLimit's parseFloat, which would silently accept "100abc"). */
const LIMIT_RE = /^\d+(\.\d+)?$/;

/** Validation message for a limit field, or '' when it's acceptable. */
function limitError(raw: string): string {
  const t = raw.trim();
  if (t === '') return ''; // blank = no limit
  if (!LIMIT_RE.test(t) || parseFloat(t) <= 0) {
    return 'Enter a positive number, or leave blank for no limit.';
  }
  return '';
}

/** Parse a limit input: a positive number of MB, or undefined (no limit). */
function parseLimit(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '' || !LIMIT_RE.test(t)) return undefined;
  const n = parseFloat(t);
  return n > 0 ? n : undefined;
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
