import { matchGlob } from './utils.js';
import { inspectProfileTool } from './toolProfiles.js';

const DEFAULT_READ_PATTERNS = [
  'get_*',
  'list_*',
  'find_*',
  'inspect_*',
  'read_*',
  '*overview*',
  '*screenshot*',
  '*console*',
  '*log*',
  '*logs*',
  '*status*',
  '*test*result*',
];

const DEFAULT_WRITE_PATTERNS = [
  'create_*',
  'set_*',
  'update_*',
  'delete_*',
  'add_*',
  'remove_*',
  'execute_*',
  'run_*',
  'build_*',
  '*write*',
  '*modify*',
];

const DEFAULT_DESTRUCTIVE_PATTERNS = ['delete_*', 'remove_*', '*destroy*', '*wipe*'];
const VALID_OVERRIDES = new Set(['read', 'write', 'destructive', 'deny']);

export function classifyTool(toolName, policy = {}, toolArguments = {}) {
  return inspectToolPolicy(toolName, policy, toolArguments).category;
}

export function inspectToolPolicy(toolName, policy = {}, toolArguments = {}) {
  const overrides = policy.overrides || {};
  const profileResult = inspectProfileTool(policy.toolProfile, toolName, toolArguments);
  const directOverride = VALID_OVERRIDES.has(overrides[toolName]) ? overrides[toolName] : null;
  const targetOverride = profileResult?.targetToolName
    && VALID_OVERRIDES.has(overrides[profileResult.targetToolName])
    ? overrides[profileResult.targetToolName]
    : null;
  const override = directOverride || targetOverride;

  const destructivePatterns = policy.destructivePatterns || DEFAULT_DESTRUCTIVE_PATTERNS;
  const writePatterns = policy.writePatterns || DEFAULT_WRITE_PATTERNS;
  const readPatterns = policy.readPatterns || DEFAULT_READ_PATTERNS;
  const matches = [
    ['destructive', destructivePatterns],
    ['write', writePatterns],
    ['read', readPatterns],
  ];
  let regexCategory = 'unknown';
  let matchedPattern = null;

  for (const [category, patterns] of matches) {
    matchedPattern = patterns.find((pattern) => matchGlob(pattern, toolName)) || null;
    if (matchedPattern) {
      regexCategory = category;
      break;
    }
  }

  return {
    category: override || profileResult?.category || regexCategory,
    automaticCategory: profileResult?.category || regexCategory,
    automaticSource: profileResult ? `profile:${policy.toolProfile}` : 'regex',
    profileCategory: profileResult?.category || null,
    profileRule: profileResult?.rule || null,
    targetToolName: profileResult?.targetToolName || toolName,
    regexCategory,
    matchedPattern,
    override,
  };
}

export function isAllowed({ role, toolName, upstream, confirm = false, arguments: toolArguments = {} }) {
  const policy = upstream?.policy || {};
  const category = classifyTool(toolName, policy, toolArguments);

  if (category === 'deny') {
    return {
      allowed: false,
      category,
      requiresConfirmation: false,
      reason: 'Tool is explicitly denied by policy override.',
    };
  }

  if (role === 'chat') {
    if (policy.chatFullAccess) {
      return {
        allowed: true,
        category,
        requiresConfirmation: false,
        reason: 'Chat role has explicit full upstream access enabled for this upstream.',
      };
    }

    const defaultForChat = policy.defaultForChat || 'deny';
    const allowed = category === 'read' || (category === 'unknown' && defaultForChat === 'allow');
    return {
      allowed,
      category,
      requiresConfirmation: false,
      reason: allowed ? 'Chat role may call read-classified tools.' : `Chat role cannot call ${category}-classified tools.`,
    };
  }

  if (role === 'codex') {
    const defaultForCodex = policy.defaultForCodex || 'allow';
    if (category === 'unknown' && defaultForCodex === 'deny') {
      return {
        allowed: false,
        category,
        requiresConfirmation: false,
        reason: 'Codex role denied because tool classification is unknown and defaultForCodex is deny.',
      };
    }

    const requiresCategories = policy.codexRequiresConfirmationCategories || ['destructive'];
    const requiresConfirmation = requiresCategories.includes(category);
    if (requiresConfirmation && !confirm) {
      return {
        allowed: false,
        category,
        requiresConfirmation: true,
        reason: `Tool category ${category} requires confirm: true for Codex.`,
      };
    }

    return {
      allowed: true,
      category,
      requiresConfirmation,
      reason: 'Codex role may call this upstream tool under current policy.',
    };
  }

  if (role === 'admin') {
    return { allowed: true, category, requiresConfirmation: false, reason: 'Admin role allowed.' };
  }

  return { allowed: false, category, requiresConfirmation: false, reason: `Unknown role: ${role}` };
}

export function filterToolsForRole(role, tools, upstream) {
  return tools.filter((tool) => isAllowed({ role, toolName: tool.name, upstream }).allowed);
}
