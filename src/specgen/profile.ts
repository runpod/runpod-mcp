// Which tool surface a connection gets. `default` is the full surface every
// client has always had. `directory` is what app directories (Anthropic's
// connector directory, OpenAI's plugin directory) list: their policies forbid
// tool descriptions that instruct the model, steer it toward other tools or
// external instructions, or collect conversation data beyond the tool's job.
// The directory profile is served only at DIRECTORY_PATH; nothing about the
// default surface changes.
export type ServerProfile = 'default' | 'directory';

export const DIRECTORY_PATH = '/directory';

/** Tools left out of the directory profile:
 *  - the bundled guides are behavioral instructions for the model (playbooks);
 *  - describe-tool exists only to serve schemas the directory profile already
 *    lists in full, and directories reject schema fetching;
 *  - create-secret, update-secret and create-registry take a secret or a
 *    password as input, which OpenAI's directory forbids collecting. */
export const DIRECTORY_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'list-guides',
  'read-guide',
  'describe-tool',
  'create-secret',
  'update-secret',
  'create-registry',
]);

export function profileForPath(pathname: string): ServerProfile {
  return pathname.replace(/\/+$/, '') === DIRECTORY_PATH
    ? 'directory'
    : 'default';
}
