import type { Loss } from '../capabilities';
import { h } from './dom';

export function renderLosses(losses: Loss[]): HTMLElement {
  if (losses.length === 0) {
    return h(
      'div',
      { class: 'ok', 'data-testid': 'loss-none' },
      'Nothing. The output will be pixel-identical to the source and no metadata is dropped or altered.',
    );
  }
  const ul = h('ul', { class: 'losses', 'data-testid': 'loss-list' });
  for (const l of losses) {
    ul.append(
      h(
        'li',
        { class: l.severity, 'data-loss': l.kind, 'data-severity': l.severity },
        h('span', { class: 'badge' }, l.severity),
        h('span', {}, l.message),
      ),
    );
  }
  return ul;
}
