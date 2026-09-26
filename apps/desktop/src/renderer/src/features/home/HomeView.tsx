/**
 * Home (D108): a surface of its own, opened from the nav menu. Today it is the
 * empty editor's state, nothing open; it is a tab rather than "close
 * everything" so it can become a dashboard without changing what Home is.
 */
export function HomeView(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      select or create a note
    </div>
  )
}
