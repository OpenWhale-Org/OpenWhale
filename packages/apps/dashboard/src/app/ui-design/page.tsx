import { UiDesignClient } from './UiDesignClient'

export const dynamic = 'force-dynamic'

export default function UiDesignPage() {
  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold mb-1">UI Design Standard</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--muted)' }}>
        The living visual standard for the OpenWhale dashboard. Every page composes these
        tokens and component classes — if a control is not on this page, it should look like one that is.
      </p>
      <UiDesignClient />
    </div>
  )
}
