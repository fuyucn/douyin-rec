/**
 * dragReorder.ts — 列表拖拽排序 hook(原生 HTML5 DnD,零依赖)。
 *
 * 用法:
 *   const dnd = useDragReorder({ items, keyOf, onCommit });
 *   {dnd.ordered.map((item) => <div {...dnd.itemProps(keyOf(item))}>…)}
 *
 * - 拖拽中本地即时重排(order state),drop 后 onCommit(keys) 持久化;
 *   onCommit resolve 后清空本地顺序,由外部刷新回来的权威顺序接管(避免轮询中途闪回)。
 * - disabled(只读场景)或列表只有一项时不启动拖拽;拖拽期间新增的项自动尾插。
 */
import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";

export interface UseDragReorderOpts<T> {
  items: T[];
  keyOf: (item: T) => string;
  /** 持久化新顺序(调用方应同步刷新外部列表)。抛错由调用方处理(如 toast + 重新拉取)。 */
  onCommit: (keys: string[]) => Promise<void> | void;
  disabled?: boolean;
}

export interface DragItemDomProps {
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}

export interface DragReorder<T> {
  /** 实际渲染顺序(拖拽中为本地顺序,否则与 items 一致)。 */
  ordered: T[];
  /** 正在拖拽的 key(null = 未拖拽),供行样式高亮。 */
  dragKey: string | null;
  /** 拖拽悬停目标 key,供插入指示样式。 */
  overKey: string | null;
  itemProps: (key: string) => DragItemDomProps;
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

export function useDragReorder<T>(opts: UseDragReorderOpts<T>): DragReorder<T> {
  const { items, keyOf, onCommit, disabled } = opts;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  /** 拖拽期间的本地顺序(keys);null = 跟随外部 items。 */
  const [order, setOrder] = useState<string[] | null>(null);
  const [committing, setCommitting] = useState(false);

  const baseKeys = items.map(keyOf);
  const baseSignature = baseKeys.join("\u0000");

  // 外部数据回显(顺序已一致)且不在拖拽中 → 丢弃本地顺序。
  useEffect(() => {
    setOrder((prev) => (dragKey === null && prev && prev.join("\u0000") === baseSignature ? null : prev));
  }, [baseSignature, dragKey]);

  const ordered = useMemo(() => {
    if (!order) return items;
    const byKey = new Map(items.map((it) => [keyOf(it), it]));
    const next: T[] = [];
    for (const k of order) {
      const it = byKey.get(k);
      if (it) {
        next.push(it);
        byKey.delete(k);
      }
    }
    for (const it of byKey.values()) next.push(it); // 拖拽期间新增的项尾插
    return next;
    // keyOf 由调用方内联定义(每次渲染新引用),故不进 deps:重排只由 items/order 驱动。
  }, [items, order]);

  const move = (from: string, to: string): void => {
    setOrder((prev) => {
      const cur = prev ?? baseKeys;
      const fromIdx = cur.indexOf(from);
      const toIdx = cur.indexOf(to);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return cur;
      const next = [...cur];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      return next;
    });
  };

  const finish = async (): Promise<void> => {
    const keys = order;
    setDragKey(null);
    setOverKey(null);
    if (!keys || sameOrder(keys, baseKeys) || committing) {
      setOrder(null);
      return;
    }
    setCommitting(true);
    try {
      await onCommit(keys);
    } finally {
      setCommitting(false);
      setOrder(null);
    }
  };

  const itemProps = (key: string): DragItemDomProps => ({
    draggable: !disabled && items.length > 1,
    onDragStart: (e) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
      setDragKey(key);
      setOrder(baseKeys);
    },
    onDragOver: (e) => {
      if (dragKey === null) return;
      e.preventDefault(); // 允许 drop
      e.dataTransfer.dropEffect = "move";
      if (key !== dragKey) {
        setOverKey(key);
        move(dragKey, key);
      }
    },
    onDrop: (e) => {
      e.preventDefault();
      void finish();
    },
    onDragEnd: () => void finish(),
  });

  return { ordered, dragKey, overKey, itemProps };
}
