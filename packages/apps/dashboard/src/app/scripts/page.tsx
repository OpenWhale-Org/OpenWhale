import { ScriptsClient } from './ScriptsClient'

export const dynamic = 'force-dynamic'

/* The header lives in the client: its right-hand action (Manage) toggles
   client state, so splitting the two would mean lifting that state up here
   for nothing. Same arrangement as the instances page. */
export default function ScriptsPage() {
  return <ScriptsClient />
}
