/**
 * New-workspace modal (shared by the switcher and the About CTAs): name the
 * subdomain, then bounce through the apex — which records it — to that
 * subdomain's config to enter credentials. A workspace is always a
 * subdomain; there is no apex/home workspace.
 */
import { el } from './dom';
import { workspaceContext, createWorkspace, validLabel } from '../data/workspaces';

export function openNewWorkspace(): void {
  const ctx = workspaceContext();
  const overlay = el('div', { className: 'modal-overlay' });
  const input = el('input', {
    className: 'input',
    attrs: { type: 'text', placeholder: 'e.g. acme', autocomplete: 'off', spellcheck: 'false' },
  }) as HTMLInputElement;
  const err = el('div', { className: 'field-note', attrs: { style: 'color:var(--level-error)' } });
  const close = (): void => overlay.remove();

  const submit = (): void => {
    const label = input.value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!validLabel(label)) {
      err.textContent = 'Letters, numbers, and hyphens only.';
      return;
    }
    createWorkspace(label); // → apex records it → lands on its config
  };

  const card = el('div', { className: 'modal-card about-panel' }, [
    el('h2', { text: 'New workspace' }),
    el('div', { className: 'modal-row' }, [
      input,
      ctx.apexHost ? el('span', { className: 'modal-suffix', text: `.${ctx.apexHost}` }) : el('span'),
    ]),
    err,
    el('p', {
      className: 'field-note',
      attrs: { style: 'margin-top:10px' },
      text: 'A workspace is just a subdomain. It can literally be anything you want.',
    }),
    el('p', {
      className: 'field-note',
      text:
        'Nothing is provisioned: no DNS record is created, no cloud service ' +
        'is involved, no account is registered anywhere.',
    }),
    el('p', {
      className: 'field-note',
    }, [
      el('span', {
        text: 'This site serves the exact same pages to every subdomain, but ',
      }),
      el('strong', { attrs: { style: 'font-style:italic' }, text: 'your browser' }),
      el('span', {
        text:
          ' uses separate storage per subdomain, so each of your workspaces ' +
          'gets its own storage and memory sandbox.',
      }),
    ]),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', text: 'Cancel', on: { click: close } }),
      el('button', { className: 'btn btn-primary', text: 'Continue', on: { click: submit } }),
    ]),
  ]);
  overlay.append(card);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
    if (ev.key === 'Escape') close();
  });
  document.body.append(overlay);
  input.focus();
}
