// Map / Chart tabs, for the width where they cannot sit side by side.
//
// At the desktop breakpoint the two panels sit in a grid instead and this control
// disappears entirely (see .dashboard-tabs in styles.css); the `hidden` attribute this
// sets is overridden there. That split keeps the breakpoint logic in one place — CSS —
// rather than duplicated between a media query and a resize listener here.

export interface TabsView {
  select(id: string): void;
}

interface Tab {
  id: string;
  panel: HTMLElement;
}

export function createTabs(root: HTMLElement, tabs: Tab[], onSelect?: (id: string) => void): TabsView {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

  function select(id: string): void {
    for (const button of buttons) {
      const active = button.dataset.tab === id;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const tab of tabs) {
      tab.panel.hidden = tab.id !== id;
    }
    onSelect?.(id);
  }

  buttons.forEach((button, index) => {
    button.addEventListener('click', () => select(button.dataset.tab ?? ''));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      if (!next) return;
      next.focus();
      select(next.dataset.tab ?? '');
    });
  });

  return { select };
}
