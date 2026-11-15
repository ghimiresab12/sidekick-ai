/** `npm run demo` — prints the MOCK scenario's overlay and timeline. Not a live integration. */
import { runDemoScenario } from './demo-scenario.js';

const { timeline, overlayUpdates } = runDemoScenario();
console.log('MOCK session (no Chert, no model) — timeline for review:\n');
for (const event of timeline) {
  console.log(`${event.time}  ${event.type.padEnd(24)} ${event.summary}`);
}
const last = overlayUpdates.at(-1);
console.log(`\nOverlay updates pushed: ${overlayUpdates.length}`);
console.log(`Final overlay status: ${last?.status}; cards in history: ${last?.history.length}`);
