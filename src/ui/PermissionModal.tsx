// Centered permission modal. y = allow once, a = allow this session,
// n = deny.

import { Box, Text, useInput } from 'ink';
import { displayToolName } from '../tools/toolDisplay.js';
import type { PermissionRequest } from './permBridge.js';

// Tools whose `detail` is the literal thing being executed/sent (a shell
// command, an HTTP request, a file write/edit). For these the user must see
// the exact payload — not a summary — before approving, so we render the
// detail verbatim in a code box rather than as dim, truncated prose.
const COMMAND_TOOLS = new Set([
  'shell',
  'bash',
  'BashTool',
  'http',
  'file_write',
  'FileWriteTool',
  'file_edit',
  'FileEditTool',
]);

/** True when the request's detail is an exact command/payload worth showing. */
export function isCommandTool(tool: string): boolean {
  return COMMAND_TOOLS.has(tool);
}

// Command detail is shown in full up to a generous ceiling — far higher than
// the prose cap, because approving a command you can't fully see is the exact
// risk we're guarding against. Only a pathological multi-KB payload gets cut.
const COMMAND_DETAIL_CAP = 8000;
const PROSE_DETAIL_CAP = 1200;

export function PermissionModal({
  req,
}: {
  req: PermissionRequest;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      req.resolve('deny');
      return;
    }
    const ch = input?.toLowerCase() ?? '';
    if (ch === 'y') req.resolve('allow-once');
    else if (ch === 'a') req.resolve('allow-session');
    else if (ch === 'n') req.resolve('deny');
  });

  const showDetail = req.detail && req.detail !== req.summary;
  const asCommand = isCommandTool(req.tool);

  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Text color="magenta" bold>
        Permission requested: {displayToolName(req.tool)}
      </Text>
      <Box marginTop={1}>
        <Text color="white">{req.summary}</Text>
      </Box>
      {showDetail ? (
        asCommand ? (
          // Exact command/payload, framed and untruncated (within reason) so
          // the user approves precisely what runs.
          <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="cyan">{truncate(req.detail, COMMAND_DETAIL_CAP)}</Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color="gray">{truncate(req.detail, PROSE_DETAIL_CAP)}</Text>
          </Box>
        )
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">
          <Text color="green" bold>
            y
          </Text>{' '}
          allow once ·{' '}
          <Text color="green" bold>
            a
          </Text>{' '}
          allow session ·{' '}
          <Text color="red" bold>
            n
          </Text>{' '}
          deny · Esc deny
        </Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[... truncated ...]`;
}
