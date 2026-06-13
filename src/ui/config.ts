/**
 * Credentials / profiles panel (SPEC §6.0, §4).
 */
import { el, clear } from './dom';
import { profiles, type Profile } from './profiles';
import { cacheWipeBucket } from '../data/cache';
import { workspaces, workspaceContext } from '../data/workspaces';

export function renderConfig(container: HTMLElement, onDone: () => void): void {
  clear(container);

  const wrap = el('div', { className: 'config' });
  wrap.append(
    el('h2', { text: 'Profiles' }),
    el('p', {
      className: 'lede',
      text:
        'A profile is a read-only key for one tracelog bucket. Credentials stay in ' +
        'this tab’s memory and are sent only to AWS, as request signatures — ' +
        'never anywhere else.',
    }),
  );

  // --- existing profiles ---
  const existing = profiles.list();
  if (existing.length > 0) {
    const list = el('ul', { className: 'profile-list' });
    for (const p of existing) {
      const isActive = profiles.active()?.name === p.name;
      list.append(
        el('li', {}, [
          el('span', { className: 'name', text: p.name }),
          el('span', { className: 'detail', text: `s3://${p.bucket} · ${p.region}` }),
          el('button', {
            className: isActive ? 'btn btn-primary' : 'btn',
            text: isActive ? 'active' : 'use',
            on: {
              click: () => {
                profiles.setActive(p.name);
                onDone();
              },
            },
          }),
          el('button', {
            className: 'btn-quiet btn',
            text: '✕',
            title: 'delete profile',
            on: {
              click: () => {
                profiles.remove(p.name);
                // Deleting credentials reads as "done with this world": drop
                // the bucket's cached files too — unless another profile
                // still points at the same bucket.
                if (!profiles.list().some((other) => other.bucket === p.bucket)) {
                  void cacheWipeBucket(p.bucket);
                }
                renderConfig(container, onDone);
              },
            },
          }),
        ]),
      );
    }
    wrap.append(list, el('div', { attrs: { style: 'height:26px' } }));
  }

  // --- new profile form ---
  const name = field('text', 'prod');
  const bucket = field('text', 'my-service-logs');
  const region = field('text', 'us-east-1', 'us-east-1');
  const accessKey = field('text', 'AKIA…');
  const secretKey = field('password', '');
  const sessionToken = field('password', '(optional)');

  // the workspace this profile belongs to — defaults to the current
  // subdomain, registered in the shared directory so the switcher finds it
  const ctx = workspaceContext();
  const workspace = field('text', ctx.apexHost ? `name.${ctx.apexHost}` : 'a label', ctx.current);

  const remember = el('input', { attrs: { type: 'checkbox' } });
  remember.checked = profiles.remembered;

  const form = el('form', {}, [
    label('Profile name'), name,
    label('Bucket'), bucket,
    label('Region'), region,
    label('Access key ID'), accessKey,
    label('Secret access key'), secretKey,
    label('Session token'), sessionToken,
    label('Workspace'), workspace,
    el('div', { className: 'full' }, [
      el('span', {
        className: 'field-note',
        text:
          'A workspace is a subdomain — ' +
          (ctx.apexHost ? `e.g. acme.${ctx.apexHost}` : 'e.g. acme') +
          '. Each keeps its own profiles and cache; the switcher up top hops ' +
          'between the ones you’ve set up. Leave blank for the home workspace.',
      }),
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
      el('button', {
        className: 'btn btn-primary',
        text: 'Save & connect',
        attrs: { type: 'submit' },
      }),
    ]),
  ]);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const sub = workspace.value.trim().replace(/^\.+|\.+$/g, '');
    const profile: Profile = {
      name: name.value.trim() || 'default',
      bucket: bucket.value.trim(),
      region: region.value.trim() || 'us-east-1',
      accessKeyId: accessKey.value.trim(),
      secretAccessKey: secretKey.value.trim(),
      sessionToken: sessionToken.value.trim() || undefined,
      subdomain: sub || undefined,
    };
    if (!profile.bucket || !profile.accessKeyId || !profile.secretAccessKey) return;
    profiles.setRemembered(remember.checked);
    profiles.save(profile);
    // publish the workspace name to the shared directory (apex bridge), so
    // it appears in the switcher from every subdomain
    if (sub) void workspaces.add(sub);
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
