import { expect } from '@playwright/test';

// #324 — wait for the Cockpit to be genuinely interactive, not merely painted.
//
// The auth gate (#278) renders the Cockpit only after `/auth/session` answers
// (and treats "not knowing" as blocked — correct, and not something a test
// should work around). That round trip sits ahead of hydration, so a keystroke
// or click fired straight after `goto` can land before the shell's window
// `keydown` listener is attached and is silently dropped.
//
// The readiness signal is the listener itself: dispatch a synthetic, cancelable
// F6 keydown on `window` and wait until the shell calls `preventDefault()` on
// it. That only happens once `useShellShortcuts` has attached, so it is direct
// proof the shell is hydrated — no fixed sleep, no guessing. F6 only moves
// focus between panes, so focus is put back afterwards and nothing else is
// mutated (unlike Ctrl+B / Ctrl+J, which toggle state).
export async function waitForCockpitReady(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const ev = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
          const before = document.activeElement;
          window.dispatchEvent(ev);
          if (ev.defaultPrevented && document.activeElement !== before) {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            if (before instanceof HTMLElement && before !== document.body) before.focus();
          }
          return ev.defaultPrevented;
        }),
      { message: 'Cockpit shell did not attach its keyboard shortcuts' },
    )
    .toBe(true);
}

// `goto` + wait: the usual entry for any spec that presses shortcuts or clicks
// shell chrome straight away.
export async function gotoCockpit(page, url) {
  await page.goto(url);
  await waitForCockpitReady(page);
}

// #368 - the theme lives in the profile menu now (there is no top-bar toggle). Opens the menu, picks
// 'dark' | 'light' | 'system' from its Theme radio group and closes the menu again (Escape returns focus).
export async function setTheme(page, theme) {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId(`theme-${theme}`).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('user-menu-trigger')).toHaveAttribute('aria-expanded', 'false');
}

// #431 - the Features screen's Browser opens on its Features list; the note, its constraints and the picker are on the
// Notes tab beside it. Goes to `url` and opens that tab.
export async function gotoNotes(page, url = '/plan') {
  await gotoCockpit(page, url);
  await page.getByRole('tablist', { name: 'Browser' }).getByRole('tab', { name: 'Notes' }).click();
}
