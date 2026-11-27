// The DATABRAIN_TEST_* and NB_TEST_* variables exist for tests. A real session (HOME is the real home folder) ignores every one of them:
// they are removed from the environment before anything else starts, so no child process sees them either.
import os from 'node:os';

export const isRealHome = () => (process.env.HOME || os.userInfo().homedir) === os.userInfo().homedir;

if (isRealHome()) for (const name of Object.keys(process.env)) if (name.startsWith('DATABRAIN_TEST_') || name.startsWith('NB_TEST_')) delete process.env[name];

// For modules that read a hook directly (so a hook added later cannot slip past the guard above).
export const testHook = name => (isRealHome() ? undefined : process.env[name]);
