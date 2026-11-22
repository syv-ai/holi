import { ActionBar, defineComponent, h, ref } from 'nativescript-vue'
import { checkCompatibility } from './runtime.ios'

export default defineComponent({
  name: 'CompatibilityStatus',
  setup() {
    const status = ref('Running compatibility checks…')
    void checkCompatibility().then((result) => {
      status.value = result
    })
    // NativeScript views, not HTML: keep this small diagnostic UI in the TS graph.
    return () =>
      h('Frame', null, [
        h('Page', null, [
          h(ActionBar, { title: 'Holi compatibility' }),
          h('StackLayout', { padding: 24 }, [
            h('Label', { text: 'Vault format v1', fontSize: 24 }),
            h('Label', { text: status.value, textWrap: true, marginTop: 16 }),
            h('Label', {
              text: 'Shared TypeScript rules. Native UTF-8. No vault or credentials.',
              textWrap: true,
              marginTop: 16,
            }),
          ]),
        ]),
      ])
  },
})
