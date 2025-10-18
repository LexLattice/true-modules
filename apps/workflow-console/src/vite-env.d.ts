/// <reference types="vite/client" />

import type { UIEvent } from './types/canon';

declare global {
  interface Window {
    __tmTelemetry?: {
      events: UIEvent[];
      export(): string;
    };
  }
}

export {};
