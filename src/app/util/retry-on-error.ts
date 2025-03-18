import { HttpResourceRef } from '@angular/common/http';
import { effect, ResourceStatus } from '@angular/core';

export type RetryOptions =
  | number
  | {
      max?: number;
      backoff?: number;
    };

export function retryOnError(res: HttpResourceRef<any>, opt?: RetryOptions) {
  const max = opt ? (typeof opt === 'number' ? opt : opt.max ?? 0) : 0;
  const backoff = typeof opt === 'object' ? opt.backoff ?? 1000 : 1000;

  let retries = 0;

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const onError = () => {
    if (retries >= max) return;
    retries++;

    if (timeout) clearTimeout(timeout);

    setTimeout(
      () => res.reload(),
      retries <= 0 ? 0 : backoff * Math.pow(2, retries - 1)
    );
  };

  const onSuccess = () => {
    if (timeout) clearTimeout(timeout);
    retries = 0;
  };

  return effect(() => {
    switch (res.status()) {
      case ResourceStatus.Error:
        return onError();
      case ResourceStatus.Resolved:
        return onSuccess();
    }
  });
}
