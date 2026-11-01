/**
 * lib/root.mjs — where the memory lives.
 *
 * Order from most explicit to least, never silently writing into a source tree:
 *   1. --root CLI flag
 *   2. $PA_MEMORY_ROOT
 *   3. $DSH_HOME/storages/personal-agent          (DSH home, when exported)
 *   4. $DSH_PROFILE_DIR/../../storages/personal-agent
 *   5. cwd that looks like .../profiles/<name> → ../../storages/personal-agent
 *   6. $USERPROFILE/.dsh/storages/personal-agent  (Windows default)
 *   7. cwd/.memory                                (last resort, self-contained)
 *
 * `<home>/storages/personal-agent` is the same directory the DSH personal-agent
 * plugin uses, so the CLI and the plugin share one memory by default.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const STORE_SUBPATH = ['storages', 'personal-agent']

export function resolveRoot({ flag, env = process.env, cwd = process.cwd() } = {}) {
  if (flag) return { root: resolve(flag), source: '--root' }
  if (env.PA_MEMORY_ROOT) return { root: resolve(env.PA_MEMORY_ROOT), source: 'PA_MEMORY_ROOT' }
  if (env.DSH_HOME) return { root: join(env.DSH_HOME, ...STORE_SUBPATH), source: 'DSH_HOME' }
  if (env.DSH_PROFILE_DIR) {
    return { root: join(env.DSH_PROFILE_DIR, '..', '..', ...STORE_SUBPATH), source: 'DSH_PROFILE_DIR' }
  }
  if (/(^|[\\/])profiles[\\/][^\\/]+$/.test(cwd)) {
    return { root: join(cwd, '..', '..', ...STORE_SUBPATH), source: 'cwd-profile' }
  }
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  if (home) return { root: join(home, '.dsh', ...STORE_SUBPATH), source: 'userprofile' }
  return { root: join(cwd, '.memory'), source: 'cwd-fallback' }
}
