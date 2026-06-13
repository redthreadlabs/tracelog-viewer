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
    attrs: {
      type: 'text',
      placeholder: 'subdomain',
      autocomplete: 'off',
      spellcheck: 'false',
      style: 'text-align:center',
    },
  }) as HTMLInputElement;
  const err = el('div', { className: 'field-note', attrs: { style: 'color:var(--level-error)' } });
  const cont = el('button', { className: 'btn btn-primary', text: 'Continue' }) as HTMLButtonElement;
  const close = (): void => overlay.remove();

  const normalized = (): string => input.value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');

  /** Live feedback: flag stray characters as typed; gate Continue on validity. */
  const validate = (): void => {
    const raw = input.value.trim();
    // only nag about disallowed *characters* while typing — structural
    // issues (empty, leading/trailing hyphen) just keep Continue disabled
    err.textContent = /[^a-z0-9.-]/i.test(raw) ? 'Letters, numbers, and hyphens only.' : '';
    cont.disabled = !validLabel(normalized());
  };

  const submit = (): void => {
    const label = normalized();
    if (!validLabel(label)) return;
    createWorkspace(label); // → apex records it → lands on its config
  };

  input.addEventListener('input', validate);

  const card = el('div', { className: 'modal-card about-panel' }, [
    el('h2', {
      text: 'New Workspace',
      attrs: { style: 'text-align:center;font-style:italic' },
    }),
    el('div', { className: 'modal-row', attrs: { style: 'margin:22px 0' } }, [
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
      cont,
    ]),
  ]);
  cont.addEventListener('click', submit);
  overlay.append(card);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
    if (ev.key === 'Escape') close();
  });
  document.body.append(overlay);
  validate(); // start with Continue disabled until a valid label is entered
  input.focus();
}
