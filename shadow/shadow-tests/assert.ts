export class AssertionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AssertionError";
  }
}

export function assertEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      `${msg ?? "assertEqual failed"}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

export function assertNotEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual === expected) {
    throw new AssertionError(
      `${msg ?? "assertNotEqual failed"}\n  both: ${JSON.stringify(actual)}`
    );
  }
}

export function assertIncludes(haystack: string, needle: string, msg?: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${msg ?? "assertIncludes failed"}\n  needle: ${JSON.stringify(needle)}\n  haystack: ${JSON.stringify(haystack.slice(0, 500))}`
    );
  }
}

export function assertNotIncludes(haystack: string, needle: string, msg?: string): void {
  if (haystack.includes(needle)) {
    throw new AssertionError(
      `${msg ?? "assertNotIncludes failed"}\n  needle: ${JSON.stringify(needle)}\n  found in: ${JSON.stringify(haystack.slice(0, 500))}`
    );
  }
}

export function assertFileExists(filePath: string, msg?: string): void {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) {
    throw new AssertionError(msg ?? `File does not exist: ${filePath}`);
  }
}

export function assertFileAbsent(filePath: string, msg?: string): void {
  const fs = require("fs");
  if (fs.existsSync(filePath)) {
    throw new AssertionError(msg ?? `File should not exist: ${filePath}`);
  }
}

export function assertFileContent(filePath: string, expected: string, msg?: string): void {
  const fs = require("fs");
  assertFileExists(filePath, msg);
  const actual = fs.readFileSync(filePath, "utf8");
  if (actual !== expected) {
    throw new AssertionError(
      `${msg ?? "assertFileContent failed"}\n  file: ${filePath}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

export function assertExitCode(result: { status: number | null }, expected: number, msg?: string): void {
  if (result.status !== expected) {
    throw new AssertionError(
      `${msg ?? "assertExitCode failed"}\n  expected exit code: ${expected}\n  actual: ${result.status}`
    );
  }
}
