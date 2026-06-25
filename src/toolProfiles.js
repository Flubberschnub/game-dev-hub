export const ANKLEBREAKER_UNITY_PROFILE = 'anklebreaker-unity';

const READ_ACTIONS = new Set([
  'available',
  'capture',
  'find',
  'get',
  'hierarchy',
  'history',
  'info',
  'inspect',
  'list',
  'log',
  'overview',
  'ping',
  'query',
  'read',
  'referenceable',
  'screenshot',
  'search',
  'state',
  'stats',
  'status',
]);

const DESTRUCTIVE_ACTIONS = new Set(['delete', 'destroy', 'remove', 'uninstall', 'wipe']);

const HIGH_RISK_TOOLS = new Set([
  'unity_execute_code',
  'unity_execute_menu_item',
]);

const ANKLEBREAKER_SIGNATURE = [
  'unity_list_instances',
  'unity_list_advanced_tools',
  'unity_advanced_tool',
  'unity_get_project_context',
];

export function detectToolProfile(tools = []) {
  const names = new Set(tools.map((tool) => tool.name));
  return ANKLEBREAKER_SIGNATURE.every((name) => names.has(name))
    ? ANKLEBREAKER_UNITY_PROFILE
    : null;
}

export function inspectProfileTool(profile, toolName, toolArguments = {}) {
  if (profile !== ANKLEBREAKER_UNITY_PROFILE || !toolName.startsWith('unity_')) return null;

  if (toolName === 'unity_advanced_tool') {
    const nestedTool = toolArguments?.tool;
    if (nestedTool && nestedTool !== toolName) {
      const nested = inspectProfileTool(profile, nestedTool, toolArguments?.params || {});
      if (nested) {
        return {
          ...nested,
          rule: `advanced proxy → ${nestedTool}: ${nested.rule}`,
          targetToolName: nestedTool,
        };
      }
    }
    return {
      category: 'write',
      rule: 'advanced proxy; nested tool is classified at call time',
      targetToolName: toolName,
    };
  }

  if (HIGH_RISK_TOOLS.has(toolName)) {
    return {
      category: 'destructive',
      rule: 'documented arbitrary execution surface',
      targetToolName: toolName,
    };
  }

  const tokens = toolName.slice('unity_'.length).split('_');
  const destructiveAction = tokens.find((token) => DESTRUCTIVE_ACTIONS.has(token));
  if (destructiveAction) {
    return {
      category: 'destructive',
      rule: `documented destructive action: ${destructiveAction}`,
      targetToolName: toolName,
    };
  }

  const readAction = tokens.find((token) => READ_ACTIONS.has(token));
  if (readAction) {
    return {
      category: 'read',
      rule: `documented observation action: ${readAction}`,
      targetToolName: toolName,
    };
  }

  return {
    category: 'write',
    rule: 'documented Unity operation; conservative write default',
    targetToolName: toolName,
  };
}
