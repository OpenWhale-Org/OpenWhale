import { redirect } from 'next/navigation'

// The Registry merged into the Plugins page (2026-08-25) — components are
// browsed per plugin there; compiled imports live under External → AI Compiled.
export default function RegistryPage() {
  redirect('/plugins')
}
