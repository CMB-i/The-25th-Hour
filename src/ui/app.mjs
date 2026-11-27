import { h, setBlobTone } from './dom.mjs';
import { renderHomeScreen } from './render-home.mjs';
import { renderCheckScreen } from './render-check.mjs';
import { renderCostScreen } from './render-cost.mjs';
import { renderFeedbackScreen } from './render-feedback.mjs';
import { isNight } from './night.mjs';
import { renderStartScreen } from './render-start.mjs';
import { renderRescueScreen } from './render-rescue.mjs';
import { renderSettingsScreen } from './render-settings.mjs';
import { renderWeekScreen } from './render-week.mjs';
import { createStore } from './state.mjs';
import { VALID_SCREENS } from './storage.mjs';

const DEFAULT_SCREEN = 'home';

const SCREEN_IDS = {
  home: 'screen-home',
  start: 'screen-start',
  week: 'screen-week',
  check: 'screen-check',
  cost: 'screen-cost',
  rescue: 'screen-rescue',
  feedback: 'screen-feedback',
  settings: 'screen-settings'
};

// Pages that live under "My week" keep the My week link highlighted.
const WEEK_FAMILY = new Set(['week', 'rescue', 'feedback', 'settings']);

const SCREEN_RENDERERS = {
  home: renderHomeScreen,
  start: renderStartScreen,
  week: renderWeekScreen,
  check: renderCheckScreen,
  cost: renderCostScreen,
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

let lastScreen = null;

/** Night theme: from an hour before sleep until the sleep window ends. Independent of any schedule advice. */
function applyTheme(state) {
  const night = isNight(new Date(), state.sleep);
  const next = night ? 'night' : 'day';
  if (document.documentElement.dataset.theme !== next) document.documentElement.dataset.theme = next;
}

function syncHash(screen) {
  const wanted = `#/${screen}`;
  if (window.location.hash !== wanted) {
    try { window.history.pushState(null, '', wanted); } catch { /* ignore (file://) */ }
  }
}

function render(state, derived) {
  const errorBox = el('error-region');
  try {
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = '';
    }

    const weekLink = el('nav-week');
    if (weekLink) {
      weekLink.setAttribute('aria-current', state.screen === 'week' ? 'page' : 'false');
      weekLink.classList.toggle('in-family', WEEK_FAMILY.has(state.screen));
    }

    const status = el('status-region');
    if (status) {
      if (state.notice) {
        const children = [h('span', {}, state.notice)];
        if (state.undoAdd && state.undoAdd.notice === state.notice) {
          children.push(h('button', {
            type: 'button', id: 'notice-undo', className: 'link-button',
            onClick: () => safeDispatch({ type: 'UNDO_ADDED' })
          }, 'Undo'));
        }
        children.push(h('button', {
          type: 'button',
          className: 'link-button',
          onClick: () => safeDispatch({ type: 'SET_NOTICE', notice: '' })
        }, 'Dismiss'));
        // Never pass null to replaceChildren: the DOM would print the word "null".
        status.replaceChildren(...children);
        status.hidden = false;
      } else {
        status.replaceChildren();
        status.hidden = true;
      }
    }

    const screenChanged = lastScreen !== null && lastScreen !== state.screen;
    lastScreen = state.screen;

    applyTheme(state);
    setBlobTone('coral');
    for (const screenKey of VALID_SCREENS) {
      const panel = el(SCREEN_IDS[screenKey]);
      if (!panel) continue;
      const visible = state.screen === screenKey;
      panel.hidden = !visible;
      if (!visible) {
        if (panel.childNodes.length) panel.replaceChildren();
        continue;
      }
      const renderer = SCREEN_RENDERERS[screenKey];
      if (renderer) {
        renderer(panel, { state, derived, dispatch: safeDispatch });
      }
    }
    syncHash(state.screen);
    if (screenChanged) {
      window.scrollTo(0, 0);
      // A screen may place focus itself (a verdict, a control); otherwise start at the page's main region.
      if (!el(SCREEN_IDS[state.screen])?.contains(document.activeElement)) {
        el('main-content')?.focus({ preventScroll: true });
      }
    }
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error?.message || 'An unexpected rendering error occurred.';
      errorBox.hidden = false;
    }
  }
}

function screenFromHash() {
  const name = window.location.hash.replace(/^#\/?/, '');
  return VALID_SCREENS.includes(name) ? name : null;
}

window.addEventListener('hashchange', () => {
  const screen = screenFromHash();
  if (screen && screen !== store.getState().screen) {
    safeDispatch({ type: 'OPEN_SCREEN', screen });
  }
});

setInterval(() => applyTheme(store.getState()), 60_000);
store.subscribe(render);
// The app opens on Home (or the page named in the address), without rewriting saved data.
const startScreen = screenFromHash() ?? DEFAULT_SCREEN;
if (store.getState().screen !== startScreen) {
  safeDispatch({ type: 'OPEN_SCREEN', screen: startScreen });
} else {
  render(store.getState(), store.derive());
}
