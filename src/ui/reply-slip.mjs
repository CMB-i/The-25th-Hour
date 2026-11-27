import { copyToClipboard, h } from './dom.mjs';

/**
 * Copy controls shared by every reply slip. Copying only writes text to the
 * clipboard: it never touches the store, so it cannot accept a request, record an
 * approval, apply a repair or send anything.
 */
export function makeCopyControls(getText, label = 'Copy reply', copiedLabel = 'Copied. Go send it.') {
  // A quiet live region announces the result; the button label changes for everyone.
  const status = h('span', { id: 'copy-status', className: 'sr-only', role: 'status', 'aria-live': 'polite' });
  let timer = null;
  const button = h('button', { type: 'button', id: 'copy-reply', className: 'button button-sage' }, label);
  button.addEventListener('click', async () => {
    const ok = await copyToClipboard(getText());
    button.textContent = ok ? copiedLabel : "Couldn't copy. Select the text and copy it yourself.";
    status.textContent = ok ? 'Copied' : "Couldn't copy";
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = label; status.textContent = ''; }, 3500);
  });
  return { button, status };
}
