export function flattenTree<T extends { id: number; name: string; parent_id: number | null }>(
  items: T[],
  excludeId?: number,
): Array<{ item: T; depth: number }> {
  const childrenOf = new Map<number | null, T[]>();
  for (const item of items) {
    if (item.id === excludeId) continue;
    const key = item.parent_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(item);
  }
  const hasChildren = (id: number) => (childrenOf.get(id)?.length ?? 0) > 0;
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const aFirst = hasChildren(a.id) ? 0 : 1;
      const bFirst = hasChildren(b.id) ? 0 : 1;
      return aFirst !== bFirst ? aFirst - bFirst : a.name.localeCompare(b.name, 'ru');
    });
  }
  const result: Array<{ item: T; depth: number }> = [];
  const visit = (parentId: number | null, depth: number) => {
    for (const item of childrenOf.get(parentId) ?? []) {
      result.push({ item, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}
