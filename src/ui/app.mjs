import { h } from './dom.mjs';
import { renderCheckScreen } from './render-check.mjs';
import { renderFeedbackScreen } from './render-feedback.mjs';
import { renderRescueScreen } from './render-rescue.mjs';
import { renderSettingsScreen } from './render-settings.mjs';
import { renderWeekScreen } from './render-week.mjs';
import { createStore } from './state.mjs';
import { VALID_SCREENS } from './storage.mjs';

const SCREEN_IDS = {
  week: 'screen-week',
  check: 'screen-check',
  rescue: 'screen-rescue',
  feedback: 'screen-feedback',
  settings: 'screen-settings'
};

const SCREEN_RENDERERS = {
  week: renderWeekScreen,
  check: renderCheckScreen,
  rescue: renderRescueScreen,
  feedback: renderFeedbackScreen,
  settings: renderSettingsScreen
};

function getBrowserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const el = id => document.getElementById(id);

const store = createStore({ storage: getBrowserStorage() });

function safeDispatch(action, { rethrow = false } = {}) {
  const errorBox = el('error-region');
  try {
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = '';
    }
    return store.dispatch(action);
  } catch (error) {
    if (rethrow) throw error;
    if (errorBox) {
      errorBox.textContent = error?.message || 'Unable to update the schedule.';
      errorBox.hidden = false;
    }
    return null;
  }
}

function render(state, derived) {
  const errorBox = el('error-region');
  try {
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = '';
    }

    const hero = el('hero-banner');
    if (hero) hero.hidden = state.screen !== 'week';
    const sleepPill = el('hero-sleep-pill');
    if (sleepPill) sleepPill.textContent = `${state.sleep.start}–${state.sleep.end}`;

    for (const tab of document.querySelectorAll('.nav-tab[data-screen]')) {
      const active = tab.dataset.screen === state.screen;
      tab.setAttribute('aria-current', active ? 'page' : 'false');
    }

    const status = el('status-region');
    if (status) {
      if (state.notice) {
        status.replaceChildren(
          h('span', {}, state.notice),
          h('button', {
            type: 'button',
            className: 'button button-quiet button-sm',
            onClick: () => safeDispatch({ type: 'SET_NOTICE', notice: '' })
          }, 'Dismiss')
        );
        status.hidden = false;
      } else {
        status.replaceChildren();
        status.hidden = true;
      }
    }

    for (const screenKey of VALID_SCREENS) {
      const panel = el(SCREEN_IDS[screenKey]);
      if (!panel) continue;
      const visible = state.screen === screenKey;
      panel.hidden = !visible;
      if (!visible) continue;
      const renderer = SCREEN_RENDERERS[screenKey];
      if (renderer) {
        renderer(panel, { state, derived, dispatch: safeDispatch });
      }
    }
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error?.message || 'An unexpected rendering error occurred.';
      errorBox.hidden = false;
    }
  }
}

for (const tab of document.querySelectorAll('.nav-tab[data-screen]')) {
  tab.addEventListener('click', () => {
    const screen = tab.dataset.screen;
    if (VALID_SCREENS.includes(screen)) {
      safeDispatch({ type: 'NAVIGATE', screen });
    }
  });
}

const homeLink = document.querySelector('[data-home="week"]');
if (homeLink) {
  homeLink.addEventListener('click', ev => {
    ev.preventDefault();
    safeDispatch({ type: 'NAVIGATE', screen: 'week' });
    el('main-content')?.focus();
  });
}

store.subscribe(render);
render(store.getState(), store.derive());
