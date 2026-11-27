// "What this yes costs" (#/cost). Where "Say yes anyway" lands. Nothing is saved until "Put it on my week".
// Every number is read from the same evaluated result as the verdict (analysis.numbers and analysis.bar).
import { weekdayName } from '../engine/dates.mjs';
import { getUi } from './check-session.mjs';
import { hoursPhrase } from './check-model.mjs';
import { h, setBlobTone, svg } from './dom.mjs';
import { hoursShort } from './numbers.mjs';
import { analysisForPending, renderBar, renderReplySlip } from './render-check.mjs';

/** The three plain lines, computed. The third appears only when another deadline is actually in the way. */
export function costLines({ analysis, state, derived, proposal }) {
  const { bar, numbers } = analysis;
  const free = bar ? bar.free : numbers?.available ?? 0;
  const dayName = bar?.dayName ?? numbers?.weekday ?? 'the deadline';
  const short = numbers ? numbers.short : 0;
  const lines = [];
  lines.push(short > 0
    ? `It uses all ${hoursShort(free)} of your free time until ${dayName}.`
    : `It uses ${hoursShort(proposal.likely)} of your ${hoursShort(free)} of free time until ${dayName}.`);
  lines.push(short > 0
    ? `Sleep stays protected (${state.sleep.start}-${state.sleep.end}), so the shortfall lands on the deadline.`
    : `Sleep stays protected (${state.sleep.start}-${state.sleep.end}).`);
  const others = derived.activeTasks.filter(task => task.id !== proposal.id && task.targetDay <= proposal.targetDay);
  if (others.length && (short > 0 || analysis.tight)) lines.push(`Anything else due before ${dayName} gets squeezed too.`);
  return lines;
}

export function renderCostScreen(container, ctx) {
  const { state, derived, dispatch } = ctx;
  const proposal = state.proposals[0] ?? null;
  const analysis = proposal ? analysisForPending({ state, derived }) : null;
  if (!proposal || !analysis || !analysis.numbers) {
    // Nothing is being decided: never show an empty page.
    container.replaceChildren();
    queueMicrotask(() => dispatch({ type: 'NAVIGATE', screen: 'home' }));
    return;
  }
  setBlobTone(analysis.fits ? 'sage' : 'coral');
  const rerender = () => renderCostScreen(container, ctx);
  const { numbers } = analysis;
  const short = numbers.short;
  const headline = short > 0
    ? `${hoursPhrase(short)} short by ${numbers.weekday}.`
    : `It fits, with ${hoursPhrase(numbers.spare)} to spare.`;
  const ui = getUi(proposal.id);
  const forOthers = proposal.audience !== 'self';

  const parts = [
    h('div', { className: 'result-top' },
      h('button', {
        type: 'button', id: 'cost-back', className: 'back-link',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      },
        svg('svg', { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
          svg('path', { d: 'M11 3L5 9l6 6', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
        'The answer')),
    h('header', { className: 'vhero vhero-cost' },
      h('div', { className: `eyebrow vhero-eyebrow` }, 'WHAT THIS YES COSTS'),
      h('h1', { id: 'cost-headline', className: 'vhero-title cost-title', tabindex: '-1' }, headline),
      h('ul', { id: 'cost-lines', className: 'cost-lines' }, costLines({ analysis, state, derived, proposal }).map(text => h('li', {}, text))))
  ];

  const bar = renderBar({ analysis, animate: false });
  const layout = [];
  if (bar) layout.push(bar);
  if (short > 0 || analysis.tight) {
    const option = analysis.option;
    layout.push(h('section', { id: 'cost-close', className: 'cost-close' },
      h('h2', { className: 'section-title' }, 'To close the gap'),
      option
        ? h('p', { id: 'cost-option', className: 'option-body' },
            `${option.label}. `,
            option.needsApproval ? 'Someone else has to say yes first.' : 'You can do this yourself.')
        : h('p', { id: 'cost-ask', className: 'option-body' },
            `Ask for ${hoursShort(Math.max(short, 0.5))} more time, or offer a smaller version.`)));
    if (forOthers) layout.push(renderReplySlip({ analysis, proposal, state, ui, rerender }));
  }
  layout.push(h('div', { className: 'cost-actions' },
    h('button', {
      type: 'button', id: 'cost-put', className: 'button button-primary button-large',
      onClick: () => dispatch({
        type: 'ACCEPT_PROPOSAL', proposalIds: [proposal.id], mode: analysis.fits ? 'accept' : 'override', thenScreen: 'week'
      })
    }, 'Put it on my week'),
    h('button', {
      type: 'button', id: 'cost-never', className: 'link-button center',
      onClick: () => dispatch({ type: 'DISCARD_PROPOSAL', proposalIds: [proposal.id], thenScreen: 'home' })
    }, 'Never mind'),
    h('p', { className: 'decision-help' }, 'Nothing is saved until you choose. It never takes sleep.')));
  parts.push(h('div', { className: 'check-layout' }, layout));
  container.replaceChildren(...parts);
  for (const area of container.querySelectorAll('.reply-text')) {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }
  document.getElementById('cost-headline')?.focus({ preventScroll: true });
}
