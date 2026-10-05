const $ = (id) => document.getElementById(id)
const meetings = holi.store('meetings')
const settings = holi.store('settings')

let rec = null // { startedAt, tick } while Holi records
const pending = new Map() // meeting id -> Blob kept in memory until transcribed

const showErr = (e) => {
  $('err').textContent = e ? `failed: ${e.message ?? e}` : ''
  if (e) holi.log?.(String(e.stack ?? e))
}
const setStatus = (s) => ($('status').textContent = s)
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0')

// ── settings ────────────────────────────────────────────────────────────────
async function loadCfg() {
  const c = await settings.get('main')
  if (!c) return
  for (const k of ['url', 'model', 'lang', 'key']) if (c[k] != null) $(k).value = c[k]
}
$('saveCfg').onclick = async () => {
  try {
    await settings.put('main', {
      url: $('url').value.trim(), model: $('model').value.trim(),
      lang: $('lang').value.trim(), key: $('key').value.trim(),
    })
    setStatus('Settings saved (stored on this machine only).')
  } catch (e) { showErr(e) }
}

// ── capture ─────────────────────────────────────────────────────────────────
// Any meeting tool (Teams, Meet, Zoom, Webex…) works the same way: we never
// join the call. Holi records (a) your microphone and (b) the computer's sound
// (the meeting, whatever app plays it) mixed into one track, through
// holi.record: an app's frame cannot record for itself.
async function startRecording() {
  showErr(null)
  const microphone = $('useMic').checked
  const system = $('useSys').checked
  if (!microphone && !system) throw new Error('Pick at least one audio source.')
  setStatus('Starting…')
  await holi.record.start({ microphone, system })
  rec = { startedAt: Date.now() }
  rec.tick = setInterval(() => ($('timer').textContent = fmt((Date.now() - rec.startedAt) / 1000)), 500)
  $('start').hidden = true
  $('stop').hidden = false
  setStatus('Recording…')
}

async function finishRecording() {
  const r = rec
  if (!r) return
  rec = null
  clearInterval(r.tick)
  $('level').style.width = '0'
  $('stop').hidden = true
  $('start').hidden = false
  setStatus('Finishing the recording…')
  const blob = await holi.record.stop()
  const duration = Math.round((Date.now() - r.startedAt) / 1000)
  const now = new Date()
  const id = now.toISOString().replace(/[:.]/g, '-')
  const rec0 = { title: 'Meeting ' + now.toLocaleString(), startedAt: r.startedAt, duration, state: 'queued', segments: [] }
  await meetings.put(id, rec0)
  pending.set(id, blob)
  await transcribe(id)
}

// Servers label speakers as 0, "0", "SPEAKER_00", "speaker_1", "A"… — show them all as "Speaker N".
const speakerIds = new Map()
function speakerName(v) {
  if (v == null || v === '') return 'Speaker 1'
  const n = typeof v === 'number' ? v : /^\D*(\d+)$/.test(String(v)) ? Number(String(v).match(/(\d+)$/)[1]) : null
  if (n != null) return `Speaker ${n + 1}`
  const k = String(v)
  if (!speakerIds.has(k)) speakerIds.set(k, speakerIds.size + 1)
  return `Speaker ${speakerIds.get(k)}`
}

// ── transcription (same call memoctopus makes) ──────────────────────────────
async function transcribe(id) {
  const blob = pending.get(id)
  const m = await meetings.get(id)
  if (!m) return
  if (!blob) return showErr(new Error('The audio is gone (app was reloaded). Nothing to retry.'))
  try {
    await meetings.put(id, { ...m, state: 'transcribing', error: '' })
    setStatus('Sending audio for transcription…')
    const cfg = (await settings.get('main')) || {}
    const base = (cfg.url || 'https://platform.syv.ai/v1').replace(/\/+$/, '')
    if (!cfg.key) throw new Error('Add your API key under “Transcription service” first.')
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
    const form = new FormData()
    form.append('file', new File([blob], `audio.${ext}`, { type: blob.type }))
    form.append('model', cfg.model || 'syv-transcribe')
    form.append('language', cfg.lang || 'da')
    form.append('response_format', 'verbose_json')
    form.append('diarize', 'true')
    form.append('temperature', '0')
    const res = await holi.fetch(`${base}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form,
    })
    if (!res.ok) throw new Error(`Transcription server returned ${res.status}`)
    const data = await res.json()
    const raw = Array.isArray(data.segments) ? data.segments : []
    // Diagnostic: shows in log.local.txt whether the server returned speaker labels at all.
    holi.log?.(`transcribe: ${raw.length} segments, keys=${Object.keys(raw[0] ?? {}).join(',')}, speakers=${[...new Set(raw.map((s) => s.speaker ?? s.speaker_id ?? s.label))].join('|')}`)
    const segments = raw
      .map((s) => ({
        speaker: speakerName(s.speaker ?? s.speaker_id ?? s.label),
        start: s.start ?? 0, end: s.end ?? 0, text: (s.text ?? '').trim(),
      }))
      .filter((s) => s.text)
    if (!segments.length && data.text) segments.push({ speaker: 'Speaker 1', start: 0, end: m.duration, text: data.text.trim() })
    await meetings.put(id, { ...m, state: 'done', segments })
    pending.delete(id)
    setStatus('Transcript ready.')
  } catch (e) {
    await meetings.put(id, { ...m, state: 'failed', error: String(e.message ?? e) })
    setStatus('Transcription failed. Audio is kept until you reload — retry or save it.')
    showErr(e)
  }
}

// ── list ────────────────────────────────────────────────────────────────────
async function render() {
  const rows = (await meetings.list()).sort((a, b) => (a.id < b.id ? 1 : -1))
  const el = $('meetings')
  el.textContent = ''
  for (const { id, value: m } of rows) {
    const card = document.createElement('div')
    card.className = 'card mt'
    const head = document.createElement('div')
    head.className = 'row head'
    const tog = document.createElement('button')
    tog.className = 'icon'
    tog.textContent = m.collapsed ? '▸' : '▾'
    tog.title = m.collapsed ? 'Expand' : 'Collapse'
    tog.onclick = () => meetings.put(id, { ...m, collapsed: !m.collapsed }).catch(showErr)
    const h = document.createElement('h3')
    h.textContent = `${m.title} · ${fmt(m.duration)}`
    h.onclick = tog.onclick
    const ren = document.createElement('button')
    ren.className = 'icon'
    ren.textContent = '✎'
    ren.title = 'Rename'
    ren.onclick = () => {
      const inp = document.createElement('input')
      inp.value = m.title
      let done = false
      const save = async (ok) => {
        if (done) return
        done = true
        const t = inp.value.trim()
        try {
          if (ok && t && t !== m.title) await meetings.put(id, { ...m, title: t })
          else await render()
        } catch (e) { showErr(e) }
      }
      inp.onkeydown = (e) => { if (e.key === 'Enter') save(true); else if (e.key === 'Escape') save(false) }
      inp.onblur = () => save(true)
      h.replaceWith(inp)
      inp.focus()
      inp.select()
    }
    head.append(tog, h, ren)
    card.append(head)
    const st = document.createElement('div')
    st.className = 'state'
    st.textContent = m.state === 'failed' ? `Failed: ${m.error}` : m.state === 'done' ? '' : m.state + '…'
    if (st.textContent) card.append(st)
    if (m.collapsed) { el.append(card); continue }
    for (const s of m.segments) {
      const d = document.createElement('div')
      d.className = 'seg'
      d.innerHTML = '<span class="spk"></span><span class="tx"></span>'
      d.querySelector('.spk').textContent = `${s.speaker} ${fmt(s.start)}`
      d.querySelector('.tx').textContent = s.text
      card.append(d)
    }
    const row = document.createElement('div')
    row.className = 'row'
    if (pending.has(id) && m.state !== 'transcribing') {
      const r = document.createElement('button')
      r.textContent = 'Retry transcription'
      r.onclick = () => transcribe(id)
      const s = document.createElement('button')
      s.textContent = 'Save audio'
      s.onclick = () => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(pending.get(id))
        a.download = `${id}.${pending.get(id).type.includes('mp4') ? 'mp4' : 'webm'}`
        a.click()
      }
      row.append(r, s)
    }
    if (m.segments.length) {
      const c = document.createElement('button')
      c.textContent = 'Copy transcript'
      c.onclick = () => navigator.clipboard?.writeText(m.segments.map((s) => `${s.speaker} [${fmt(s.start)}]: ${s.text}`).join('\n'))
      row.append(c)
    }
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.onclick = async () => {
      if (del.textContent === 'Delete') {
        del.textContent = 'Click again to delete'
        setTimeout(() => { del.textContent = 'Delete' }, 3000)
        return
      }
      try { pending.delete(id); await meetings.delete(id); await render() } catch (e) { showErr(e) }
    }
    row.append(del)
    card.append(row)
    el.append(card)
  }
}

$('start').onclick = () => startRecording().catch((e) => { showErr(e); setStatus('Not recording.') })
$('stop').onclick = () => finishRecording().catch(showErr)
holi.on('store:meetings', () => render().catch(showErr))
loadCfg().then(render).catch(showErr)
