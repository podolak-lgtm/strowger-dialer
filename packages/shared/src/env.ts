import { z } from "zod";

/** Reads one env var set, throwing a readable error listing what is missing. */
export function readEnv<T extends z.ZodRawShape>(shape: T, source: NodeJS.ProcessEnv = process.env): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Environment is not configured:\n  ${missing}`);
  }
  return parsed.data;
}
