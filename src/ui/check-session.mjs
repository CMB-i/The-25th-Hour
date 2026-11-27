// In-memory UI session for the check flow. None of this is persisted or engine data: it only keeps
// what the student is typing, and which reply they are editing, across re-renders.
export const session = {
  formDraft: null,          // fields being typed (new) or edited (pending request)
  editing: false,           // the pending request is open for editing
  pendingFocus: false,      // move focus to the verdict after the next check
  focusSelectorAfterRender: null,
  bookedOpen: false,
  moreOptionsOpen: false
};

// Per-request reply and smaller-offer state, keyed by proposal id.
export const requestUi = new Map();

export function getUi(proposalId) {
  if (!requestUi.has(proposalId)) {
    requestUi.set(proposalId, {
      text: '',
      autoText: '',
      touched: false,
      baseSignature: '',
      tab: null,
      learnedUsed: false,
      showFull: false,
      waitText: '',
      waitTouched: false,
      smaller: null
    });
  }
  return requestUi.get(proposalId);
}

export function resetRequestUi() {
  requestUi.clear();
  session.editing = false;
}

export function resetCheckFormDraft() {
  session.formDraft = null;
  resetRequestUi();
}
