// Test fixture: reads the plugin's stdin JSON and mirrors it (plus the env
// mirrors) into the file given as argv[2], then prints one line to stdout.
import fs from 'node:fs'

let raw = ''
process.stdin.on('data', (d) => { raw += String(d) })
process.stdin.on('end', () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({
    stdin: raw,
    reason: process.env.NOTIFY_HUB_REASON || process.env.IDLE_HOOK_REASON || null,
    session: process.env.NOTIFY_HUB_SESSION_ID || process.env.IDLE_HOOK_SESSION_ID || null,
    cwdMarker: process.env.NOTIFY_HUB_CWD || process.env.IDLE_HOOK_CWD || null,
    globalOnly: process.env.GLOBAL_ONLY || null,
    ruleOnly: process.env.RULE_ONLY || null,
  }))
  process.stdout.write('probe done')
})
