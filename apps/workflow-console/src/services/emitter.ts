export type Listener<T> = (payload: T) => void;

export interface Emitter<T> {
  emit(payload: T): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<Listener<T>>();
  return {
    emit(payload: T) {
      for (const listener of Array.from(listeners)) {
        listener(payload);
      }
    },
    subscribe(listener: Listener<T>) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
