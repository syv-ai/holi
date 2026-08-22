/**
 * One pane's tab strip.
 *
 * Lifted out of `Shell` because it had outgrown being a `map` inside a layout:
 * it measures itself, decides what is out of reach, and owns the controls that
 * say so. Being a component per pane is also what a split needs — the strip is
 * per-pane state (`pane.tabs`, `pane.active`), and a second pane is a second
 * strip rather than a shared one that has to know which pane a tab belongs to.
 *
 * **The bug it fixes.** The strip was a bare flex row: open more tabs than fit
 * between the sidebars and the row kept growing, pushing the editor pane wider
 * than the window, with nothing to say that had happened. Flex items do not
 * shrink below their content, so the pane grew forever.
 *
 * **It scrolls.** The first answer to that was a *window* — render only the
 * pills that fit, hide the rest behind one `+N` (`lib/tab-window.ts`, deleted).
 * It clipped correctly and read wrongly: a single count cannot say which way
 * your tab went, and no amount of pointing at it scrolls. Now every pill is laid
 * out inside an `overflow-x-auto` viewport, and what is off each edge is counted
 * **per side** by `lib/tab-overflow.ts` — pure, because jsdom computes no layout
 * and a rendered strip measures 0×0.
 */
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@/primitives';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Mail,
  SquareKanban,
} from 'lucide-react';
import { fileIconFor } from '@/features/explorer/file-icons';
import { offscreenTabs, type Offscreen } from '@/lib/tab-overflow';
import {
  AUTOSCROLL_MS,
  AUTOSCROLL_PX,
  TAB_MIME,
  dropIndex,
  parseTabPayload,
  stripEdge,
  tabPayload,
  type PillBox,
} from '@/lib/tab-drop';
import type { Tab } from '@/state/panes';
import { snapshotAtom } from '@/state/vaults';

/** The singleton tabs' pill text and tooltip. Notes use their filename/path and
 *  apps use their id instead — both are keyed by something the tab carries
 *  rather than by its kind, so neither can live in a lookup like this. */
const TAB_NAME = { board: 'board', agenda: 'agenda', mail: 'mail' } as const;
const TAB_LABEL: Partial<Record<string, string>> = {
  board: 'task board',
  agenda: 'your Google agenda',
  mail: 'your Gmail',
};

/** The strip's `gap-1`, in px — the caret is drawn in the gap before a pill. */
const GAP = 4;

/** One identity for "nothing is off either edge", so the common case does not
 *  hand React a new object on every scroll event. */
const NOTHING_OFFSCREEN: Offscreen = { left: [], right: [] };

const sameSides = (a: Offscreen, b: Offscreen): boolean =>
  a.left.length === b.left.length &&
  a.right.length === b.right.length &&
  a.left.every((v, i) => v === b.left[i]) &&
  a.right.every((v, i) => v === b.right[i]);

/** A tab's stable identity, for React keys and for the pill-element map. */
export function tabKey(tab: Tab): string {
  return tab.kind === 'note'
    ? `note:${tab.path}`
    : tab.kind === 'app'
      ? `app:${tab.appId}`
      : tab.kind;
}

/** `icons` is `.holi/icons.json` as the snapshot resolved it (D82), keyed by
 *  vault-relative path. It has to be passed in rather than read here: this is a
 *  module-level function, and the tree already proves the map belongs to the
 *  snapshot and not to a store of its own. Only a note tab can carry one — the
 *  singleton tabs are not files and have no path to key by. */
function tabIcon(tab: Tab, icons: Record<string, string>): ReactNode {
  if (tab.kind === 'note') return fileIconFor(tab.path, icons[tab.path]);
  if (tab.kind === 'app') return <LayoutGrid size={14} />;
  if (tab.kind === 'agenda') return <CalendarDays size={14} />;
  if (tab.kind === 'mail') return <Mail size={14} />;
  return <SquareKanban size={14} />;
}

function tabName(tab: Tab): string {
  if (tab.kind === 'note') return tab.path.split('/').at(-1) ?? tab.path;
  if (tab.kind === 'app') return tab.appId;
  return TAB_NAME[tab.kind];
}

function tabTooltip(tab: Tab): string {
  return (
    TAB_LABEL[tab.kind] ??
    (tab.kind === 'note' ? tab.path : tab.kind === 'app' ? `the ${tab.appId} app` : tab.kind)
  );
}

/**
 * What is off one edge, and how to get to it.
 *
 * One per side, because the count's whole job is to keep a scrolled strip
 * distinguishable from a strip that lost your tab — and half that job is saying
 * **which way**. The chevron points the direction; the number is how many are
 * out of reach that way. Clicking a name selects it and scrolls it into view,
 * which is why the strip hands in `onReveal` rather than plain `onSelect`: the
 * tab you pick may already be the active one, and selecting it again would move
 * nothing.
 *
 * **It floats over the strip's edge, and it is always mounted.** Both halves of
 * that are the fix for one bug: reaching the end of a scroll made the count
 * vanish on a single frame, and — because it used to sit in the flex row —
 * removing it handed ~24px back to the viewport, which re-laid every pill out
 * mid-scroll. A control that lives outside the layout cannot shift anything,
 * and one that is always mounted can fade instead of blinking. The gradient
 * under it is what keeps a pill scrolling beneath it legible rather than
 * colliding with the number.
 */
function OverflowMenu({
  side,
  indices,
  tabs,
  icons,
  onReveal,
}: {
  side: 'left' | 'right';
  indices: number[];
  tabs: Tab[];
  icons: Record<string, string>;
  onReveal: (index: number) => void;
}) {
  const visible = indices.length > 0;
  /**
   * The last non-empty list, kept on screen while the control fades out.
   *
   * Without it the number drops to zero on the frame the count empties and what
   * fades away is a blank pill — which reads as the same glitch the fade is
   * there to remove.
   */
  const [shown, setShown] = useState(indices);
  useEffect(() => {
    if (indices.length > 0) setShown(indices);
  }, [indices]);

  const label = `${shown.length} tab${shown.length === 1 ? '' : 's'} off the ${side}`;
  return (
    <div
      className={`pointer-events-none absolute inset-y-0 z-10 flex items-center ${
        side === 'left' ? 'left-0 bg-linear-to-r pr-6 pl-0' : 'right-0 bg-linear-to-l pr-0 pl-6'
      } from-background from-60% to-transparent transition-opacity duration-(--duration-micro) ease-settle ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <DropdownMenu>
        <Tooltip content={label}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className={`shrink-0 gap-0 rounded-full px-1.5 text-muted-foreground ${
                visible ? 'pointer-events-auto' : 'pointer-events-none'
              }`}
              aria-label={label}
              // Out of the accessibility tree and off the tab order while it is
              // invisible: it is still in the DOM only so that it can fade.
              aria-hidden={!visible}
              tabIndex={visible ? undefined : -1}
            >
              {side === 'left' && <ChevronLeft size={12} />}
              {shown.length}
              {side === 'right' && <ChevronRight size={12} />}
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align={side === 'left' ? 'start' : 'end'}>
          {shown.map((index) => {
            const tab = tabs[index];
            if (tab === undefined) return null;
            return (
              <DropdownMenuItem
                key={tabKey(tab)}
                className="gap-2 text-xs"
                onSelect={() => onReveal(index)}
              >
                {tabIcon(tab, icons)}
                <span className={tab.kind === 'note' && tab.preview ? 'italic' : ''}>
                  {tabName(tab)}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export interface TabStripProps {
  tabs: Tab[];
  /** Index into `tabs`; `-1` for an empty pane. */
  active: number;
  onSelect: (index: number) => void;
  /** Double-click promotes a preview tab (the VS Code rule). */
  onPin: (index: number) => void;
  onClose: (index: number) => void;
  /** Whether this pane is the focused one. An unfocused pane's active tab keeps
   *  its shape but loses its weight, so two strips side by side say which one
   *  the next opened file will land in. Defaults to true — with a single pane
   *  there is nothing to distinguish it from. */
  focused?: boolean;
  /** A tab was dropped on this strip, to sit before `index`. The tab may have
   *  come from this strip (a reorder) or from another pane's; the handler does
   *  not need to know, because `moveTab` finds it wherever it is. Absent means
   *  this strip takes no drops. */
  onDropTab?: (tab: Tab, index: number) => void;
  /** A drag started from *this* strip, carrying that tab. The workspace uses it
   *  to work out which drops would do anything at all — see `dropZones`. */
  onDragBegin?: (tab: Tab) => void;
  /** Controls pinned to the right-hand end, outside the scroll (version history). */
  trailing?: ReactNode;
}

export function TabStrip({
  tabs,
  active,
  onSelect,
  onPin,
  onClose,
  focused = true,
  onDropTab,
  onDragBegin,
  trailing,
}: TabStripProps) {
  // Read here rather than taken as a prop: every pane's strip wants the same
  // map, and threading it through `PaneView` would make each caller repeat a
  // lookup that has exactly one answer.
  const icons = useAtomValue(snapshotAtom).icons;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef(new Map<string, HTMLElement>());
  /**
   * Where the dragged tab would land, and where to draw the line saying so.
   *
   * `x` is in the scroll container's **content** coordinates (`offsetLeft`), not
   * the viewport's: the caret is absolutely positioned inside the scroller, so a
   * viewport-relative x would drift the moment the strip scrolled under it.
   */
  const [caret, setCaret] = useState<{ index: number; x: number } | null>(null);
  /** Which tabs are out of reach, per side. */
  const [offscreen, setOffscreen] = useState<Offscreen>(NOTHING_OFFSCREEN);
  /** The running auto-scroll, and which way it is going — kept in a ref so that
   *  the continuous stream of `dragover` events does not restart the timer on
   *  every frame and freeze the strip where it started. */
  const scrollRef = useRef<{
    edge: 'left' | 'right';
    timer: ReturnType<typeof setInterval>;
  } | null>(null);

  const stopScrolling = () => {
    if (scrollRef.current !== null) clearInterval(scrollRef.current.timer);
    scrollRef.current = null;
  };

  // A drag can end without this strip hearing about it: dropped on another pane,
  // or cancelled with escape while the pointer sits right here — in which case
  // `dragend` fires on the source pill, which may be in a different pane
  // entirely. Left alone, this strip would keep a caret drawn and a timer
  // scrolling for a drag that finished a minute ago. Listening on the window
  // catches every ending; the cleanup covers unmounting mid-drag.
  useEffect(() => {
    const clear = () => {
      if (scrollRef.current !== null) clearInterval(scrollRef.current.timer);
      scrollRef.current = null;
      setCaret(null);
    };
    window.addEventListener('dragend', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      clear();
    };
  }, []);

  const endDrag = () => {
    stopScrolling();
    setCaret(null);
  };

  // What is off each edge, recomputed whenever the strip scrolls, the pane
  // resizes, or the tab set changes. Written back only on a change — a scroll
  // fires continuously, and a fresh object per event would re-render the strip
  // at pointer rate for an answer that is usually the same one.
  //
  // `offsetLeft`/`offsetWidth` rather than `getBoundingClientRect`: they are
  // measured against the scroll content, so they do not move as it scrolls,
  // which is exactly the frame `offscreenTabs` reasons in.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measure = () => {
      const pills = tabs.map((tab) => {
        const el = pillRefs.current.get(tabKey(tab));
        return el === undefined
          ? { left: 0, width: 0 }
          : { left: el.offsetLeft, width: el.offsetWidth };
      });
      const next = offscreenTabs(pills, host.scrollLeft, host.clientWidth);
      setOffscreen((prev) => (sameSides(prev, next) ? prev : next));
    };
    measure();
    host.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => {
      host.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [tabs]);

  /**
   * Keep the active tab reachable.
   *
   * Keyed on the active tab's **identity**, not on `active` or on `tabs`. On the
   * index alone it would miss a different tab arriving at the same index; on
   * `tabs` it would fire after every reorder and yank the scroll back to the
   * active tab just as you dropped a different one somewhere else.
   */
  const activeTab = active >= 0 ? tabs[active] : undefined;
  const activeKey = activeTab === undefined ? null : tabKey(activeTab);
  useLayoutEffect(() => {
    if (activeKey === null) return;
    pillRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  /** Select a tab from an overflow menu and bring it into view. `onSelect`
   *  alone is not enough: the tab may already be the active one — you scrolled
   *  away from it — and re-selecting it moves nothing. */
  const reveal = (index: number) => {
    onSelect(index);
    const tab = tabs[index];
    if (tab === undefined) return;
    pillRefs.current
      .get(tabKey(tab))
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  };

  /**
   * The pills, measured now, carrying their indices.
   *
   * Read live rather than cached: a drop needs where a pill *is* on screen, in
   * the same coordinates as `clientX`, and that only the DOM knows.
   */
  const pillBoxes = (): PillBox[] => {
    const boxes: PillBox[] = [];
    tabs.forEach((t, index) => {
      const el = pillRefs.current.get(tabKey(t));
      if (el === undefined) return;
      const rect = el.getBoundingClientRect();
      boxes.push({ index, left: rect.left, width: rect.width });
    });
    return boxes;
  };

  /** Whether this drag is one of ours. `getData` is empty during `dragover` by
   *  spec, so the MIME type is the only question a target may ask mid-drag. */
  const carriesTab = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME);

  /**
   * Scroll while the pointer sits at an end of the strip.
   *
   * This is what makes an off-screen drop position reachable at all — you cannot
   * scroll with the wheel while a drag is in flight. Re-arming is suppressed
   * while the same edge is already running: `dragover` fires continuously, and
   * restarting the interval on each one would reset it forever and the strip
   * would never move at all.
   */
  const autoScroll = (edge: 'left' | 'right' | null) => {
    if (edge === null) return stopScrolling();
    if (scrollRef.current?.edge === edge) return;
    stopScrolling();
    const step = edge === 'left' ? -AUTOSCROLL_PX : AUTOSCROLL_PX;
    const advance = () => {
      const host = hostRef.current;
      if (host !== null) host.scrollLeft += step;
    };
    // One step now, then on the timer — a hover that has already arrived at the
    // edge should do something before it does nothing for a whole interval.
    advance();
    scrollRef.current = { edge, timer: setInterval(advance, AUTOSCROLL_MS) };
  };

  /** Where to draw the caret for a drop before `index`, in content coordinates:
   *  in the gap ahead of that pill, or past the end of the last one. */
  const caretX = (index: number): number => {
    const tab = tabs[index];
    const el = tab === undefined ? undefined : pillRefs.current.get(tabKey(tab));
    if (el !== undefined) return el.offsetLeft - GAP / 2;
    const last = tabs.at(-1);
    const lastEl = last === undefined ? undefined : pillRefs.current.get(tabKey(last));
    return lastEl === undefined ? 0 : lastEl.offsetLeft + lastEl.offsetWidth + GAP / 2;
  };

  const dragOver = (e: React.DragEvent) => {
    if (onDropTab === undefined || !carriesTab(e)) return;
    // Without this the drop event never fires — the commonest way HTML5
    // drag-and-drop silently does nothing at all.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const index = dropIndex(pillBoxes(), e.clientX);
    setCaret({ index, x: caretX(index) });

    const host = hostRef.current?.getBoundingClientRect();
    if (host !== undefined) autoScroll(stripEdge(host, e.clientX));
  };

  const drop = (e: React.DragEvent) => {
    endDrag();
    const tab = parseTabPayload(e.dataTransfer.getData(TAB_MIME));
    if (tab === null) return;
    e.preventDefault();
    // Recomputed rather than read off `caret`: the drop must land where the
    // pointer is, even if no `dragover` was recorded for this exact position.
    onDropTab?.(tab, dropIndex(pillBoxes(), e.clientX));
  };

  /** A vertical wheel scrolls the strip sideways — there is nothing to scroll
   *  vertically in a one-line row, and a mouse without a horizontal wheel would
   *  otherwise have no gesture at all. A trackpad's horizontal delta is left to
   *  the browser, which already does the right thing with it. */
  const wheel = (e: React.WheelEvent) => {
    const host = hostRef.current;
    if (host === null || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    host.scrollLeft += e.deltaY;
  };

  return (
    <div className="flex h-11 min-w-0 items-center gap-1 px-2">
      {/* The frame the side counts float in. They are positioned against the
          scroll viewport rather than the whole row, so `trailing` keeps its
          place at the end and the counts sit on the strip's own edges. */}
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          ref={hostRef}
          // `min-w-0` as well as the scroll: a flex child does not shrink below
          // its content, and without it the row grows the pane instead of
          // scrolling. The scrollbar is hidden because the strip is 44px tall and
          // a permanent one would eat a third of a pill — the side counts are the
          // affordance that says there is more.
          className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          data-testid="tab-strip"
          onDragOver={dragOver}
          onDragLeave={(e) => {
            // `dragleave` also fires when the pointer crosses into a child, so
            // clear only when the host itself was actually left.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            endDrag();
          }}
          onDrop={drop}
          onWheel={wheel}
        >
          {/* Where it would land. Absolutely positioned on purpose: a real spacer
            would change the layout the drop midpoints were computed from, and
            the gap would chase the pointer. */}
          {caret !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
              style={{ left: Math.max(0, caret.x - 1) }}
            />
          )}
          {tabs.map((t, i) => {
            const key = tabKey(t);
            return (
              <span
                key={key}
                ref={(el) => {
                  if (el === null) pillRefs.current.delete(key);
                  else pillRefs.current.set(key, el);
                }}
                // On the pill, not on the Radix trigger and not on the Button —
                // `BoardView` puts it on the card `div` for the same reason.
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TAB_MIME, tabPayload(t));
                  e.dataTransfer.effectAllowed = 'move';
                  onDragBegin?.(t);
                }}
                onDragEnd={endDrag}
                className={`group flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs ${
                  i === active
                    ? focused
                      ? 'bg-secondary text-foreground'
                      : 'bg-secondary/40 text-muted-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Tooltip content={tabTooltip(t)}>
                  <Button
                    variant="ghost"
                    // Bare clickable on the pill — neutralise the ghost bg/padding so
                    // the pill owns the surface. A preview tab reads italic (VS Code);
                    // double-clicking it pins it, the same promotion editing performs.
                    //
                    // The nudge is what keeps an unhovered tab looking centred. The
                    // close control holds its width while invisible, which leaves
                    // 4 + 10.7 + 12 = 26.7px of air to the label's right against
                    // 12px to its left; half that excess, given back as a
                    // transform, splits it evenly. A transform and not padding,
                    // because a pill that changed WIDTH on hover would move every
                    // pill after it, and with it the midpoints a drop is decided
                    // against. Hovering hands the space back, so the ✕ arrives
                    // into a gap rather than up against the pill's edge.
                    className={`h-auto translate-x-[7px] gap-1.5 p-0 transition-transform duration-(--duration-micro) ease-settle group-hover:translate-x-0 hover:bg-transparent ${
                      t.kind === 'note' && t.preview ? 'italic' : ''
                    }`}
                    onClick={() => onSelect(i)}
                    onDoubleClick={() => onPin(i)}
                  >
                    {tabIcon(t, icons)}
                    <span>{tabName(t)}</span>
                  </Button>
                </Tooltip>
                {/* Shown on hover of its own pill, and whenever it is focused so
                  the keyboard can still reach it. Hidden with `opacity`, never
                  `hidden` — a control that came and went with the pointer would
                  change the pill's width, and every pill after it would shift
                  under the pointer that hovered it. */}
                <Tooltip content="close tab">
                  <Button
                    variant="ghost"
                    className="h-auto p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-foreground focus-visible:opacity-100"
                    onClick={() => onClose(i)}
                  >
                    ✕
                  </Button>
                </Tooltip>
              </span>
            );
          })}
        </div>
        <OverflowMenu
          side="left"
          indices={offscreen.left}
          tabs={tabs}
          icons={icons}
          onReveal={reveal}
        />
        <OverflowMenu
          side="right"
          indices={offscreen.right}
          tabs={tabs}
          icons={icons}
          onReveal={reveal}
        />
      </div>
      {trailing}
    </div>
  );
}
