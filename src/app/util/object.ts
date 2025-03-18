export type UnknownObject = Record<PropertyKey, unknown>;

export const keys = <T extends object>(value: T): (keyof T)[] => {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value) as (keyof T)[];
};

export function entries<T extends object>(value: T): [keyof T, T[keyof T]][] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value) as [keyof T, T[keyof T]][];
}
