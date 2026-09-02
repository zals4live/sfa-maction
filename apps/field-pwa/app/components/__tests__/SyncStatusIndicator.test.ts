import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { ConnectivityState } from '@maction/types'
import SyncStatusIndicator from '../SyncStatusIndicator.vue'

// The Nuxt UI components (`UIcon`, `UBadge`) are auto-imported at runtime and are not
// available in the node test environment, so we stub them with lightweight components that
// expose their inputs as inspectable DOM: UIcon reflects `name` + `class`, and UBadge
// reflects `color` and its default slot. This keeps the assertions focused on the props the
// indicator wires up (icon name, semantic color class, label, pending-count badge).
const UIconStub = defineComponent({
  name: 'UIcon',
  props: { name: { type: String, default: '' } },
  setup(props, { attrs }) {
    return () => h('span', { 'data-icon': props.name, 'class': attrs.class })
  }
})

const UBadgeStub = defineComponent({
  name: 'UBadge',
  props: { color: { type: String, default: '' } },
  setup(props, { slots }) {
    return () => h('span', { 'data-badge': '', 'data-color': props.color }, slots.default?.())
  }
})

/** Server-render the indicator for a given state/backlog and return the HTML string. */
async function render(state: ConnectivityState, pendingCount: number): Promise<string> {
  const app = createSSRApp(SyncStatusIndicator, { state, pendingCount })
  app.component('UIcon', UIconStub)
  app.component('UBadge', UBadgeStub)
  return renderToString(app)
}

describe('SyncStatusIndicator', () => {
  it('should render an accessible live status region', async () => {
    const html = await render('ONLINE', 0)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it('should present ONLINE with the wifi icon, success color, and Indonesian label', async () => {
    const html = await render('ONLINE', 0)
    expect(html).toContain('data-icon="i-lucide-wifi"')
    expect(html).toContain('text-success')
    expect(html).toContain('Online')
  })

  it('should present OFFLINE with the wifi-off icon and warning color', async () => {
    const html = await render('OFFLINE', 0)
    expect(html).toContain('data-icon="i-lucide-wifi-off"')
    expect(html).toContain('text-warning')
    expect(html).toContain('Offline')
  })

  it('should present SYNCING with the refresh icon and warning color', async () => {
    const html = await render('SYNCING', 0)
    expect(html).toContain('data-icon="i-lucide-refresh-cw"')
    expect(html).toContain('text-warning')
    expect(html).toContain('Menyinkron')
  })

  it('should present ERROR with the alert icon and error color', async () => {
    const html = await render('ERROR', 0)
    expect(html).toContain('data-icon="i-lucide-triangle-alert"')
    expect(html).toContain('text-error')
    expect(html).toContain('Gagal sinkron')
  })

  it('should show the pending-count badge only when the backlog is greater than zero', async () => {
    const withBacklog = await render('OFFLINE', 3)
    expect(withBacklog).toContain('data-badge')
    expect(withBacklog).toContain('data-color="warning"')
    expect(withBacklog).toContain('3')

    const withoutBacklog = await render('ONLINE', 0)
    expect(withoutBacklog).not.toContain('data-badge')
  })
})
