import { createHash } from 'node:crypto';
import { PART_GEOMETRY_VERSION, validatePartGeometry } from '../../../dialogue-model/runtime/stimuli/part-geometry.ts';
import type { PartGeometry } from '../../../dialogue-model/runtime/stimuli/part-geometry.ts';

export const PART_CATALOG_STORAGE_VERSION = 'part_geometry_storage_v1';
const REFERENCE = '__part_geometry_reference_v1__';
const LITERAL = '__part_geometry_literal_v1__';
type EncodedParts = {
  schemaVersion: typeof PART_CATALOG_STORAGE_VERSION;
  catalog: Record<string, PartGeometry>;
  value: unknown;
};

export class PartCatalogStorageError extends Error {
  readonly code = 'invalid_part_catalog';
  constructor() { super('invalid_part_catalog'); this.name = 'PartCatalogStorageError'; }
}
const fail = (): never => { throw new PartCatalogStorageError(); };
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function digest(value: unknown): string {
  try {
    // Geometry has no such string; distinguish signed zero without changing the stored numbers.
    const json = JSON.stringify(value, (_key, item) => Object.is(item, -0) ? '__part_geometry_negative_zero__' : item);
    return createHash('sha256').update(json).digest('hex');
  } catch { return fail(); }
}
const hasMarker = (value: Record<string, unknown>) => Object.hasOwn(value, REFERENCE) || Object.hasOwn(value, LITERAL);

function checkedGeometry(value: unknown): PartGeometry {
  try { validatePartGeometry(value); }
  catch { return fail(); }
  // Preserve source key order and numbers: memoSha256 uses the original JSON representation.
  return structuredClone(value) as PartGeometry;
}

/** Only the private storage representation changes. Values without parts retain their legacy shape. */
export function encodePartCatalogValue(value: unknown): unknown {
  const catalog: Record<string, PartGeometry> = {};
  const active = new Set<object>();
  const walk = (item: unknown): unknown => {
    if (!Array.isArray(item) && !plain(item)) return item;
    if (active.has(item)) return fail();
    active.add(item);
    try {
      if (plain(item)) {
        if (hasMarker(item)) return { [LITERAL]: structuredClone(item) };
        if (item.version === PART_GEOMETRY_VERSION) {
          const hash = digest(item);
          if (!Object.hasOwn(catalog, hash)) catalog[hash] = checkedGeometry(item);
          return { [REFERENCE]: hash };
        }
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
      }
      return item.map(walk);
    } finally { active.delete(item); }
  };
  const transformed = walk(value);
  return Object.keys(catalog).length ? { schemaVersion: PART_CATALOG_STORAGE_VERSION, catalog, value: transformed } satisfies EncodedParts : value;
}

/** A damaged catalog never becomes a partial memo; callers receive one closed error code. */
export function decodePartCatalogValue(value: unknown): unknown {
  if (!plain(value) || typeof value.schemaVersion !== 'string' || !value.schemaVersion.startsWith('part_geometry_storage_')) return value;
  if (value.schemaVersion !== PART_CATALOG_STORAGE_VERSION || !exact(value, ['schemaVersion', 'catalog', 'value']) ||
      !plain(value.catalog) || !Object.keys(value.catalog).length) return fail();
  const catalog = new Map<string, PartGeometry>();
  for (const [hash, item] of Object.entries(value.catalog)) {
    if (!/^[a-f0-9]{64}$/u.test(hash) || digest(item) !== hash) return fail();
    catalog.set(hash, checkedGeometry(item));
  }
  const used = new Set<string>(), active = new Set<object>();
  const walk = (item: unknown): unknown => {
    if (!Array.isArray(item) && !plain(item)) return item;
    if (active.has(item)) return fail();
    active.add(item);
    try {
      if (plain(item)) {
        if (Object.hasOwn(item, LITERAL)) {
          if (!exact(item, [LITERAL]) || !plain(item[LITERAL]) || !hasMarker(item[LITERAL])) return fail();
          return structuredClone(item[LITERAL]);
        }
        if (Object.hasOwn(item, REFERENCE)) {
          if (!exact(item, [REFERENCE]) || typeof item[REFERENCE] !== 'string') return fail();
          const hash = item[REFERENCE] as string, geometry = catalog.get(hash);
          if (!geometry) return fail();
          used.add(hash); return structuredClone(geometry);
        }
        if (item.version === PART_GEOMETRY_VERSION) return fail();
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
      }
      return item.map(walk);
    } finally { active.delete(item); }
  };
  const restored = walk(value.value);
  if (used.size !== catalog.size) return fail();
  return restored;
}

const wrappers = new WeakMap<object, object>();

/** Retain the storage/transaction API, including overloads and options, at one boundary. */
export function createPartCatalogStorage<T extends object>(storage: T): T {
  const previous = wrappers.get(storage);
  if (previous) return previous as T;
  const methods = new Map<PropertyKey, unknown>();
  const result = new Proxy(storage, {
    get(target, key) {
      const member = Reflect.get(target, key, target);
      if (typeof member !== 'function') return member;
      if (methods.has(key)) return methods.get(key);
      const call = (...args: unknown[]) => Reflect.apply(member, target, args);
      let method: (...args: any[]) => unknown;
      if (key === 'get') method = async (...args) => {
        const value = await call(...args);
        return Array.isArray(args[0]) && value instanceof Map
          ? new Map([...value].map(([id, entry]) => [id, decodePartCatalogValue(entry)])) : decodePartCatalogValue(value);
      };
      else if (key === 'list') method = async (...args) => {
        const values = await call(...args);
        if (!(values instanceof Map)) return fail();
        return new Map([...values].map(([id, entry]) => [id, decodePartCatalogValue(entry)]));
      };
      else if (key === 'put') method = (...args) => {
        if (typeof args[0] === 'string') return call(args[0], encodePartCatalogValue(args[1]), ...args.slice(2));
        if (!plain(args[0])) return fail();
        return call(Object.fromEntries(Object.entries(args[0]).map(([id, entry]) => [id, encodePartCatalogValue(entry)])), ...args.slice(1));
      };
      else if (key === 'transaction') method = (callback, ...args) => {
        if (typeof callback !== 'function') return fail();
        return call((transaction: object) => callback(createPartCatalogStorage(transaction)), ...args);
      };
      else method = call;
      methods.set(key, method);
      return method;
    },
  });
  wrappers.set(storage, result);
  wrappers.set(result, result);
  return result;
}
