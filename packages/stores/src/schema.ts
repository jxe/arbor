import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten";
import type { Diagnostic } from "@arbor/core";

export interface SchemaDescription {
  jsonSchema: Record<string, unknown>;
  columns: string[];
}

interface CompiledSchema {
  context: QuickJSContext;
  runtime: QuickJSRuntime;
  source: string;
  description: SchemaDescription;
}

export class SchemaSandbox implements AsyncDisposable {
  private compiled = new Map<string, CompiledSchema>();

  async compile(path: string): Promise<SchemaDescription> {
    const source = await readFile(path, "utf8");
    const cached = this.compiled.get(path);
    if (cached?.source === source) return cached.description;
    if (/\b(?:node:|bun:|https?:|fs|child_process|process\.|fetch\s*\(|import\s*\()/.test(source.replace(/from\s+["']zod["']/g, ""))) {
      throw new Error("schema.ts may import only zod and cannot use I/O globals");
    }
    const schemaBody = source
      .replace(/import\s*\{\s*z\s*\}\s*from\s*["']zod["'];?/g, "")
      .replace(/export\s+const\s+schema\b/, "const schema")
      .replace(/export\s+type\s+/g, "type ")
      .replace(/export\s*\{[^}]*\};?/g, "");
    if (!/\bconst\s+schema\s*=/.test(schemaBody)) throw new Error("schema.ts must export `const schema = z.object(...)`");
    const entry = [
      `import { z } from "zod";`,
      schemaBody,
      `globalThis.__ARBOR_SCHEMA = JSON.stringify(z.toJSONSchema(schema));`,
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
    const started = performance.now();
    runtime.setInterruptHandler(() => performance.now() - started > 1_000);
    const context = runtime.newContext();
    const evaluated = context.evalCode(bundled, "schema.js");
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
    const description = { jsonSchema, columns: Object.keys((jsonSchema.properties as Record<string, unknown> | undefined) ?? {}) };
    cached?.context.dispose();
    cached?.runtime.dispose();
    this.compiled.set(path, { context, runtime, source, description });
    return description;
  }

  async validate(path: string, value: unknown): Promise<{ value?: unknown; diagnostics: Diagnostic[] }> {
    if (!this.compiled.has(path)) await this.compile(path);
    const compiled = this.compiled.get(path)!;
    const input = JSON.stringify(JSON.stringify(value));
    const result = compiled.context.evalCode(`__ARBOR_VALIDATE(${input})`, "validate.js");
    if (result.error) {
      const error = compiled.context.dump(result.error);
      result.error.dispose();
      return { diagnostics: [{ code: "schema-runtime", message: JSON.stringify(error), path, severity: "error" }] };
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
        path,
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
