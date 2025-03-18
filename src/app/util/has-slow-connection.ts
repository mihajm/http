export function hasSlowConnection() {
  if (
    'connection' in window.navigator &&
    typeof window.navigator.connection === 'object' &&
    !!window.navigator.connection &&
    'effectiveType' in window.navigator.connection &&
    typeof window.navigator.connection.effectiveType === 'string'
  )
    return window.navigator.connection.effectiveType.endsWith('2g');

  return false;
}
