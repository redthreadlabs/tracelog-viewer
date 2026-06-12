/**
 * Credentials / profiles panel (SPEC §6.0, §4).
 */
import { el, clear } from './dom';
import { profiles, type Profile } from './profiles';

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
  const name = field('text', 'prod', existing.length === 0 ? 'duiduidui-prod' : '');
  const bucket = field('text', 'duiduidui-prod-logs', existing.length === 0 ? 'duiduidui-prod-logs' : '');
  const region = field('text', 'us-east-1', 'us-east-1');
  const accessKey = field('text', 'AKIA…');
  const secretKey = field('password', '');
  const sessionToken = field('password', '(optional)');

  const remember = el('input', { attrs: { type: 'checkbox' } });
  remember.checked = profiles.remembered;

  const form = el('form', {}, [
    label('Profile name'), name,
    label('Bucket'), bucket,
    label('Region'), region,
    label('Access key ID'), accessKey,
    label('Secret access key'), secretKey,
    label('Session token'), sessionToken,
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
    };
    if (!profile.bucket || !profile.accessKeyId || !profile.secretAccessKey) return;
    profiles.setRemembered(remember.checked);
    profiles.save(profile);
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
