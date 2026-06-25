const TOOL_CATEGORIES = new Set(['read', 'write', 'destructive', 'deny', 'unknown']);

export function effectiveToolCategory(tool) {
  const category = tool?.policy?.override
    || tool?.policy?.automaticCategory
    || tool?.policy?.regexCategory
    || 'unknown';
  return TOOL_CATEGORIES.has(category) ? category : 'unknown';
}

export function filterToolCatalog(tools, filter = 'all') {
  return tools
    .map((tool, index) => ({ tool, index, category: effectiveToolCategory(tool) }))
    .filter((entry) => filter === 'all' || entry.category === filter);
}

export function toolCategoryLabel(category) {
  if (category === 'unknown') return 'Uncategorized';
  if (category === 'deny') return 'Denied';
  return category.charAt(0).toUpperCase() + category.slice(1);
}
