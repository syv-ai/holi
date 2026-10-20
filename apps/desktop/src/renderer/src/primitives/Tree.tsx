/**
 * ReUI's tree (`@reui/tree`, installed with the `c-tree-1` example), driven by
 * a `@headless-tree/react` instance: rows of a chevron, an icon and a name, a
 * flat indent per level, no connector lines and no open or close motion. Every
 * tree in the app draws through this (docs/ui-system.md, Trees).
 *
 * Restyled to Holi's rules only: semantic tokens and the sidebar's fills, the
 * thin focus ring, `text-nav` rows, `motion-respond` for the hover colour (the
 * lint gate's name for a colour transition), and the chevron drawn through
 * `<Icon>`. Two seams were added, both for trees that keep their own
 * behaviour: a prop given to `Tree` or `TreeItem` wins over the instance's own
 * (so a tree's click, tab stop and label are its own), and refs are composed
 * rather than replaced. `TreeItemLabel` takes `renderToggle` to wrap its
 * chevron, and `TreeDragLine` also draws from a plain `style`, for a tree that
 * does its own drag and drop.
 */
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  Ref,
  RefCallback,
} from 'react'
import { createContext, Fragment, useContext } from 'react'
import type { ItemInstance } from '@headless-tree/core'
import { Slot } from 'radix-ui'
import { ChevronDown, Minus, Plus } from 'lucide-react'

import { cn } from '@/lib/cn'
import { Icon } from './Icon'

type ToggleIconType = 'chevron' | 'plus-minus'

// As installed: the instance's features vary per tree, so its type is open.
type AnyTree = any
type AnyData = any

interface TreeContextValue<T = AnyData> {
  indent: number
  currentItem?: ItemInstance<T>
  tree?: AnyTree
  toggleIconType?: ToggleIconType
}

const TreeContext = createContext<TreeContextValue>({
  indent: 20,
  currentItem: undefined,
  tree: undefined,
  toggleIconType: 'plus-minus',
})

function useTreeContext<T = AnyData>() {
  return useContext(TreeContext) as TreeContextValue<T>
}

/** Both refs see the element: the instance's (focus, hotkeys) and the holder's. */
function composeRefs<E>(...refs: (Ref<E> | undefined)[]): RefCallback<E> {
  return (el) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(el)
      else if (ref) ref.current = el
    }
  }
}

interface TreeProps extends HTMLAttributes<HTMLDivElement> {
  indent?: number
  tree?: AnyTree
  toggleIconType?: ToggleIconType
  asChild?: boolean
  ref?: Ref<HTMLDivElement>
}

function Tree({
  indent = 20,
  tree,
  className,
  toggleIconType = 'chevron',
  asChild = false,
  ref,
  ...props
}: TreeProps) {
  const containerProps =
    tree && typeof tree.getContainerProps === 'function' ? tree.getContainerProps() : {}
  const mergedProps = { ...containerProps, ...props }

  // Extract style from mergedProps to merge with our custom styles
  const { style: propStyle, ref: containerRef, ...otherProps } = mergedProps

  // Merge styles
  const mergedStyle = {
    ...propStyle,
    '--tree-indent': `${indent}px`,
  } as CSSProperties

  const Comp = asChild ? Slot.Root : 'div'

  return (
    <TreeContext.Provider value={{ indent, tree, toggleIconType }}>
      <Comp
        data-slot="tree"
        style={mergedStyle}
        className={cn('flex flex-col', className)}
        ref={composeRefs(containerRef, ref)}
        {...otherProps}
      />
    </TreeContext.Provider>
  )
}

interface TreeItemProps<T = AnyData> extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'indent'
> {
  item: ItemInstance<T>
  indent?: number
  asChild?: boolean
  ref?: Ref<HTMLButtonElement>
}

function TreeItem<T = AnyData>({
  item,
  className,
  asChild = false,
  children,
  ref,
  ...props
}: TreeItemProps<T>) {
  const parentContext = useTreeContext<T>()
  const { indent } = parentContext

  const itemProps: Record<string, AnyData> =
    typeof item.getProps === 'function' ? item.getProps() : {}
  const mergedProps: Record<string, AnyData> = { ...itemProps, ...props, children }

  // Extract style from mergedProps to merge with our custom styles
  const { style: propStyle, ref: itemRef, ...otherProps } = mergedProps

  // Merge styles
  const mergedStyle = {
    ...propStyle,
    '--tree-padding': `${item.getItemMeta().level * indent}px`,
  } as CSSProperties

  const defaultProps = {
    'data-slot': 'tree-item',
    style: mergedStyle,
    className: cn(
      'z-10 ps-(--tree-padding) text-left outline-hidden select-none not-last:pb-0.5 focus:z-20 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    ),
    'data-focus': typeof item.isFocused === 'function' ? item.isFocused() || false : undefined,
    'data-folder': typeof item.isFolder === 'function' ? item.isFolder() || false : undefined,
    'data-selected': typeof item.isSelected === 'function' ? item.isSelected() || false : undefined,
    'data-drag-target':
      typeof item.isDragTarget === 'function' ? item.isDragTarget() || false : undefined,
    'data-search-match':
      typeof item.isMatchingSearch === 'function' ? item.isMatchingSearch() || false : undefined,
    'aria-expanded': item.isExpanded(),
  }

  const Comp = asChild ? Slot.Root : 'button'

  return (
    <TreeContext.Provider value={{ ...parentContext, currentItem: item }}>
      <Comp {...defaultProps} {...otherProps} ref={composeRefs(itemRef, ref)}>
        {children}
      </Comp>
    </TreeContext.Provider>
  )
}

interface TreeItemLabelProps<T = AnyData> extends HTMLAttributes<HTMLSpanElement> {
  item?: ItemInstance<T>
  asChild?: boolean
  /** Wraps a folder's chevron, for a tree whose chevron does something the
   *  row does not (a folder document's row opens it; its chevron shows its files). */
  renderToggle?: (chevron: ReactNode) => ReactNode
}

function TreeItemLabel<T = AnyData>({
  item: propItem,
  children,
  className,
  asChild = false,
  renderToggle = (chevron) => chevron,
  ...props
}: TreeItemLabelProps<T>) {
  const { currentItem, toggleIconType } = useTreeContext<T>()
  const item = propItem || currentItem

  if (!item) {
    console.warn('TreeItemLabel: No item provided via props or context')
    return null
  }

  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="tree-item-label"
      className={cn(
        'flex items-center gap-1 motion-respond not-in-data-[folder=true]:ps-7 hover:bg-foreground/[0.04] in-focus-visible:ring-1 in-focus-visible:ring-ring in-data-[drag-target=true]:bg-foreground/[0.08] in-data-[search-match=true]:bg-foreground/[0.06] in-data-[selected=true]:bg-foreground/[0.06] in-data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0',
        'rounded-md',
        'py-1',
        'px-2',
        'text-nav',
        className,
      )}
      {...props}
    >
      <Fragment>
        {item.isFolder() &&
          renderToggle(
            toggleIconType === 'plus-minus' ? (
              <Icon icon={item.isExpanded() ? Minus : Plus} size="sm" tone="muted" />
            ) : (
              <Icon
                icon={ChevronDown}
                tone="muted"
                className="in-aria-[expanded=false]:-rotate-90"
              />
            ),
          )}
        {children || (typeof item.getItemName === 'function' ? item.getItemName() : null)}
      </Fragment>
    </Comp>
  )
}

function TreeDragLine({ className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { tree } = useTreeContext()

  // From the instance's drag-and-drop feature when it has one, else from
  // `style`: a tree that runs its own drop places the line itself.
  const dragLine =
    tree && typeof tree.getDragLineStyle === 'function' ? tree.getDragLineStyle() : undefined
  if (dragLine === undefined && style === undefined) return null

  return (
    <div
      style={{ ...dragLine, ...style }}
      className={cn(
        'absolute z-30 -mt-px h-0.5 w-[unset] bg-primary before:absolute before:-top-[3px] before:left-0 before:size-2 before:border-2 before:border-primary before:bg-background',
        'before:rounded-full',
        className,
      )}
      {...props}
    />
  )
}

export { Tree, TreeItem, TreeItemLabel, TreeDragLine }
