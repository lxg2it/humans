import { Ajv, type ErrorObject } from 'ajv';
import type { ToolDefinition } from './anthropic.ts';

/**
 * Turning a caller's JSON Schema into a form a person can fill in.
 *
 * A tool schema is written for a machine that has the whole schema in view while
 * it decides. A person reading it in a browser gets neither. So the schema is
 * read once, here, and used to build either a set of labelled fields or, when it
 * describes something a form cannot honestly represent, a single JSON box.
 *
 * The fallback is the honest default rather than a last resort: a schema with
 * `anyOf` or a nested object has constraints a flat form would silently drop,
 * and a dropped constraint produces a tool call that looks right and is wrong.
 */

export type FieldPlan =
  | {
      kind: 'text';
      name: string;
      label: string;
      required: boolean;
      description: string;
      multiline: boolean;
      maxLength?: number;
      example?: string;
      default?: string;
    }
  | {
      kind: 'enum';
      name: string;
      label: string;
      required: boolean;
      description: string;
      options: Array<{ value: string; label: string }>;
      default?: string;
    }
  | {
      kind: 'boolean';
      name: string;
      label: string;
      required: boolean;
      description: string;
      default?: boolean;
    }
  | {
      kind: 'number';
      name: string;
      label: string;
      required: boolean;
      description: string;
      integer: boolean;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      kind: 'string-list';
      name: string;
      label: string;
      required: boolean;
      description: string;
      itemLabel: string;
      default?: string[];
    };

export interface FormPlan {
  mode: 'fields' | 'raw';
  fields: FieldPlan[];
  /** Why the form was not used, in words the console can show the responder. */
  reason: string | null;
}

/** Keywords that change the meaning of a subschema in a way a flat form cannot carry. */
const UNREPRESENTABLE = [
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
] as const;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelFor(name: string, schema: Record<string, unknown>): string {
  const title = text(schema.title);
  return title.length > 0 ? title : name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function enumValues(schema: Record<string, unknown>): string[] | null {
  const values = schema.enum;
  if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string')) {
    return values;
  }
  // `const` is an enum of one, and responders see it as a fixed choice.
  if (typeof schema.const === 'string') return [schema.const];
  return null;
}

/**
 * Plans one property. Returns a field, or a string explaining why this property
 * cannot be a field, which promotes the whole tool to the raw-JSON path.
 */
function planProperty(
  name: string,
  schema: Record<string, unknown>,
  required: boolean,
): FieldPlan | string {
  for (const keyword of UNREPRESENTABLE) {
    if (keyword in schema) return `"${name}" uses ${keyword}`;
  }

  const type = schema.type;
  const description = text(schema.description);
  const base = { name, label: labelFor(name, schema), required, description };

  const options = enumValues(schema);
  if (options) {
    return {
      ...base,
      kind: 'enum',
      options: options.map((value) => ({ value, label: value })),
      default: typeof schema.default === 'string' && options.includes(schema.default) ? schema.default : undefined,
    };
  }

  if (type === 'boolean') {
    return { ...base, kind: 'boolean', default: typeof schema.default === 'boolean' ? schema.default : undefined };
  }

  if (type === 'number' || type === 'integer') {
    return {
      ...base,
      kind: 'number',
      integer: type === 'integer',
      minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined,
      default: typeof schema.default === 'number' ? schema.default : undefined,
    };
  }

  if (type === 'array') {
    const items = asRecord(schema.items);
    if (!items) return `"${name}" is an array without an item schema`;
    if (items.type !== 'string' && enumValues(items) === null) {
      return `"${name}" is an array of ${text(items.type) || 'untyped'} values`;
    }
    const itemOptions = enumValues(items);
    if (itemOptions) {
      // A list of fixed choices is still a list of strings; the responder adds
      // them one at a time, which keeps the schema's shape visible.
      return {
        ...base,
        kind: 'string-list',
        itemLabel: itemOptions.join(' | '),
        default: Array.isArray(schema.default) ? schema.default.filter((v): v is string => typeof v === 'string') : undefined,
      };
    }
    return {
      ...base,
      kind: 'string-list',
      itemLabel: text(items.description) || 'one value per line',
      default: Array.isArray(schema.default) ? schema.default.filter((v): v is string => typeof v === 'string') : undefined,
    };
  }

  if (type === 'string' || type === undefined) {
    if (type === undefined) {
      // Untyped with no enum: a form cannot know what to offer, so the honest
      // answer is the JSON box rather than a text field that guesses.
      return `"${name}" declares no type`;
    }
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
    const long = (maxLength !== undefined && maxLength > 120) || /multiline|long|body|text|content/i.test(name);
    const examples = Array.isArray(schema.examples) ? schema.examples.find((v) => typeof v === 'string') : schema.example;
    return {
      ...base,
      kind: 'text',
      multiline: long,
      maxLength,
      example: typeof examples === 'string' ? examples : undefined,
      default: typeof schema.default === 'string' ? schema.default : undefined,
    };
  }

  if (type === 'object' || type === 'null') return `"${name}" is a nested ${type}`;
  return `"${name}" has unsupported type "${text(type)}"`;
}

/** Builds the responder-facing plan for one tool. */
export function planForm(tool: ToolDefinition): FormPlan {
  const schema = asRecord(tool.input_schema) ?? {};
  const fail = (reason: string): FormPlan => ({ mode: 'raw', fields: [], reason });

  for (const keyword of UNREPRESENTABLE) {
    if (keyword in schema) return fail(`the schema uses ${keyword}, which a form cannot express`);
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    return fail(`the schema describes a ${text(schema.type)} rather than an object`);
  }

  const properties = asRecord(schema.properties) ?? {};
  const additional = schema.additionalProperties;
  if (Object.keys(properties).length === 0) {
    if (additional === undefined || additional === false) {
      // No arguments at all. A form with no fields is exactly right here, and
      // better than a JSON box the responder has to type {} into.
      return { mode: 'fields', fields: [], reason: null };
    }
    return fail('the schema accepts properties the caller has not declared');
  }

  const requiredNames = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : [],
  );

  const fields: FieldPlan[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    if (!property) return fail(`"${name}" is not a schema object`);
    const planned = planProperty(name, property, requiredNames.has(name));
    if (typeof planned === 'string') return fail(planned);
    fields.push(planned);
  }

  return { mode: 'fields', fields, reason: null };
}

// ---- validation -------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  /** False when the schema could not be compiled, so acceptance means nothing. */
  checked: boolean;
}

/**
 * Compiles the caller's schema into a validator.
 *
 * Deliberately lenient in three ways, each for a reason:
 *   - `strict: false`, because caller schemas are full of keywords ajv would
 *     rather we declared, and refusing to compile them would disable the check
 *     for the tools most likely to need it.
 *   - `validateFormats: false`, because a tool whose schema asks for `email`
 *     is implemented by a person, and refusing a value on the strength of a
 *     format we do not implement would be worse than accepting it.
 *   - `allErrors: true`, so the responder sees every problem at once rather
 *     than one per attempt.
 *
 * Returns null when the schema cannot be compiled. Callers must treat null as
 * "unchecked" rather than "fine" — see ValidationResult.checked.
 */
export function compileValidator(schema: unknown): ((value: unknown) => ValidationResult) | null {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    allowUnionTypes: true,
    coerceTypes: false,
    messages: true,
  });
  try {
    const check = ajv.compile(schema as object);
    return (value: unknown): ValidationResult => {
      const valid = check(value) as boolean;
      return {
        valid,
        checked: true,
        errors: (check.errors ?? []).map((error: ErrorObject) => ({
          path: error.instancePath === '' ? '(root)' : error.instancePath,
          message: error.message ?? 'is invalid',
        })),
      };
    };
  } catch {
    return null;
  }
}

export function validateAgainst(schema: unknown, value: unknown): ValidationResult {
  const validator = compileValidator(schema);
  if (!validator) return { valid: true, errors: [], checked: false };
  return validator(value);
}
