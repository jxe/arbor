import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten";
import type { Diagnostic } from "@arbor/core";
import { revisionOf } from "@arbor/core";

export interface SchemaDescription {
  jsonSchema: Record<string, unknown>;
  columns: string[];
  primaryKey: string[] | null;
  revision: string;
}

interface CompiledSchema {
  context: QuickJSContext;
  runtime: QuickJSRuntime;
  source: string;
  description: SchemaDescription;
  deadline: { value: number };
}

export class SchemaSandbox implements AsyncDisposable {
  private compiled = new Map<string, CompiledSchema>();

  async compile(path: string): Promise<SchemaDescription> {
    const source = await readFile(path, "utf8");
    return this.compileSource(source, path);
  }

  async compileSource(source: string, cacheKey = revisionOf(source)): Promise<SchemaDescription> {
    const cached = this.compiled.get(cacheKey);
    if (cached?.source === source) return cached.description;
    if (/\b(?:node:|bun:|https?:|fs|child_process|process\.|fetch\s*\(|import\s*\()/.test(source.replace(/from\s+["']zod["']/g, ""))) {
      throw new Error("schema.ts may import only zod and cannot use I/O globals");
    }
    const schemaBody = source
      .replace(/import\s*\{\s*z\s*\}\s*from\s*["']zod["'];?/g, "")
      .replace(/export\s+const\s+schema\b/, "const schema")
      .replace(/export\s+const\s+primaryKey\b/, "const primaryKey")
      .replace(/export\s+type\s+/g, "type ")
      .replace(/export\s*\{[^}]*\};?/g, "");
    if (!/\bconst\s+schema\s*=/.test(schemaBody)) throw new Error("schema.ts must export `const schema = z.object(...)`");
    const entry = [
      `import { z } from "zod";`,
      schemaBody,
      `globalThis.__ARBOR_SCHEMA = JSON.stringify(z.toJSONSchema(schema));`,
      `globalThis.__ARBOR_PRIMARY_KEY = typeof primaryKey === "undefined" ? "null" : JSON.stringify(primaryKey);`,
      `globalThis.__ARBOR_VALIDATE = (text) => {`,
      `  const result = schema.safeParse(JSON.parse(text));`,
      `  return JSON.stringify(result.success ? { ok: true, value: result.data } : { ok: false, issues: result.error.issues });`,
      `};`,
    ].join("\n");
    const cacheRoot = join(process.cwd(), "node_modules", ".cache");
    await mkdir(cacheRoot, { recursive: true });
    const temporary = await mkdtemp(join(cacheRoot, "arbor-schema-"));
    const entryPath = join(temporary, "entry.ts");
    await writeFile(entryPath, entry);
    const build = await Bun.build({ entrypoints: [entryPath], format: "iife", target: "browser", minify: false });
    await rm(temporary, { recursive: true, force: true });
    if (!build.success || !build.outputs[0]) throw new Error(build.logs.map(String).join("\n") || "Schema build failed");
    const bundled = await build.outputs[0].text();
    const quickJS = await getQuickJS();
    const runtime = quickJS.newRuntime();
    runtime.setMemoryLimit(32 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = { value: performance.now() + 1_000 };
    runtime.setInterruptHandler(() => performance.now() > deadline.value);
    const context = runtime.newContext();
    const evaluated = context.evalCode(bundled, "schema.js");
    deadline.value = Number.POSITIVE_INFINITY;
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      context.dispose();
      runtime.dispose();
      throw new Error(`Schema evaluation failed: ${JSON.stringify(error)}`);
    }
    evaluated.value.dispose();
    const handle = context.getProp(context.global, "__ARBOR_SCHEMA");
    const serialized = context.dump(handle) as string;
    handle.dispose();
    const jsonSchema = JSON.parse(serialized) as Record<string, unknown>;
    const primaryKeyHandle = context.getProp(context.global, "__ARBOR_PRIMARY_KEY");
    const primaryKeySerialized = context.dump(primaryKeyHandle) as string;
    primaryKeyHandle.dispose();
    const declaredPrimaryKey = JSON.parse(primaryKeySerialized) as unknown;
    const columns = Object.keys((jsonSchema.properties as Record<string, unknown> | undefined) ?? {});
    const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
    if (declaredPrimaryKey !== null && (
      !Array.isArray(declaredPrimaryKey)
      || declaredPrimaryKey.length === 0
      || declaredPrimaryKey.some((field) => typeof field !== "string" || !columns.includes(field) || !required.has(field))
      || new Set(declaredPrimaryKey).size !== declaredPrimaryKey.length
    )) {
      context.dispose();
      runtime.dispose();
      throw new Error("primaryKey must name unique required schema properties");
    }
    const description = {
      jsonSchema,
      columns,
      primaryKey: declaredPrimaryKey as string[] | null,
      revision: revisionOf(source),
    };
    cached?.context.dispose();
    cached?.runtime.dispose();
    this.compiled.set(cacheKey, { context, runtime, source, description, deadline });
    return description;
  }

  async validate(path: string, value: unknown): Promise<{ value?: unknown; diagnostics: Diagnostic[] }> {
    if (!this.compiled.has(path)) await this.compile(path);
    return this.validateCompiled(path, value, path);
  }

  async validateSource(
    source: string,
    value: unknown,
    cacheKey = revisionOf(source),
  ): Promise<{ value?: unknown; diagnostics: Diagnostic[] }> {
    if (!this.compiled.has(cacheKey)) await this.compileSource(source, cacheKey);
    return this.validateCompiled(cacheKey, value, "schema.ts");
  }

  private validateCompiled(
    cacheKey: string,
    value: unknown,
    diagnosticPath: string,
  ): { value?: unknown; diagnostics: Diagnostic[] } {
    const compiled = this.compiled.get(cacheKey)!;
    const input = JSON.stringify(JSON.stringify(value));
    compiled.deadline.value = performance.now() + 1_000;
    const result = compiled.context.evalCode(`__ARBOR_VALIDATE(${input})`, "validate.js");
    compiled.deadline.value = Number.POSITIVE_INFINITY;
    if (result.error) {
      const error = compiled.context.dump(result.error);
      result.error.dispose();
      return { diagnostics: [{ code: "schema-runtime", message: JSON.stringify(error), path: diagnosticPath, severity: "error" }] };
    }
    const payload = JSON.parse(compiled.context.dump(result.value) as string) as {
      ok: boolean;
      value?: unknown;
      issues?: Array<{ message: string; path: Array<string | number> }>;
    };
    result.value.dispose();
    if (payload.ok) return { value: payload.value, diagnostics: [] };
    return {
      diagnostics: (payload.issues ?? []).map((issue) => ({
        code: "schema-validation",
        message: issue.message,
        path: diagnosticPath,
        field: issue.path.join("."),
        severity: "error",
      })),
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const value of this.compiled.values()) {
      value.context.dispose();
      value.runtime.dispose();
    }
    this.compiled.clear();
  }
}
