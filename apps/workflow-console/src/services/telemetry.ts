import type { UISource, UIEvent } from '../types/canon';
import { createEmitter } from './emitter';

export type TelemetryListener = (event: UIEvent) => void;

export class TelemetryHub {
  private events: UIEvent[] = [];
  private emitter = createEmitter<UIEvent>();

  emit(event: UIEvent): void {
    this.events.push(event);
    this.emitter.emit(event);
  }

  subscribe(listener: TelemetryListener): () => void {
    return this.emitter.subscribe(listener);
  }

  list(): UIEvent[] {
    return [...this.events];
  }

  exportAsNdjson(): string {
    return this.events.map((event) => JSON.stringify(event)).join('\n');
  }

  track(source: UISource, kind: string, payload: unknown): UIEvent {
    const event: UIEvent = {
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(16).slice(2),
      source,
      kind,
      schema: 'tm-events@1',
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit(event);
    return event;
  }

  exposeToWindow(): void {
    if (typeof window === 'undefined') return;
    const thisRef = this;
    const target = window as typeof window & {
      __tmTelemetry?: {
        readonly events: UIEvent[];
        export(): string;
      };
    };
    Object.defineProperty(target, '__tmTelemetry', {
      configurable: true,
      enumerable: false,
      value: {
        get events() {
          return [...thisRef.list()];
        },
        export: () => thisRef.exportAsNdjson(),
      },
    });
  }
}
