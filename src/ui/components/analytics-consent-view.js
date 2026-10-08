import { el, button } from './dom.js';

// Analytics choice. Both options have equal weight and nothing is sent until "Allow" is chosen. Product use never
// depends on this choice. The choice can be changed at any time from the footer.
export function analyticsConsentBanner({ onAllow, onDeny }) {
  return el('section', { class: 'consent-banner', 'aria-labelledby': 'analytics-consent-title', 'data-testid': 'analytics-banner' },
    el('h2', { id: 'analytics-consent-title' }, 'Help us improve Knowvia?'),
    el('p', {}, 'With your permission we count which steps people use and where they get stuck. We never send your name, your family\'s details, your policy or any amounts. You can change this at any time.'),
    el('div', { class: 'actions' },
      button('Allow usage analytics', { testid: 'analytics-allow', onClick: onAllow }),
      button('No thanks', { variant: 'secondary', testid: 'analytics-deny', onClick: onDeny })));
}

export function analyticsSettingsLink({ decision, onChange }) {
  const label = decision === 'granted' ? 'Usage analytics: on. Turn off' : 'Usage analytics: off. Change';
  return button(label, { variant: 'small secondary', testid: 'analytics-settings', onClick: onChange });
}
