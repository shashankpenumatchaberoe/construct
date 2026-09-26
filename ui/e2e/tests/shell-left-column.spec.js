import { test, expect } from '@playwright/test';
import { gotoCockpit } from './support/cockpit.js';
import { makeBrowseProject, openProject } from './support/browseProject.js';

const API = process.env.E2E_API_BASE || 'http://localhost:4000';

// #539 (owner: "i still see two menus on left ... it should [go] under the main nav") — the wide
// layout's screens rail (ActivityBar, `nav[aria-label="Screens"]`) and the Browser pane
// (`aside#sh-pane-left`) now share ONE left column (`.sh-left-col`), rail on top, Browser pane
// content below, instead of sitting beside each other as two separate columns. This is shell-wide
// (ShellLayout.tsx/ActivityBar.tsx render for every screen), so the Pages screen alone stands in
// for all of them here, the same way #429/#245's own shell-rail/shell-layout specs already do.
//
// #683 (owner: same complaint, one menu further) — the Browser pane's OWN tab strip (Pages here;
// Features/Notes/Blocks on the Features screen) moved out of the pane's header and into the same
// left column too, as more vertical rows (`RailSubTabs`, `[data-testid="rail-subtabs"]`) directly
// under the rail and directly above the pane's now-headerless content. Three pieces stacked in one
// column, not two.
//
// All three keep their own, already-shipped, independent collapse mechanism (no new competing
// one): the rail's `sh-rail-toggle` (icons-only), the sub-tabs list (which switches which pane
// content shows, unaffected by the rail's own collapse), and the Browser pane's existing
// open/close (Ctrl+B / the top-bar toggle -- closing it also hides the sub-tabs row, since there
// is nothing left to switch between). `useRailKeys`' roving-tabindex model inside the rail is
// unchanged.
const nav = (page) => page.getByRole('navigation', { name: 'Screens', exact: true });
const subtabs = (page) => page.getByTestId('rail-subtabs');
const browser = (page) => page.getByRole('complementary', { name: 'Browser' });

test.describe.serial('Shell: rail, sub-tabs and Browser pane stack in one column (#539, #683)', () => {
  let project;
  let restore;

  test.beforeAll(async () => {
    project = makeBrowseProject('og539-left-column-');
    restore = await openProject(API, project.repo);
  });
  test.afterAll(async () => {
    await restore?.();
    project?.remove();
  });

  test('one shared column: the rail, the sub-tabs and the Browser pane stack in order, same width, one right-hand edge', async ({ page }) => {
    await gotoCockpit(page, '/pages');
    const rail = nav(page);
    const tabs = subtabs(page);
    const pane = browser(page);
    await expect(rail).toBeVisible();
    await expect(tabs).toBeVisible();
    await expect(pane).toBeVisible();

    // All three landmarks are inside the same `.sh-left-col` wrapper (not separate columns).
    const col = page.locator('.sh-left-col');
    await expect(col).toHaveCount(1);
    await expect(col.getByRole('navigation', { name: 'Screens', exact: true })).toHaveCount(1);
    await expect(col.getByTestId('rail-subtabs')).toHaveCount(1);
    await expect(col.getByRole('complementary', { name: 'Browser' })).toHaveCount(1);

    const [railBox, tabsBox, paneBox, midBox] = [await rail.boundingBox(), await tabs.boundingBox(), await pane.boundingBox(), await page.locator('#sh-mid').boundingBox()];
    // Rail directly above the sub-tabs, sub-tabs directly above the Browser pane: same left edge,
    // each one's bottom meets the next one's top (#683 -- three pieces read as one column).
    expect(Math.abs(railBox.x - tabsBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(railBox.y + railBox.height - tabsBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(tabsBox.x - paneBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(tabsBox.y + tabsBox.height - paneBox.y)).toBeLessThanOrEqual(1);
    // Same width all the way down -- reads as one column, not a narrower menu perched over a wider pane.
    expect(Math.abs(railBox.width - tabsBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(tabsBox.width - paneBox.width)).toBeLessThanOrEqual(1);
    // The shared column still sits left of the stage, as the old two-column layout did.
    expect(railBox.x).toBeLessThan(5);
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(midBox.x + 1);
  });

  test('independent collapse: the rail\'s own icons-only toggle does not touch the Browser pane, and closing the Browser pane leaves the rail alone', async ({ page }) => {
    await gotoCockpit(page, '/pages');
    const rail = nav(page);
    const pane = browser(page);
    const wideRail = (await rail.boundingBox()).width;

    // Collapsing the rail (its existing toggle, unchanged) does not close or resize the Browser pane.
    await page.getByTestId('rail-toggle').click();
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
    await expect(pane).toBeVisible();
    const paneWidthAfterRailCollapse = (await pane.boundingBox()).width;
    await expect(page.getByTestId('pages-list')).toBeVisible();

    // Re-expand the rail; collapse the Browser pane instead (Ctrl+B) -- the rail is unaffected.
    await page.getByTestId('rail-toggle').click();
    await expect(rail).toHaveAttribute('data-collapsed', 'false');
    await page.keyboard.press('Control+b');
    await expect(pane).toHaveCount(0);
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link')).toHaveCount(5);
    expect((await rail.boundingBox()).width).toBeGreaterThan(0);

    // Reopen the Browser pane -- both are back, independently, at their prior sizes.
    await page.keyboard.press('Control+b');
    await expect(pane).toBeVisible();
    expect((await pane.boundingBox()).width).toBe(paneWidthAfterRailCollapse);
    expect((await rail.boundingBox()).width).toBe(wideRail);
  });

  test('keyboard: Tab reaches the rail, arrow keys still rove between rail items, Tab continues through the sub-tabs into the Browser pane', async ({ page }) => {
    await gotoCockpit(page, '/pages');
    const rail = nav(page);
    const links = rail.getByRole('link');

    // Focus the rail's one roving tab stop directly (as shell-rail.spec.js does), confirm arrow-key
    // roving inside the rail still works exactly as before this change.
    await links.nth(1).focus();
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(links.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(links.nth(1)).toBeFocused();

    // Tab out of the focused rail link: focus lands next on the merged column's own sub-tab row
    // (#683 -- "Pages", the Browser pane's former tab-strip button, now lives here instead of
    // inside the pane), then the pane's headerless tabpanel, then the pane's own content -- proving
    // all three are adjacent in one column/tab sequence, not disjoint regions.
    await page.keyboard.press('Tab');
    await expect(subtabs(page).getByRole('tab', { name: 'Pages' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(browser(page).locator(':focus')).toHaveCount(1); // its tabpanel
    await page.keyboard.press('Tab');
    await expect(browser(page).getByRole('radio', { name: 'Files' })).toBeFocused(); // the Files | Flow switcher
  });
});
