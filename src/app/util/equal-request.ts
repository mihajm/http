import { HttpResourceRequest } from '@angular/common/http';
import { hash } from './hash';
import { keys } from './object';

function equalTransferCache(
  a: HttpResourceRequest['transferCache'],
  b: HttpResourceRequest['transferCache']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  if (typeof a !== typeof b) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;

  if (!a.includeHeaders && !b.includeHeaders) return true;
  if (!a.includeHeaders || !b.includeHeaders) return false;

  if (a.includeHeaders.length !== b.includeHeaders.length) return false;

  if (a.includeHeaders.length === 0) return true;

  const aSet = new Set(a.includeHeaders ?? []);

  return b.includeHeaders.every((header) => aSet.has(header));
}

function equalParams(
  a: HttpResourceRequest['params'],
  b: HttpResourceRequest['params']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aKeys = keys(a);
  const bKeys = keys(b);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => a[key] === b[key]);
}

function equalBody(
  a: HttpResourceRequest['body'],
  b: HttpResourceRequest['body']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return hash(a) === hash(b);
}

function equalHeaders(
  a: HttpResourceRequest['headers'],
  b: HttpResourceRequest['headers']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  const aKeys = keys(a);
  const bKeys = keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function equalContext(
  a: HttpResourceRequest['context'],
  b: HttpResourceRequest['context']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  const aKeys = keys(a);
  const bKeys = keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export function equalRequest(
  a: HttpResourceRequest | undefined,
  b: HttpResourceRequest | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  if (a.url !== b.url) return false;
  if (a.method !== b.method) return false;
  if (!equalParams(a.params, b.params)) return false;
  if (!equalHeaders(a.headers, b.headers)) return false;
  if (!equalBody(a.body, b.body)) return false;
  if (!equalContext(a.context, b.context)) return false;

  if (a.withCredentials !== b.withCredentials) return false;
  if (a.reportProgress !== b.reportProgress) return false;
  if (!equalTransferCache(a.transferCache, b.transferCache)) return false;

  return false;
}
