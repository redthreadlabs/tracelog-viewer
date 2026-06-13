/**
 * Credentials / profiles panel (SPEC §6.0, §4).
 */
import { el, clear } from './dom';
import { profiles, type Profile } from './profiles';
import { cacheWipeBucket } from '../data/cache';
import { workspaceContext, dropCurrentWorkspace, recordCurrentWorkspaceIfNew } from '../data/workspaces';

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
                // Last profile gone → this workspace leaves the directory.
                // The bounce to the apex and back replaces this render.
                if (profiles.list().length === 0 && workspaceContext().current) {
                  dropCurrentWorkspace('/config');
                  return;
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

  // The workspace is *where you are* — this origin. You can't create a
  // profile for another subdomain from here (its storage is siloed); use
  // the switcher's "New workspace", which takes you there first.
  // config only renders on a subdomain (the apex isn't a workspace) or on
  // localhost/self-host single-origin
  const ctx = workspaceContext();
  const hereLabel = ctx.current && ctx.apexHost ? `${ctx.current}.${ctx.apexHost}` : 'this device';

  // --- new profile form ---
  // most people want the profile named after the workspace, so prefill it
  const name = field('text', 'prod', ctx.current || '');
  const bucket = field('text', 'my-service-logs');
  const region = field('text', 'us-east-1', 'us-east-1');
  const accessKey = field('text', 'AKIA…');
  const secretKey = field('password', '');
  const sessionToken = field('password', '(optional)');

  const remember = el('input', { attrs: { type: 'checkbox' } });
  remember.checked = profiles.remembered;

  const form = el('form', {}, [
    label('Profile name'), name,
    el('div', { className: 'full' }, [
      el('span', {
        className: 'field-note',
        text: 'Just the display name shown in the workspace switcher — yours to choose.',
      }),
    ]),
    label('Bucket'), bucket,
    label('Region'), region,
    label('Access key ID'), accessKey,
    label('Secret access key'), secretKey,
    label('Session token'), sessionToken,
    label('Workspace'),
    el('div', { className: 'workspace-fixed' }, [
      el('span', { className: 'mono', text: hereLabel }),
      ctx.apexHost
        ? el('span', { className: 'field-note', text: 'this profile is saved in this workspace' })
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
      el('button', {
        className: 'btn btn-primary',
        text: 'Save & connect',
        attrs: { type: 'submit' },
      }),
    ]),
  ]);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const profile: Profile = {
      name: name.value.trim() || 'default',
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
