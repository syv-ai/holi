const $ = (id) => document.getElementById(id)
const notes = holi.store('notes')
const appEl = $('app')
let all = [] // [{ id, value: { body, createdAt, updatedAt } }]
let selected = null
let timer = null

const DAY = 86400000
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'long' })
const fmtFull = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) +
  ' at ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function title(body) {
  const first = body.split('\n').find((l) => l.trim())
  return first ? first.trim() : 'New Note'
}
function preview(body) {
  const lines = body.split('\n').filter((l) => l.trim())
  return lines[1] ? lines[1].trim() : 'No additional text'
}
function group(ts) {
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const age = startOfToday - ts
  if (ts >= startOfToday) return 'Today'
  if (age < 7 * DAY) return 'Previous 7 Days'
  if (age < 30 * DAY) return 'Previous 30 Days'
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
function stampShort(ts) {
  const d = new Date(ts)
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (startOfToday - ts < 7 * DAY) return ts >= startOfToday ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : fmtDay(d)
  return d.toLocaleDateString()
}

function renderList() {
  const q = $('q').value.trim().toLowerCase()
  const rows = all
    .filter((r) => !q || r.value.body.toLowerCase().includes(q))
    .sort((a, b) => b.value.updatedAt - a.value.updatedAt)
  $('count').textContent = `${all.length} note${all.length === 1 ? '' : 's'}`
  const list = $('list')
  list.textContent = ''
  let last = null
  for (const r of rows) {
    const g = group(r.value.updatedAt)
    if (g !== last) {
      const h = document.createElement('div')
      h.className = 'group'
      h.textContent = g
      list.append(h)
      last = g
    }
    const b = document.createElement('button')
    b.className = 'item' + (r.id === selected ? ' sel' : '')
    b.innerHTML = '<div class="t"></div><div class="s"><b></b><span></span></div>'
    b.querySelector('.t').textContent = title(r.value.body)
    b.querySelector('b').textContent = stampShort(r.value.updatedAt)
    b.querySelector('span').textContent = preview(r.value.body)
    b.onclick = () => select(r.id)
    list.append(b)
  }
}

function select(id) {
  flush()
  selected = id
  const r = all.find((x) => x.id === id)
  appEl.classList.toggle('none', !r)
  appEl.classList.remove('show-list')
  appEl.classList.add('show-editor')
  if (r) {
    $('body').value = r.value.body
    $('stamp').textContent = fmtFull(new Date(r.value.updatedAt))
    $('body').focus()
  }
  renderList()
}

function flush() {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  save()
}

async function save() {
  const r = all.find((x) => x.id === selected)
  if (!r) return
  await notes.put(r.id, r.value)
}

async function createNote() {
  flush()
  const now = Date.now()
  const value = { body: '', createdAt: now, updatedAt: now }
  const id = await notes.put(value)
  all.push({ id, value })
  select(id)
}

$('new').onclick = () => createNote().catch(showErr)
$('back').onclick = () => {
  flush()
  appEl.classList.remove('show-editor')
  appEl.classList.add('show-list')
}
$('q').oninput = renderList
$('body').oninput = () => {
  const r = all.find((x) => x.id === selected)
  if (!r) return
  r.value.body = $('body').value
  r.value.updatedAt = Date.now()
  $('stamp').textContent = fmtFull(new Date(r.value.updatedAt))
  renderList()
  clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    save().catch(showErr)
  }, 400)
}
$('del').onclick = async () => {
  if (!selected || !confirm('Delete this note?')) return
  clearTimeout(timer)
  timer = null
  const id = selected
  all = all.filter((x) => x.id !== id)
  selected = null
  await notes.delete(id)
  const next = [...all].sort((a, b) => b.value.updatedAt - a.value.updatedAt)[0]
  next ? select(next.id) : (appEl.classList.add('none'), renderList())
}

function showErr(err) {
  $('err').textContent = `failed: ${err.message ?? err}`
}

async function load() {
  all = await notes.list()
  renderList()
}

appEl.classList.add('none')
load()
  .then(() => {
    const first = [...all].sort((a, b) => b.value.updatedAt - a.value.updatedAt)[0]
    // Wide panes open the latest note; narrow ones stay on the list.
    if (first && window.innerWidth > 560) select(first.id)
  })
  .catch(showErr)

holi.on('store:notes', async () => {
  if (timer) return // don't clobber unsaved typing
  const keep = $('body').value
  all = await notes.list()
  const r = all.find((x) => x.id === selected)
  if (r && r.value.body !== keep) $('body').value = r.value.body
  renderList()
})
window.addEventListener('pagehide', flush)
