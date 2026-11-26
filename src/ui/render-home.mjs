import { conflictClause, dayLabel, hoursPhrase } from './check-model.mjs';
import { deadlineCost } from '../engine/evaluate.mjs';
import { h } from './dom.mjs';
import { isSetUp } from './state.mjs';

/**
 * One observation about the loaded week, computed from engine output only.
 * Returns { text, atRisk } where atRisk names the first deadline in trouble.
 */
export function observeWeek(state, derived) {
  const { evaluation } = derived;
  const exampleNote = state.demo ? ' (example data)' : '';
  const typicalCost = deadlineCost(evaluation.typical, state.days);
  if (!derived.activeTasks.length || !typicalCost) {
    return { text: `Nothing is due in the weeks loaded${exampleNote}.`, atRisk: null };
  }
  if (!evaluation.typical.feasible) {
    const clause = conflictClause(evaluation.typical, state.days);
    const due = clause?.date ? dayLabel(clause.date) : dayLabel(typicalCost.date);
    return {
      text: clause
        ? `Your week is already ${clause.kind === 'hours' ? clause.text : `${clause.text}`}${exampleNote}.`
        : `A deadline is already out of reach${exampleNote}.`,
      atRisk: { date: clause?.date ?? typicalCost.date, label: due, kind: 'short' }
    };
  }
  if (evaluation.verdict === 'at-risk') {
    return {
      text: `Everything fits, but ${dayLabel(typicalCost.date)} has only ${hoursPhrase(Math.max(0, typicalCost.marginHours))} to spare${exampleNote}.`,
      atRisk: { date: typicalCost.date, label: dayLabel(typicalCost.date), kind: 'tight' }
    };
  }
  return {
    text: `Everything fits. Your tightest day, ${dayLabel(typicalCost.date)}, has ${hoursPhrase(Math.max(0, typicalCost.marginHours))} to spare${exampleNote}.`,
    atRisk: null
  };
}

function renderExampleControls(state, dispatch) {
  return h('details', { className: 'quiet-details', id: 'example-data' },
    h('summary', {}, 'Example data'),
    h('p', { className: 'section-help' },
      'This is a sample week, not yours. Switch examples, or leave and go back to your own week.'),
    h('div', { className: 'section-actions' },
      h('button', {
        type: 'button',
        className: `button ${!state.fixed ? 'button-secondary' : 'button-quiet'}`,
        'aria-pressed': String(!state.fixed),
        onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
      }, 'Sample week A (some deadlines can slide)'),
      h('button', {
        type: 'button',
        className: `button ${state.fixed ? 'button-secondary' : 'button-quiet'}`,
        'aria-pressed': String(state.fixed),
        onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: true })
      }, 'Sample week B (all deadlines fixed)'),
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({
          type: 'UPDATE_DEMO_RESEARCH',
          includeResearch: !state.includeResearch,
          researchHours: state.researchHours
        })
      }, state.includeResearch ? 'Take the sample research project out' : 'Put the sample research project back'),
      h('button', {
        type: 'button', id: 'home-leave-example',
        className: 'link-button',
        onClick: () => dispatch({ type: 'LEAVE_DEMO' })
      }, state.personalBackup ? 'Leave example, back to my week' : 'Leave example')
    )
  );
}

export function renderHomeScreen(container, { state, derived, dispatch }) {
  const name = (state.displayName ?? '').trim();
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const greeting = name ? `${hello}, ${name}.` : `${hello}.`;

  if (!state.demo && !isSetUp(state)) {
    container.replaceChildren(
      h('header', { className: 'screen-intro home-intro' },
        h('p', { className: 'eyebrow' }, greeting),
        h('h1', { className: 'screen-title' }, 'Someone asks for one more thing. Let\'s see if it fits.'),
        h('p', { className: 'screen-lede' },
          'First, tell me about your week: when you work, and what\'s fixed. It stays in this browser.')
      ),
      h('div', { className: 'home-actions' },
        h('button', {
          type: 'button', id: 'home-setup',
          className: 'button button-primary button-large',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
        }, 'Set up my week'),
        h('button', {
          type: 'button', id: 'home-example',
          className: 'link-button',
          onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
        }, 'Try an example')
      )
    );
    return;
  }

  const observation = observeWeek(state, derived);
  container.replaceChildren(
    h('header', { className: 'screen-intro home-intro' },
      h('p', { className: 'eyebrow' }, greeting),
      h('h1', { id: 'home-observation', className: 'home-observation' }, observation.text),
      observation.atRisk
        ? h('button', {
            type: 'button', id: 'home-reset',
            className: 'link-button',
            onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
          }, 'See what can move')
        : null
    ),
    h('div', { className: 'home-actions' },
      h('button', {
        type: 'button', id: 'home-check',
        className: 'button button-primary button-large',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      }, 'Check a request'),
      h('button', {
        type: 'button', id: 'home-week',
        className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, 'View my week')
    ),
    state.demo
      ? renderExampleControls(state, dispatch)
      : h('button', {
          type: 'button', id: 'home-example', className: 'link-button home-example-link',
          onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
        }, 'Try an example week')
  );
}
