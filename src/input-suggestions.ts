// Keep the datalist as the source of choices. A popover lets editable fields use
// the same themed surface as selects while preserving free text and form values.
export function suggestionAttributes(listId: string) {
  return `data-suggestions="${listId}" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="false"`;
}

export function installInputSuggestions() {
  const menu = document.createElement('div');
  menu.id = 'field-suggestions';
  menu.popover = 'manual';
  menu.setAttribute('role', 'listbox');
  let field: HTMLInputElement | undefined;
  let activeIndex = -1;
  let filteredText: string | undefined;

  const inputFor = (target: EventTarget | null) => target instanceof HTMLInputElement &&
    target.hasAttribute('data-suggestions') && !target.disabled && !target.readOnly ? target : undefined;

  function close() {
    if (!field) return;
    field.setAttribute('aria-expanded', 'false');
    field.removeAttribute('aria-controls');
    field.removeAttribute('aria-activedescendant');
    field = undefined;
    activeIndex = -1;
    filteredText = undefined;
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.remove();
  }

  function tokenBounds(input: HTMLInputElement) {
    const value = input.value;
    if (!input.hasAttribute('data-suggestion-tokens')) return [0, value.length] as const;
    const start = input.selectionStart ?? value.length, end = input.selectionEnd ?? start;
    return [value.slice(0, start).search(/\S*$/), end + (value.slice(end).match(/^\S*/)?.[0].length ?? 0)] as const;
  }

  function show(input: HTMLInputElement, filter: boolean) {
    const source = document.getElementById(input.dataset.suggestions!);
    if (!(source instanceof HTMLDataListElement)) { close(); return; }
    const text = input.value.slice(...tokenBounds(input));
    const query = filter ? text.trim().toLowerCase() : '';
    const choices = Array.from(source.options).filter(option => option.value && !option.disabled &&
      (option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query)));
    if (!choices.length) { close(); return; }
    if (field !== input) close();
    field = input;
    activeIndex = -1;
    filteredText = filter ? text : undefined;
    input.setAttribute('aria-controls', menu.id);
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    menu.setAttribute('aria-label', input.getAttribute('aria-label') || input.labels?.[0]?.firstChild?.textContent?.trim() || source.id);
    menu.replaceChildren(...choices.map((option, index) => {
      const row = document.createElement('div');
      row.id = `${menu.id}-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.dataset.value = option.value;
      row.textContent = option.value;
      if (option.label && option.label !== option.value) {
        const detail = document.createElement('small');
        detail.textContent = option.label;
        row.append(detail);
      }
      return row;
    }));
    if (!menu.isConnected) (input.closest('dialog') || document.body).append(menu);
    if (!menu.matches(':popover-open')) menu.showPopover();
    menu.scrollTop = 0;
  }

  function choose(row: HTMLElement) {
    if (!field) return;
    const input = field;
    const [start, end] = tokenBounds(input);
    const previous = input.value;
    input.setRangeText(row.dataset.value!, start, end, 'end');
    close();
    if (input.value === previous) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function move(direction: number) {
    if (!field) return;
    menu.children[activeIndex]?.setAttribute('aria-selected', 'false');
    activeIndex = activeIndex < 0 ? (direction > 0 ? 0 : menu.children.length - 1) :
      Math.max(0, Math.min(menu.children.length - 1, activeIndex + direction));
    const row = menu.children[activeIndex];
    row.setAttribute('aria-selected', 'true');
    field.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  }

  menu.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
  menu.addEventListener('click', event => {
    const row = event.target instanceof Element && event.target.closest<HTMLElement>('[role=option]');
    if (row) { event.stopPropagation(); choose(row); }
  });
  document.addEventListener('pointerdown', event => {
    if (field && event.target !== field && !menu.contains(event.target as Node)) close();
  }, true);
  document.addEventListener('focusout', event => { if (event.target === field) close(); });
  document.addEventListener('close', event => {
    if (field && event.target instanceof HTMLDialogElement && event.target.contains(field)) close();
  }, true);
  document.addEventListener('click', event => {
    const input = inputFor(event.target);
    if (input) show(input, false);
  });
  document.addEventListener('input', event => {
    const input = inputFor(event.target);
    if (input && event instanceof InputEvent && !event.isComposing) show(input, true);
  });
  document.addEventListener('compositionstart', event => { if (event.target === field) close(); });
  document.addEventListener('compositionend', event => {
    const input = inputFor(event.target);
    if (input && input === document.activeElement) show(input, true);
  });
  document.addEventListener('keydown', event => {
    const input = inputFor(event.target);
    if (!input || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (field !== input || (filteredText !== undefined && filteredText !== input.value.slice(...tokenBounds(input)))) show(input, false);
      if (field !== input) return;
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (field === input && event.key === 'Enter' && activeIndex >= 0) {
      choose(menu.children[activeIndex] as HTMLElement);
    } else if (field === input && event.key === 'Escape') {
      close();
    } else {
      if (field === input && (event.key === 'Tab' || event.key === 'Enter')) close();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
