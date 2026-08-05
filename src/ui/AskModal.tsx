import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { AskRequest } from './askBridge.js';

const VIEWPORT = 12;

export function AskModal({ req }: { req: AskRequest }): React.ReactElement {
  const [idx, setIdx] = useState(0);
  const [scroll, setScroll] = useState(0);
  const options = req.question.options;
  const maxScroll = Math.max(0, options.length - VIEWPORT);

  useInput((input, key) => {
    if (key.escape) {
      req.reject(new Error('cancelled'));
      return;
    }
    if (key.upArrow) {
      setIdx((i) => {
        const next = (i - 1 + options.length) % options.length;
        setScroll((s) => (next < s ? next : next >= s + VIEWPORT ? next - VIEWPORT + 1 : s));
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setIdx((i) => {
        const next = (i + 1) % options.length;
        setScroll((s) => (next >= s + VIEWPORT ? s + 1 : next < s ? next : s));
        return next;
      });
      return;
    }
    if (key.return) {
      const picked = options[idx];
      if (picked) req.resolve(picked.label);
      return;
    }
    if (input >= '1' && input <= '9') {
      const n = Number.parseInt(input, 10) - 1;
      if (n < options.length) {
        setIdx(n);
        setScroll((s) => (n < s ? n : n >= s + VIEWPORT ? n - VIEWPORT + 1 : s));
      }
    }
  });

  const visible = options.slice(scroll, scroll + VIEWPORT);
  const showUp = scroll > 0;
  const showDown = scroll < maxScroll;

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      {req.question.header ? (
        <Text color="cyan" bold>
          [{req.question.header}]
        </Text>
      ) : null}
      <Text color="white" bold>
        {req.question.question}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {showUp ? <Text color="gray">  ↑ more above</Text> : null}
        {visible.map((o) => {
          const realIdx = scroll + visible.indexOf(o);
          const selected = realIdx === idx;
          return (
            <Text key={o.label} color={selected ? 'cyan' : 'white'}>
              {selected ? '› ' : '  '}
              {o.label}
              {o.description ? <Text color="gray"> — {o.description}</Text> : null}
            </Text>
          );
        })}
        {showDown ? <Text color="gray">  ↓ more below</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          {options.length > VIEWPORT
            ? `↑↓ navigate (${idx + 1}/${options.length}) · Enter pick · Esc cancel`
            : '↑↓ select · Enter pick · Esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}
