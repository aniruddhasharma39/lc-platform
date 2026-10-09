import type { FormField } from '../types/form';

export function removeNode(list: FormField[], id: string): { newList: FormField[], removed: FormField | null } {
  let removed: FormField | null = null;
  const newList = list.filter(f => {
    if (f.id === id) {
      removed = f;
      return false;
    }
    return true;
  }).map(f => {
    if (f.children) {
      const { newList: childrenList, removed: childRemoved } = removeNode(f.children, id);
      if (childRemoved) removed = childRemoved;
      return { ...f, children: childrenList };
    }
    return f;
  });
  return { newList, removed };
}

export function insertBefore(list: FormField[], targetId: string, node: FormField): FormField[] {
  const result: FormField[] = [];
  for (const f of list) {
    if (f.id === targetId) {
      result.push(node);
    }
    if (f.children) {
      result.push({ ...f, children: insertBefore(f.children, targetId, node) });
    } else {
      result.push(f);
    }
  }
  return result;
}

export function appendToSection(list: FormField[], sectionId: string, node: FormField): FormField[] {
  return list.map(f => {
    if (f.id === sectionId && f.type === 'section') {
      return { ...f, children: [...(f.children || []), node] };
    }
    if (f.children) {
      return { ...f, children: appendToSection(f.children, sectionId, node) };
    }
    return f;
  });
}
