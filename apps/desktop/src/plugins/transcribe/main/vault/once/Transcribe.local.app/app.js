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
  setDeck('recording')
  setStatus('Recording…')
}

async function finishRecording() {
  const r = rec
  if (!r) return
  rec = null
  clearInterval(r.tick)
  $('level').style.width = '0'
  setDeck('idle')
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

const TAGS = { idle: 'Ready', starting: 'Starting', recording: 'Recording' }
function setDeck(s) {
  $('rec').dataset.state = s
  $('tag').textContent = TAGS[s] ?? s
  $('recBtn').setAttribute('aria-label', s === 'recording' ? 'Stop and transcribe' : 'Start recording')
}
$('recBtn').onclick = () => {
  if (rec) return finishRecording().catch(showErr)
  setDeck('starting')
  startRecording().catch((e) => { setDeck('idle'); showErr(e); setStatus('Not recording.') })
}
holi.on('store:meetings', () => render().catch(showErr))
loadCfg().then(render).catch(showErr)

// ── live waveform (ElevenLabs "static" style) ──────────────────────────────
// Bars stay in place and each one is a slice of the spectrum, lowest pitch in
// the middle, mirrored outward. Holi pushes the 32 bands about 20 times a
// second while recording: holi.record.onSpectrum(fn(bands)).
const wave = (() => {
  const cv = $('wave')
  const ctx = cv.getContext('2d')
  const BAR = 3, GAP = 3, STEP = BAR + GAP
  let bands = null // latest spectrum
  let shown = [] // eased heights, one per bar
  const fit = () => {
    const r = window.devicePixelRatio || 1
    cv.width = cv.clientWidth * r
    cv.height = cv.clientHeight * r
    ctx.setTransform(r, 0, 0, r, 0, 0)
  }
  function draw() {
    requestAnimationFrame(draw)
    const w = cv.clientWidth, h = cv.clientHeight
    if (!w) return
    const on = $('rec').dataset.state === 'recording'
    if (!on) bands = null
    const n = Math.max(2, Math.floor(w / STEP))
    const st = getComputedStyle(document.body)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = (on ? st.getPropertyValue('--brand') : st.getPropertyValue('--muted-foreground')).trim() || '#888'
    const half = n / 2
    const x0 = (w - n * STEP + GAP) / 2
    for (let i = 0; i < n; i++) {
      // distance from the centre picks the band: low pitches in the middle
      const d = Math.abs(i + 0.5 - half) / half
      const raw = bands ? bands[Math.min(bands.length - 1, Math.floor(d * bands.length))] ?? 0 : 0
      const target = Math.pow(raw, 1.4) * (1 - 0.35 * d) // the highs run quieter: keep the shape
      shown[i] = (shown[i] ?? 0) + (target - (shown[i] ?? 0)) * (target > (shown[i] ?? 0) ? 0.5 : 0.18)
      const v = shown[i]
      const bh = Math.max(3, v * (h - 8))
      ctx.globalAlpha = on ? 0.4 + 0.6 * Math.min(1, v * 1.6) : 0.3
      ctx.beginPath()
      ctx.roundRect(x0 + i * STEP, (h - bh) / 2, BAR, bh, 1.5)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
  new ResizeObserver(fit).observe(cv)
  fit()
  requestAnimationFrame(draw)
  holi.record?.onSpectrum?.((b) => (bands = b))
})()
