import { copyToClipboard, h } from './dom.mjs';

/**
 * Copy controls shared by every reply slip. Copying only writes text to the
 * clipboard: it never touches the store, so it cannot accept a request, record an
 * approval, apply a repair or send anything.
 */
export function makeCopyControls(getText, label = 'Copy reply') {
  const status = h('span', { id: 'copy-status', className: 'copy-status', role: 'status', 'aria-live': 'polite' });
  let timer = null;
  const button = h('button', {
    type: 'button',
    id: 'copy-reply',
    className: 'button button-primary',
    onClick: async () => {
      const ok = await copyToClipboard(getText());
      status.textContent = ok ? 'Copied' : "Couldn't copy. Select the text and copy it yourself.";
      clearTimeout(timer);
      timer = setTimeout(() => { status.textContent = ''; }, 3000);
    }
  }, label);
  return { button, status };
}
