import type { HostHintAdapter, HostHintAdapterTarget } from '@/lib/host-hints'

const REQUEST = 'holi:community-hints:request'
const SNAPSHOT = 'holi:community-hints:snapshot'
const ACTIVATE = 'holi:community-hints:activate'
const LIMIT = 40

interface TargetDescriptor {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
}

/** An opt-in, request-scoped postMessage adapter. It never reads the guest DOM. */
export function createCommunityHintAdapter(frame: HTMLIFrameElement): HostHintAdapter {
  const origin = new URL(frame.src).origin
  const nonce = crypto.randomUUID()
  const generation = { value: 0 }
  let descriptors: TargetDescriptor[] = []
  let active = false
  let invalidated = false
  let invalidationCallback: (() => void) | null = null
  const proxy = document.createElement('div')

  const invalidate = () => {
    generation.value += 1
    invalidated = true
    active = false
    descriptors = []
    invalidationCallback?.()
  }
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return
    const data = event.data
    if (
      !active ||
      !data ||
      data.type !== SNAPSHOT ||
      data.nonce !== nonce ||
      data.generation !== generation.value ||
      !Array.isArray(data.targets) ||
      data.targets.length > LIMIT
    ) return
    descriptors = data.targets.filter((target: TargetDescriptor) =>
      target && typeof target.id === 'string' && target.id.length <= 128 &&
      typeof target.label === 'string' && target.label.length <= 160 &&
      [target.x, target.y, target.width, target.height].every(Number.isFinite) &&
      target.width > 0 && target.height > 0,
    )
  }
  window.addEventListener('message', receive)

  return {
    discover(): readonly HostHintAdapterTarget[] {
      if (!active || invalidated || !frame.isConnected || frame.inert) return []
      const rect = frame.getBoundingClientRect()
      return descriptors.flatMap((target) => {
        const x = rect.left + target.x
        const y = rect.top + target.y
        if (x < rect.left || y < rect.top || x + target.width > rect.right || y + target.height > rect.bottom) return []
        return [{ element: proxy, label: target.label, x: x + target.width / 2, y: y + target.height / 2, token: target.id }]
      })
    },
    unchanged() { return active && !invalidated && frame.isConnected && !frame.inert },
    capture() {
      if (!frame.isConnected || frame.inert) return
      invalidated = false
      active = true
      descriptors = []
      generation.value += 1
      frame.contentWindow?.postMessage({ type: REQUEST, nonce, generation: generation.value }, origin)
    },
    subscribe(callback) {
      invalidationCallback = callback
      const onFrameLoad = () => invalidate()
      frame.addEventListener('load', onFrameLoad)
      return () => { frame.removeEventListener('load', onFrameLoad); invalidationCallback = null; invalidate(); window.removeEventListener('message', receive) }
    },
    invalidate,
    activate(target) {
      if (!this.unchanged([]) || typeof target.token !== 'string') return false
      frame.contentWindow?.postMessage({ type: ACTIVATE, nonce, generation: generation.value, id: target.token }, origin)
      return true
    },
  }
}

/** Source for opt-in community pages; pages include this script themselves. */
export const COMMUNITY_HINT_BRIDGE = `(()=>{const R='holi:community-hints:request',S='holi:community-hints:snapshot',A='holi:community-hints:activate',N=40;let generation=0;const targets=()=>Array.from(document.querySelectorAll('button,a[href],input[type=button],input[type=submit],[role=button]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!e.disabled}).slice(0,N).map((e,i)=>{if(!e.dataset.holiHintId)e.dataset.holiHintId='h'+i;const r=e.getBoundingClientRect();return{id:e.dataset.holiHintId,label:(e.getAttribute('aria-label')||e.innerText||e.textContent||e.value||'').trim().slice(0,160),x:r.x,y:r.y,width:r.width,height:r.height}}).filter(t=>t.label)};addEventListener('message',e=>{if(e.source!==parent||e.data?.type!==R||typeof e.data.nonce!=='string'||!Number.isSafeInteger(e.data.generation))return;generation=e.data.generation;parent.postMessage({type:S,nonce:e.data.nonce,generation,targets:targets()},e.origin)});})();`
