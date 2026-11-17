export function rowSnapshotExpression(path) {
  const selector = `[role="treeitem"][aria-label=${JSON.stringify(path)}]`
  return `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const label = row.querySelector('[data-slot="tree-item-label"]');
    const name = label.querySelector(':scope > span > .truncate') || label.querySelector('.truncate');
    const action = label.querySelector('[data-tree-row-action]');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom};
    };
    const style = getComputedStyle(action);
    return {
      path: ${JSON.stringify(path)},
      boxes: {row:box(row),label:box(label),name:box(name),bell:box(action)},
      opacity: style.opacity,
      ariaLabel: action.getAttribute('aria-label'),
      icon: action.querySelector('svg')?.getAttribute('class'),
      nameHover: name.matches(':hover'),
      labelHover: label.matches(':hover'),
      bellHover: action.matches(':hover'),
      rowFocused: document.activeElement === row,
      bellFocused: document.activeElement === action,
      focusVisible: action.matches(':focus-visible'),
      focusShadow: style.boxShadow,
      nameTruncated: name.scrollWidth > name.clientWidth,
      hoverLabels: [...document.querySelectorAll('[data-slot="tree-item-label"]')].filter(element => element.matches(':hover')).length,
      hoverButtons: [...document.querySelectorAll('[data-tree-row-action]')].filter(element => element.matches(':hover')).length,
      others: [...document.querySelectorAll('[data-tree-row-action]')]
        .filter(element => element !== action)
        .map(element => ({label:element.getAttribute('aria-label'),opacity:getComputedStyle(element).opacity}))
    };
  })()`
}
