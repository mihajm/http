import { computed, effect, Signal, signal, untracked } from '@angular/core';

type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitBreaker = {
  isClosed: Signal<boolean>;
  status: Signal<CircuitBreakerState>;
  fail: () => void;
  success: () => void;
  halfOpen: () => void;
  destroy: () => void;
};

// false allows for opt out of circuit breaker
export type CircuitBreakerOptions =
  | false
  | CircuitBreaker
  | { treshold?: number; timeout?: number };

// allow for top level creation (for example in a service)
function internalCeateCircuitBreaker(
  treshold = 5,
  resetTimeout = 30000
): CircuitBreaker {
  const halfOpen = signal(false);
  const failureCount = signal(0);

  const status = computed<CircuitBreakerState>(() => {
    if (failureCount() >= treshold) return 'CLOSED';
    return halfOpen() ? 'HALF_OPEN' : 'OPEN';
  });

  const isClosed = computed(() => status() === 'CLOSED');

  const success = () => {
    failureCount.set(0);
    halfOpen.set(false);
  };

  const tryOnce = () => {
    if (!untracked(isClosed)) return;
    halfOpen.set(true);
    failureCount.set(treshold - 1);
  };

  const effectRef = effect((cleanup) => {
    if (!isClosed()) return;

    const timeout = setTimeout(tryOnce, resetTimeout);

    return cleanup(() => clearTimeout(timeout));
  });

  const fail = () => {
    failureCount.set(failureCount() + 1);
    halfOpen.set(false);
  };

  return {
    status,
    isClosed,
    fail,
    success,
    halfOpen: tryOnce,
    destroy: () => effectRef.destroy(),
  };
}

function createNeverBrokenCircuitBreaker(): CircuitBreaker {
  return {
    isClosed: computed(() => false),
    status: signal('OPEN'),
    fail: () => {
      // noop
    },
    success: () => {
      // noop
    },
    halfOpen: () => {
      // noop
    },
    destroy: () => {
      // noop
    },
  };
}

export function createCircuitBreaker(
  opt?: CircuitBreakerOptions
): CircuitBreaker {
  if (opt === false) return createNeverBrokenCircuitBreaker();

  if (opt && 'isClosed' in opt) return opt;

  return internalCeateCircuitBreaker(opt?.treshold, opt?.timeout);
}
