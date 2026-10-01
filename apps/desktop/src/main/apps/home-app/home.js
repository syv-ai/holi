// The Home tab: what you opened recently, kept current as you work.
// `holi` is Holi's bridge, injected into this page; see the vault-apps skill.

const SHOWN = 8
const section = document.getElementById('recents')
const list = section.querySelector('ul')

/** What a recent is called on this page, and where it lives. */
function label(entry) {
  if (entry.kind === 'surface' && entry.id === undefined) {
    return { name: entry.key.charAt(0).toUpperCase() + entry.key.slice(1), where: '' }
  }
  // A path, or one of a surface's things by its path (an app).
  const path = entry.id ?? entry.key
  const slash = path.lastIndexOf('/')
  return {
    name: path.slice(slash + 1).replace(/\.(md|app)$/, ''),
    where: slash < 0 ? '' : path.slice(0, slash),
  }
}

async function render() {
  // Notes, apps and Holi's views: what `holi.open` can open. Home itself is
  // left out, since you are on it.
  const entries = (await holi.recents())
    .filter((e) => e.kind !== 'session' && !(e.kind === 'surface' && e.key === 'home'))
    .slice(0, SHOWN)
  list.replaceChildren(
    ...entries.map((entry) => {
      const { name, where } = label(entry)
      const button = document.createElement('button')
      button.innerHTML = '<span class="name"></span><span class="where"></span>'
      button.children[0].textContent = name
      button.children[1].textContent = where
      button.addEventListener('click', () => holi.open(entry.id ?? entry.key))
      const item = document.createElement('li')
      item.append(button)
      return item
    }),
  )
  section.hidden = entries.length === 0
}

holi.on('recents', render)
render()
