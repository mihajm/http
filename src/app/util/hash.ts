import { UnknownObject } from "./object";

function isPlainObject(value: unknown): value is UnknownObject {
	return (
		typeof value === 'object' && value !== null && value.constructor === Object
	);
}

function hashKey(queryKey: unknown[]): string {
	return JSON.stringify(queryKey, (_, val) =>
		isPlainObject(val)
			? Object.keys(val)
					.toSorted()
					.reduce((result, key) => {
						result[key] = val[key];
						return result;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
					}, {} as any)
			: val
	);
}

export function hash(...args: unknown[]): string {
	return hashKey(args);
}

