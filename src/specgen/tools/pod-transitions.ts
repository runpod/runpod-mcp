// The directory profile's Pod state transitions. pod-action takes the
// transition as an argument (start, stop, restart, terminate), and OpenAI's
// plugin review asks for each model-callable operation as its own tool with
// its own annotations. These three wrap pod-action with the transition fixed;
// terminate is delete-pod. The default profile keeps pod-action.
import type { CuratedTool, ToolAnnotations } from '../types.js';
import { dispatchGeneratedTool } from '../dispatch.js';
import { generatedTools } from '../generated/tools.gen.js';
import { write, destructiveWrite } from './annotations.js';
import { runTool } from './util.js';

const podAction = generatedTools.find((tool) => tool.name === 'pod-action');
if (!podAction)
  throw new Error('pod-action is missing from the generated tools');

const POD_ID = {
  type: 'object',
  properties: { id: { type: 'string', description: 'ID of the Pod' } },
  required: ['id'],
  additionalProperties: false,
} as const;

function transition(
  action: 'start' | 'stop' | 'restart',
  title: string,
  description: string,
  annotations: ToolAnnotations
): CuratedTool {
  return {
    name: `${action}-pod`,
    title,
    description,
    inputSchema: POD_ID,
    annotations,
    handler: (ctx, args) =>
      runTool(() =>
        dispatchGeneratedTool(ctx.sdk, podAction!, {
          id: args.id,
          body: { action },
        })
      ),
  };
}

export const podTransitionTools: CuratedTool[] = [
  transition(
    'start',
    'Start Pod',
    'Start a stopped Pod (status EXITED or ERROR). Billable: the Pod accrues its hourly price while it runs. Returns the updated Pod; a Pod in any other status returns 409.',
    write
  ),
  transition(
    'stop',
    'Stop Pod',
    'Stop a running or provisioning Pod. It releases its GPU or CPU and stops compute billing; the container disk is wiped, while the volume disk and any attached network volume keep their data and volume storage keeps billing. Returns the updated Pod; a Pod in any other status returns 409.',
    destructiveWrite
  ),
  transition(
    'restart',
    'Restart Pod',
    "Restart a running Pod's container in place. Whatever is running in the container is interrupted and the container disk is wiped; the volume disk and any attached network volume keep their data. Returns the updated Pod; a Pod that is not RUNNING returns 409.",
    destructiveWrite
  ),
];
