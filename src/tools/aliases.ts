// Tool-name equivalence map. pentesterflow registers each capability
// tool under TWO names — the Unix-style canonical (shell, file_read,
// file_write, file_edit) and the PascalCase alias (BashTool,
// FileReadTool, FileWriteTool, FileEditTool). Models trained against
// different prompt corpora reach for one or the other; both are wired
// to the same implementation.
//
// The allowed-tools enforcer in agent.ts uses canonicalization to make
// sure a skill that declared `tools: [shell]` also lets the model call
// the equivalent `BashTool`, and vice versa. Without this, a model that
// reaches for `BashTool` would hit `BashTool not in allowed-tools` even
// though the skill author thought they'd authorized bash.

const TOOL_NAME_TO_CANONICAL: Record<string, string> = {
  // Shell variants.
  shell: 'shell',
  bash: 'shell',
  BashTool: 'shell',
  // File ops.
  file_read: 'file_read',
  FileReadTool: 'file_read',
  file_write: 'file_write',
  FileWriteTool: 'file_write',
  file_edit: 'file_edit',
  FileEditTool: 'file_edit',
  // Search + ask. The tools register under PascalCase / suffixed names
  // (GlobTool, GrepTool, ask_user); map the bare forms a skill author might
  // write so either spelling canonicalizes to the real runtime name and the
  // allowed-tools enforcer matches (L14).
  glob: 'GlobTool',
  GlobTool: 'GlobTool',
  grep: 'GrepTool',
  GrepTool: 'GrepTool',
  ask: 'ask_user',
  ask_user: 'ask_user',
};

/**
 * Return the canonical (Unix-style) name for a tool. Unknown names pass
 * through unchanged so tools without aliases (http, web_fetch, etc.)
 * still compare correctly via straight equality.
 */
export function canonicalToolName(name: string): string {
  return TOOL_NAME_TO_CANONICAL[name] ?? name;
}

/**
 * Every tool name (canonical + PascalCase aliases) the agent
 * registers in cli/index.ts. Used to validate a skill's `allowed-tools`
 * so a typo is caught by the conformance test rather than failing
 * silently at runtime. Keep in sync with registerBuiltinTools().
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'shell',
  'bash',
  'BashTool',
  'file_read',
  'FileReadTool',
  'file_write',
  'FileWriteTool',
  'file_edit',
  'FileEditTool',
  // Search + ask: include the actual registered names (GlobTool/GrepTool/
  // ask_user) so a skill declaring the correct runtime name validates, plus the
  // bare aliases which now canonicalize to them (L14).
  'glob',
  'GlobTool',
  'grep',
  'GrepTool',
  'http',
  'web_fetch',
  'web_search',
  'ask',
  'ask_user',
  'confirm_finding',
  'load_skill',
  'read_payloads',
  'read_skill_file',
  'coverage',
]);
