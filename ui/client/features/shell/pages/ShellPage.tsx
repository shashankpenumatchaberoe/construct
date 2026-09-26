import type { ReactNode } from 'react';
import { ActivityBar } from '../components/ActivityBar';
import { EmptyPanel } from '../components/EmptyPanel';
import { RailSubTabs } from '../components/RailSubTabs';
import { ShellLayout } from '../components/ShellLayout';
import { StatusBar } from '../components/StatusBar';
import { TabHost } from '../components/TabHost';
import { TopBar } from '../components/TopBar';
import type { ShellPageProps, ShellRegion } from '../types';

// Presentation-only composition (PAGE-002..006): wires the slot components
// from props. All state and data come from ShellController.
export function ShellPage(props: ShellPageProps): ReactNode {
  const { tabs, activeTabs, onSelectTab } = props;
  const host = (region: ShellRegion, label: string) => (
    <TabHost
      label={label}
      tabs={tabs[region]}
      activeId={activeTabs[region]}
      onSelect={(id) => onSelectTab(region, id)}
      empty={region === 'browser' ? <EmptyPanel title="Nothing to browse on this screen" hint="Choose Features, Pages, Components, Git or Tests in the menu on the left; Settings, Local model and Help are in the profile menu." /> : undefined}
      // #683: the Browser pane's own sub-tabs (Features/Notes, ...) no longer render as this
      // host's horizontal tablist -- they render as vertical entries under the rail instead
      // (below), so this pane keeps only the active tab's content.
      hideList={region === 'browser'}
    />
  );
  // Only in the wide layout, and only while the Browser pane is open: the narrow layout already
  // shows one pane at a time with its own bottom bar, and a closed pane has no content to switch
  // between. Renders nothing itself when the active screen registered no browser tabs (#683).
  const browserSubTabs = !props.narrow && props.layout.left.open ? (
    <RailSubTabs label="Browser" tabs={tabs.browser} activeId={activeTabs.browser} onSelect={(id) => onSelectTab('browser', id)} />
  ) : null;
  return (
    <ShellLayout
      layout={props.layout}
      limits={props.limits}
      onResize={props.onResize}
      onTogglePane={props.onTogglePane}
      narrow={props.narrow}
      narrowPane={props.narrowPane}
      onNarrowPane={props.onNarrowPane}
      focus={props.focus}
      rail={
        <>
          <ActivityBar
            screens={props.screens}
            activeScreenId={props.activeScreenId}
            screenBadges={props.screenBadges}
            collapsed={props.railCollapsed}
            onToggleCollapsed={props.onToggleRail}
            orientation={props.narrow ? 'horizontal' : 'vertical'}
          />
          {browserSubTabs}
        </>
      }
      top={
        <TopBar
          projectSwitcher={props.projectSwitcher}
          userMenu={props.userMenu}
          modelStatus={props.modelStatus}
          runningProcesses={props.runningProcesses}
          working={props.working}
          layout={props.layout}
          onTogglePane={props.onTogglePane}
          onOpenProcesses={props.onOpenProcesses}
          onOpenPalette={props.onOpenPalette}
        />
      }
      left={host('browser', 'Browser')}
      mid={<main className="main">{props.children}</main>}
      right={host('tools', 'Tools')}
      drawer={host('drawer', 'Drawer')}
      status={<StatusBar layout={props.layout} onTogglePane={props.onTogglePane} shortcuts={props.shortcuts} validateStatus={props.validateStatus} validateStatusChars={props.validateStatusChars} onOpenDiagnostics={props.onOpenDiagnostics} />}
    />
  );
}
