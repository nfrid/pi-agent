import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ActivityCollapsibleSection } from './collapsible-list-section';

describe('ActivityCollapsibleSection', () => {
  it.each([
    { expanded: true, totalCount: 7, visibleCount: 7, disabled: false },
    { expanded: false, totalCount: 7, visibleCount: 7, disabled: true },
    { expanded: false, totalCount: 7, visibleCount: 3, disabled: false },
  ])('sets disabled=$disabled for expanded=$expanded with $totalCount total and $visibleCount visible rows', ({
    expanded,
    totalCount,
    visibleCount,
    disabled,
  }) => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ActivityCollapsibleSection
          title="Delegates"
          expanded={expanded}
          onToggle={() => undefined}
          totalCount={totalCount}
          visibleCount={visibleCount}
        >
          <div>row</div>
        </ActivityCollapsibleSection>,
      );
    });
    const button = renderer.root.findByType('button');
    expect(button.props.disabled).toBe(disabled);
    expect(button.props['aria-expanded']).toBe(expanded);
    const chips = renderer.root.findAllByProps({
      className: 'activity-panel-hidden-chip',
    });
    if (expanded || visibleCount === totalCount) expect(chips).toHaveLength(0);
    else expect(chips[0]?.children).toEqual(['4', ' more']);
    act(() => renderer.unmount());
  });
});
