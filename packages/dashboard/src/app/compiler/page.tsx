export default function CompilerPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Compiler</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Compile and load TypeScript strategies, monitors, and executors at runtime
        </p>
      </div>
      <div
        className="flex flex-col items-center justify-center rounded-lg border py-24 text-center"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-4xl mb-4">🚧</span>
        <p className="text-lg font-medium">Coming Soon</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
          The compiler UI is under development.
        </p>
      </div>
    </div>
  )
}
